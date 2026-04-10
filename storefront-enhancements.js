(function () {
  const DEFAULT_STOREFRONT_FEATURES = {
    wishlist_enabled: true,
    back_in_stock_enabled: true,
    sticky_atc_enabled: true,
    review_photos_enabled: true,
    recently_viewed_enabled: true,
    recently_viewed_title: 'Recently Viewed',
    back_in_stock_label: 'Need your size?',
    back_in_stock_success: "We'll email you when it's back.",
    reassurance_enabled: true,
    reassurance_title: 'Why it feels easy',
    reassurance_line_1: 'Free shipping on orders over $100',
    reassurance_line_2: 'Easy returns within 30 days',
    reassurance_line_3: 'Fit guidance backed by customer reviews',
    size_recommendation_enabled: true,
    size_recommendation_title: 'Fit Insight',
  };

  const RECENTLY_VIEWED_KEY = 'zw_recently_viewed';
  const PHOTO_TOKEN_REGEX = /\[\[photo:(.*?)\]\]/i;

  window.DEFAULT_STOREFRONT_FEATURES = DEFAULT_STOREFRONT_FEATURES;

  function safeParseJSON(value, fallback) {
    try {
      return JSON.parse(value);
    } catch (_) {
      return fallback;
    }
  }

  function getStorefrontFeatures() {
    return { ...DEFAULT_STOREFRONT_FEATURES, ...(window.zwStorefrontFeatures || {}) };
  }

  function isProductPage() {
    return !!document.getElementById('productContainer');
  }

  function isHomePage() {
    return !!document.getElementById('products-grid');
  }

  function showToastSafe(message) {
    if (!message) return;
    if (typeof showToast === 'function') {
      showToast(message);
      return;
    }
    try {
      window.alert(message);
    } catch (_) {}
  }

  function openAuthSafe(mode) {
    if (typeof openAuth === 'function') {
      openAuth(mode || 'signin');
      return;
    }
    if (typeof openAuthModal === 'function') {
      openAuthModal(mode || 'signin');
      return;
    }
    window.location.href = mode === 'signup' ? 'index.html?auth=signup' : 'index.html?auth=signin';
  }

  async function getActiveUser() {
    if (typeof currentUser !== 'undefined' && currentUser) return currentUser;
    if (typeof _user !== 'undefined' && _user) return _user;
    if (window.sb && window.sb.auth && typeof window.sb.auth.getUser === 'function') {
      try {
        const { data } = await window.sb.auth.getUser();
        return data && data.user ? data.user : null;
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  function parseReviewBody(body) {
    const raw = typeof body === 'string' ? body : '';
    const match = raw.match(PHOTO_TOKEN_REGEX);
    const photoUrl = match && match[1] ? match[1].trim() : '';
    const cleaned = raw
      .replace(PHOTO_TOKEN_REGEX, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { body: cleaned, photoUrl };
  }

  function composeReviewBody(body, photoUrl) {
    const cleanedBody = typeof body === 'string' ? body.trim() : '';
    const cleanedPhoto = typeof photoUrl === 'string' ? photoUrl.trim() : '';
    if (!cleanedPhoto) return cleanedBody;
    return `${cleanedBody}${cleanedBody ? '\n\n' : ''}[[photo:${cleanedPhoto}]]`;
  }

  function normalizeReviewRecord(review) {
    if (!review || review.__zwNormalizedReview) return review;
    const parsed = parseReviewBody(review.body || '');
    review.body = parsed.body;
    if (!review.photo_url && parsed.photoUrl) review.photo_url = parsed.photoUrl;
    review.__zwNormalizedReview = true;
    return review;
  }

  function normalizeReviewCollection(reviews) {
    if (!Array.isArray(reviews)) return reviews;
    reviews.forEach(normalizeReviewRecord);
    return reviews;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getReviewPhotoPreviewNodes() {
    return {
      field: document.getElementById('review-photo-field'),
      file: document.getElementById('reviewPhotoFile'),
      url: document.getElementById('reviewPhotoUrl'),
      preview: document.getElementById('review-photo-preview'),
    };
  }

  function clearReviewPhotoPreview() {
    const { preview } = getReviewPhotoPreviewNodes();
    if (!preview) return;
    preview.hidden = true;
    preview.innerHTML = '';
    preview.removeAttribute('data-photo-url');
    preview.removeAttribute('data-object-url');
  }

  function setReviewPhotoPreview(url) {
    const { preview } = getReviewPhotoPreviewNodes();
    if (!preview) return;
    const safeUrl = typeof url === 'string' ? url.trim() : '';
    if (!safeUrl) {
      clearReviewPhotoPreview();
      return;
    }
    const oldObjectUrl = preview.getAttribute('data-object-url');
    if (oldObjectUrl && oldObjectUrl.startsWith('blob:')) {
      try { URL.revokeObjectURL(oldObjectUrl); } catch (_) {}
      preview.removeAttribute('data-object-url');
    }
    preview.hidden = false;
    preview.setAttribute('data-photo-url', safeUrl);
    preview.innerHTML = `
      <img src="${safeUrl}" alt="Review photo preview">
      <button type="button" id="review-photo-remove-btn">Remove Photo</button>
    `;
    const removeBtn = document.getElementById('review-photo-remove-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        const { file, url: input } = getReviewPhotoPreviewNodes();
        if (file) file.value = '';
        if (input) input.value = '';
        clearReviewPhotoPreview();
      }, { once: true });
    }
  }

  function resetReviewPhotoField() {
    const features = getStorefrontFeatures();
    const { field, file, url } = getReviewPhotoPreviewNodes();
    if (field) field.hidden = features.review_photos_enabled === false;
    if (file) file.value = '';
    if (url) url.value = '';
    clearReviewPhotoPreview();
  }

  function getReviewPhotoInputValue() {
    const { url, preview } = getReviewPhotoPreviewNodes();
    if (url && url.value.trim()) return url.value.trim();
    return preview ? preview.getAttribute('data-photo-url') || '' : '';
  }

  async function uploadReviewPhoto(user) {
    const features = getStorefrontFeatures();
    if (features.review_photos_enabled === false) return '';

    const { file, url } = getReviewPhotoPreviewNodes();
    if (url && url.value.trim()) return url.value.trim();
    if (!file || !file.files || !file.files[0]) return '';
    if (!window.sb || !window.sb.storage) {
      throw new Error('Photo uploads are unavailable right now.');
    }

    const selectedFile = file.files[0];
    const extMatch = selectedFile.name.match(/\.([a-zA-Z0-9]+)$/);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
    const safeName = (selectedFile.name || 'review')
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'review';
    const uploadPath = `review-uploads/${user.id}/${Date.now()}-${safeName}.${ext}`;

    const uploadResult = await window.sb.storage
      .from('product-images')
      .upload(uploadPath, selectedFile, { cacheControl: '3600', upsert: false });
    if (uploadResult.error) throw uploadResult.error;

    const publicResult = window.sb.storage.from('product-images').getPublicUrl(uploadPath);
    return publicResult && publicResult.data ? publicResult.data.publicUrl : '';
  }

  function attachReviewPhotoInputHandlers() {
    const { file, url } = getReviewPhotoPreviewNodes();
    if (!file || file.__zwBound) return;

    file.addEventListener('change', () => {
      if (!file.files || !file.files[0]) {
        clearReviewPhotoPreview();
        return;
      }
      const objectUrl = URL.createObjectURL(file.files[0]);
      setReviewPhotoPreview(objectUrl);
      const { preview } = getReviewPhotoPreviewNodes();
      if (preview) preview.setAttribute('data-object-url', objectUrl);
      if (url) url.value = '';
    });

    if (url) {
      const updateFromUrl = () => {
        const value = url.value.trim();
        if (!value) {
          const { file: photoFile } = getReviewPhotoPreviewNodes();
          if (!photoFile || !photoFile.files || !photoFile.files.length) clearReviewPhotoPreview();
          return;
        }
        setReviewPhotoPreview(value);
      };
      url.addEventListener('change', updateFromUrl);
      url.addEventListener('blur', updateFromUrl);
    }

    file.__zwBound = true;
  }

  function getRecentlyViewedEntries() {
    return safeParseJSON(localStorage.getItem(RECENTLY_VIEWED_KEY) || '[]', [])
      .filter((entry) => entry && entry.id);
  }

  function setRecentlyViewedEntries(entries) {
    localStorage.setItem(RECENTLY_VIEWED_KEY, JSON.stringify(entries.slice(0, 6)));
  }

  function trackRecentlyViewedProduct(product) {
    if (!product || !product.id) return;
    const next = getRecentlyViewedEntries().filter((entry) => entry.id !== product.id);
    next.unshift({
      id: product.id,
      viewed_at: Date.now(),
    });
    setRecentlyViewedEntries(next);
    if (typeof window.renderRecentlyViewedProducts === 'function') {
      window.renderRecentlyViewedProducts(window.__zwHomeProducts || safeParseJSON(sessionStorage.getItem('zw_home_products') || '[]', []));
    }
  }

  function renderRecentlyViewedProducts(products) {
    const section = document.getElementById('recently-viewed-section');
    const grid = document.getElementById('recently-viewed-grid');
    const title = document.getElementById('recently-viewed-title');
    if (!section || !grid) return;

    const features = getStorefrontFeatures();
    if (features.recently_viewed_enabled === false) {
      section.hidden = true;
      grid.innerHTML = '';
      return;
    }

    const recentEntries = getRecentlyViewedEntries();
    if (!Array.isArray(products) || !products.length || !recentEntries.length) {
      section.hidden = true;
      grid.innerHTML = '';
      return;
    }

    const productMap = new Map(products.map((product) => [product.id, product]));
    const recentProducts = recentEntries
      .map((entry) => productMap.get(entry.id))
      .filter(Boolean)
      .slice(0, 4);

    if (!recentProducts.length) {
      section.hidden = true;
      grid.innerHTML = '';
      return;
    }

    section.hidden = false;
    if (title) title.textContent = features.recently_viewed_title || DEFAULT_STOREFRONT_FEATURES.recently_viewed_title;

    if (typeof renderProductCards === 'function') {
      renderProductCards(recentProducts, grid, { expandSingleImages: false });
    }
    updateWishlistVisibility();
  }

  function updateWishlistVisibility() {
    const enabled = getStorefrontFeatures().wishlist_enabled !== false;
    document.querySelectorAll('.heart-btn').forEach((button) => {
      button.style.display = enabled ? '' : 'none';
    });

    const accountFavTab = document.querySelector('[data-acctab="favorites"]');
    if (accountFavTab) accountFavTab.style.display = enabled ? '' : 'none';

    const accountFavPanel = document.getElementById('acct-panel-favorites');
    if (accountFavPanel) accountFavPanel.style.display = enabled ? '' : 'none';

    document.querySelectorAll('.cart-favorites').forEach((section) => {
      section.style.display = enabled ? '' : 'none';
    });

    const saveRow = document.getElementById('productActionsRow');
    if (saveRow) saveRow.hidden = !enabled;
  }

  function getCurrentStockForSize(size) {
    if (typeof currentProduct === 'undefined' || !currentProduct || !Array.isArray(currentProduct.inventory)) return null;
    const sizeRow = currentProduct.inventory.find((row) => String(row.size || '').toUpperCase() === String(size || '').toUpperCase());
    if (!sizeRow) return null;
    const stockValue = Number(sizeRow.stock_quantity);
    return Number.isFinite(stockValue) ? stockValue : 0;
  }

  function renderSizeRecommendation() {
    const container = document.getElementById('sizeRecommendation');
    if (!container || typeof currentProduct === 'undefined' || !currentProduct) return;

    const features = getStorefrontFeatures();
    if (features.size_recommendation_enabled === false) {
      container.hidden = true;
      container.innerHTML = '';
      return;
    }

    const reviews = normalizeReviewCollection(currentProduct.reviews || []).filter((review) => review && review.fit_rating);
    if (!reviews.length) {
      container.hidden = true;
      container.innerHTML = '';
      return;
    }

    const averageFit = reviews.reduce((sum, review) => sum + Number(review.fit_rating || 0), 0) / reviews.length;
    let message = 'Fits true to size for most customers.';
    if (averageFit <= 2.4) message = 'Runs a little small. Consider sizing up.';
    else if (averageFit >= 3.6) message = 'Runs a little big. Consider sizing down.';

    container.hidden = false;
    container.innerHTML = `
      <p class="size-recommendation-kicker">${escapeHtml(features.size_recommendation_title || DEFAULT_STOREFRONT_FEATURES.size_recommendation_title)}</p>
      <p class="size-recommendation-copy">${escapeHtml(message)} <span>Based on ${reviews.length} fit review${reviews.length !== 1 ? 's' : ''}.</span></p>
    `;
  }

  function buildDynamicReassuranceLines(features) {
    const shipping = window.zwShippingPolicy || {};
    const line1 = (features.reassurance_line_1 || '').trim();
    const line2 = (features.reassurance_line_2 || '').trim();
    const line3 = (features.reassurance_line_3 || '').trim();

    const resolved1 = line1 === DEFAULT_STOREFRONT_FEATURES.reassurance_line_1
      ? `Free shipping on orders over $${shipping.free_threshold || 100}`
      : line1;
    const resolved2 = line2 === DEFAULT_STOREFRONT_FEATURES.reassurance_line_2
      ? `${shipping.return_days_member || 30}-day returns for members`
      : line2;
    const resolved3 = line3 || DEFAULT_STOREFRONT_FEATURES.reassurance_line_3;

    return [resolved1, resolved2, resolved3].filter(Boolean);
  }

  function renderReassuranceBlock() {
    const block = document.getElementById('reassuranceBlock');
    const title = document.getElementById('reassuranceTitle');
    const list = document.getElementById('reassuranceList');
    if (!block || !title || !list) return;

    const features = getStorefrontFeatures();
    if (features.reassurance_enabled === false) {
      block.hidden = true;
      list.innerHTML = '';
      return;
    }

    title.textContent = features.reassurance_title || DEFAULT_STOREFRONT_FEATURES.reassurance_title;
    list.innerHTML = buildDynamicReassuranceLines(features)
      .map((line) => `<li>${escapeHtml(line)}</li>`)
      .join('');
    block.hidden = !list.children.length;
  }

  async function syncBackInStockPanel() {
    const panel = document.getElementById('backInStockPanel');
    const title = document.getElementById('backInStockTitle');
    const message = document.getElementById('backInStockMessage');
    const hint = document.getElementById('backInStockHint');
    const emailInput = document.getElementById('backInStockEmail');
    if (!panel || !title || !message || !hint) return;

    const features = getStorefrontFeatures();
    const stock = typeof selectedSize !== 'undefined' ? getCurrentStockForSize(selectedSize) : null;
    const shouldShow = features.back_in_stock_enabled !== false && !!selectedSize && stock === 0;

    if (!shouldShow) {
      panel.hidden = true;
      hint.textContent = '';
      return;
    }

    panel.hidden = false;
    title.textContent = features.back_in_stock_label || DEFAULT_STOREFRONT_FEATURES.back_in_stock_label;
    const colorName = typeof selectedColor !== 'undefined' && selectedColor && selectedColor.color_name
      ? selectedColor.color_name
      : 'this color';
    message.textContent = `Get an email when size ${selectedSize} in ${colorName} is back.`;

    if (emailInput && !emailInput.value) {
      const user = await getActiveUser();
      if (user && user.email) emailInput.value = user.email;
    }
  }

  async function submitBackInStockRequest() {
    const emailInput = document.getElementById('backInStockEmail');
    const button = document.getElementById('backInStockBtn');
    const hint = document.getElementById('backInStockHint');
    if (!emailInput || !button || !hint) return;

    if (typeof currentProduct === 'undefined' || !currentProduct || !selectedSize) {
      hint.textContent = 'Choose a sold-out size first.';
      return;
    }

    const email = emailInput.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      hint.textContent = 'Enter a valid email address.';
      return;
    }

    if (!window.sb || typeof window.sb.from !== 'function') {
      hint.textContent = 'Back-in-stock alerts are unavailable right now.';
      return;
    }

    const colorCode = typeof selectedColorSku !== 'undefined' && selectedColorSku
      ? selectedColorSku
      : ((typeof selectedColor !== 'undefined' && selectedColor && selectedColor.color_name) ? selectedColor.color_name : 'default');

    button.disabled = true;
    button.textContent = 'Saving...';
    hint.textContent = '';

    try {
      const source = `back_in_stock|${currentProduct.id}|${selectedSize}|${colorCode}`;
      const result = await window.sb.from('waitlist').upsert({ email, source });
      if (result.error) throw result.error;

      const successMessage = getStorefrontFeatures().back_in_stock_success || DEFAULT_STOREFRONT_FEATURES.back_in_stock_success;
      hint.textContent = successMessage;
      showToastSafe(successMessage);
    } catch (error) {
      hint.textContent = error && error.message ? error.message : 'Could not save this alert right now.';
    } finally {
      button.disabled = false;
      button.textContent = 'Notify Me';
    }
  }

  function syncStickyBuyBar() {
    const bar = document.getElementById('stickyBuyBar');
    const name = document.getElementById('stickyBuyName');
    const price = document.getElementById('stickyBuyPrice');
    const stickyButton = document.getElementById('stickyBuyBtn');
    const mainButton = document.getElementById('addToCartBtn');
    if (!bar || !name || !price || !stickyButton) return;

    const features = getStorefrontFeatures();
    const mobileViewport = window.innerWidth <= 768;
    const ready = typeof currentProduct !== 'undefined' && currentProduct && mainButton;
    if (!mobileViewport || features.sticky_atc_enabled === false || !ready) {
      bar.hidden = true;
      bar.classList.remove('is-visible');
      return;
    }

    name.textContent = currentProduct.title || 'Zuwera';
    const numericPrice = Number(currentProduct.current_price || currentProduct.price || 0);
    price.textContent = numericPrice ? `$${numericPrice.toFixed(2)}` : 'Price TBA';
    stickyButton.textContent = (mainButton.textContent || 'Add to Bag').trim();
    stickyButton.disabled = !!mainButton.disabled;

    const rect = mainButton.getBoundingClientRect();
    const shouldShow = rect.bottom < 0;
    bar.hidden = false;
    bar.classList.toggle('is-visible', shouldShow);
  }

  function handleStickyBuyAction() {
    const sizeSection = document.querySelector('.size-section');
    if (typeof selectedSize === 'undefined' || !selectedSize) {
      if (sizeSection) sizeSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
      showToastSafe('Choose a size first.');
      return;
    }
    if (typeof addToCart === 'function') addToCart();
    syncStickyBuyBar();
  }

  async function refreshProductSaveButton() {
    const row = document.getElementById('productActionsRow');
    const button = document.getElementById('saveForLaterBtn');
    if (!row || !button) return;

    const enabled = getStorefrontFeatures().wishlist_enabled !== false;
    row.hidden = !enabled;
    if (!enabled) return;

    if (typeof currentProduct === 'undefined' || !currentProduct || !window.sb || typeof window.sb.from !== 'function') {
      button.classList.remove('is-saved');
      button.textContent = 'Save for Later';
      return;
    }

    const user = await getActiveUser();
    if (!user) {
      button.classList.remove('is-saved');
      button.textContent = 'Save for Later';
      return;
    }

    try {
      const result = await window.sb
        .from('favorites')
        .select('product_id')
        .eq('user_id', user.id)
        .eq('product_id', currentProduct.id)
        .maybeSingle();
      const isSaved = !!(result && result.data);
      button.classList.toggle('is-saved', isSaved);
      button.textContent = isSaved ? 'Saved' : 'Save for Later';
    } catch (_) {
      button.classList.remove('is-saved');
      button.textContent = 'Save for Later';
    }
  }

  async function toggleProductSaveForLater() {
    const button = document.getElementById('saveForLaterBtn');
    if (!button) return;
    if (getStorefrontFeatures().wishlist_enabled === false) return;

    const user = await getActiveUser();
    if (!user) {
      openAuthSafe('signin');
      return;
    }
    if (typeof currentProduct === 'undefined' || !currentProduct || !window.sb || typeof window.sb.from !== 'function') return;

    try {
      const lookup = await window.sb
        .from('favorites')
        .select('product_id')
        .eq('user_id', user.id)
        .eq('product_id', currentProduct.id)
        .maybeSingle();
      const isSaved = !!(lookup && lookup.data);

      if (isSaved) {
        const removeResult = await window.sb
          .from('favorites')
          .delete()
          .eq('user_id', user.id)
          .eq('product_id', currentProduct.id);
        if (removeResult.error) throw removeResult.error;
        button.classList.remove('is-saved');
        button.textContent = 'Save for Later';
        showToastSafe('Removed from saved items.');
      } else {
        const insertResult = await window.sb.from('favorites').upsert({
          user_id: user.id,
          product_id: currentProduct.id,
          product_name: currentProduct.title,
          price: currentProduct.current_price || currentProduct.price || null,
        });
        if (insertResult.error) throw insertResult.error;
        button.classList.add('is-saved');
        button.textContent = 'Saved';
        showToastSafe('Saved for later.');
      }
    } catch (error) {
      showToastSafe(error && error.message ? error.message : 'Could not update saved items.');
    }
  }

  function appendReviewPhotoNodes(listEl, reviews) {
    if (!listEl || !Array.isArray(reviews)) return;
    const cards = Array.from(listEl.querySelectorAll('.review-modal-card'));
    cards.forEach((card, index) => {
      const review = normalizeReviewRecord(reviews[index]);
      const existing = card.querySelector('.review-card-photo');
      if (existing) existing.remove();
      if (!review || !review.photo_url) return;
      const photo = document.createElement('div');
      photo.className = 'review-card-photo';
      photo.innerHTML = `<img src="${review.photo_url}" alt="Customer review photo" loading="lazy">`;
      card.appendChild(photo);
    });
  }

  function appendInlineProductReviewPhotos() {
    if (!isProductPage() || typeof currentProduct === 'undefined' || !currentProduct) return;
    const content = document.getElementById('reviewsContent');
    if (!content) return;
    const items = Array.from(content.querySelectorAll('.review-item'));
    const reviews = normalizeReviewCollection((currentProduct.reviews || []).slice(0, 3));
    items.forEach((item, index) => {
      const review = reviews[index];
      const existing = item.querySelector('.review-photo-inline');
      if (existing) existing.remove();
      if (!review || !review.photo_url) return;
      const photo = document.createElement('div');
      photo.className = 'review-photo-inline';
      photo.innerHTML = `<img src="${review.photo_url}" alt="Customer review photo" loading="lazy">`;
      item.appendChild(photo);
    });
  }

  function patchReviewFlows() {
    if (typeof loadReviews === 'function' && !loadReviews.__zwPhotoPatched) {
      const originalLoadReviews = loadReviews;
      loadReviews = async function patchedLoadReviews(pid) {
        const reviews = await originalLoadReviews(pid);
        normalizeReviewCollection(reviews);
        if (typeof currentProduct !== 'undefined' && currentProduct && currentProduct.id === pid) {
          normalizeReviewCollection(currentProduct.reviews);
        }
        return reviews;
      };
      loadReviews.__zwPhotoPatched = true;
    }

    if (typeof openReviewForm === 'function' && !openReviewForm.__zwPhotoPatched) {
      const originalOpenReviewForm = openReviewForm;
      openReviewForm = function patchedOpenReviewForm(pid, pname) {
        const result = originalOpenReviewForm(pid, pname);
        resetReviewPhotoField();
        return result;
      };
      openReviewForm.__zwPhotoPatched = true;
      window.openReviewForm = openReviewForm;
    }

    if (typeof openEditReviewForm === 'function' && !openEditReviewForm.__zwPhotoPatched) {
      const originalOpenEditReviewForm = openEditReviewForm;
      openEditReviewForm = function patchedOpenEditReviewForm(id, rating, body) {
        const result = originalOpenEditReviewForm(id, rating, body);
        const reviews = (typeof _reviewCache !== 'undefined' && _reviewCache[_reviewProductId]) || (typeof currentProduct !== 'undefined' ? currentProduct.reviews : []);
        const review = Array.isArray(reviews) ? reviews.find((item) => item.id === id) : null;
        resetReviewPhotoField();
        if (review) {
          normalizeReviewRecord(review);
          if (review.photo_url) {
            const { url } = getReviewPhotoPreviewNodes();
            if (url) url.value = review.photo_url;
            setReviewPhotoPreview(review.photo_url);
          }
        }
        return result;
      };
      openEditReviewForm.__zwPhotoPatched = true;
      window.openEditReviewForm = openEditReviewForm;
    }

    if (typeof submitReview === 'function' && !submitReview.__zwPhotoPatched) {
      submitReview = async function patchedSubmitReview() {
        const errEl = document.getElementById('review-error');
        const btn = document.getElementById('review-submit-btn');
        const bodyInput = document.getElementById('review-body-input');
        const body = bodyInput ? bodyInput.value.trim() : '';
        const isAdvancedChecked = !!document.getElementById('rateFitToggle')?.checked;
        const fit = isAdvancedChecked ? document.getElementById('reviewFit')?.value : null;
        const comfort = isAdvancedChecked ? document.getElementById('reviewComfort')?.value : null;
        const recommend = isAdvancedChecked ? document.querySelector('input[name="reviewRecommend"]:checked')?.value : null;
        if (errEl) errEl.textContent = '';

        if (!_reviewRating) {
          if (errEl) errEl.textContent = 'Please select a star rating.';
          return;
        }
        if (!_reviewProductId) {
          if (errEl) errEl.textContent = 'No product selected.';
          return;
        }

        const user = await getActiveUser();
        if (!user) {
          if (errEl) errEl.textContent = 'Please sign in to leave a review.';
          return;
        }

        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Submitting...';
        }

        try {
          const reviewerName = user.user_metadata?.full_name || user.email?.split('@')[0] || 'Anonymous';
          const uploadedPhotoUrl = await uploadReviewPhoto(user);
          const finalBody = composeReviewBody(body, uploadedPhotoUrl || getReviewPhotoInputValue());

          let result;
          if (_reviewIdToEdit) {
            result = await window.sb.from('reviews').update({
              rating: _reviewRating,
              body: finalBody || null,
              fit_rating: fit ? parseInt(fit, 10) : null,
              comfort_rating: comfort ? parseInt(comfort, 10) : null,
              recommend: recommend === 'yes' ? true : (recommend === 'no' ? false : null),
            }).eq('id', _reviewIdToEdit);
          } else {
            result = await window.sb.from('reviews').insert({
              user_id: user.id,
              product_id: _reviewProductId,
              rating: _reviewRating,
              body: finalBody || null,
              reviewer_name: reviewerName,
              fit_rating: fit ? parseInt(fit, 10) : null,
              comfort_rating: comfort ? parseInt(comfort, 10) : null,
              recommend: recommend === 'yes' ? true : (recommend === 'no' ? false : null),
            });
          }

          if (result.error) throw result.error;

          _reviewIdToEdit = null;
          if (typeof _reviewCache !== 'undefined') delete _reviewCache[_reviewProductId];

          const reviewModal = document.getElementById('review-modal');
          if (reviewModal) reviewModal.classList.remove('open');
          document.body.style.overflow = '';
          showToastSafe('Review submitted - thank you!');

          const reviews = typeof loadReviews === 'function' ? await loadReviews(_reviewProductId) : [];
          document.querySelectorAll(`[id^="avg-${_reviewProductId}"]`).forEach((element) => {
            const domId = element.id.replace('avg-', '');
            if (typeof updateProductStarDisplay === 'function') updateProductStarDisplay(domId, reviews);
          });

          if (typeof renderReviews === 'function') renderReviews();
          const allModal = document.getElementById('all-reviews-modal');
          if (allModal && allModal.classList.contains('open') && typeof window.openAllReviewsModal === 'function') {
            await window.openAllReviewsModal(_reviewProductId, _reviewProductId, window._domIdToPname?.[_reviewProductId]);
          }
        } catch (error) {
          if (errEl) errEl.textContent = error && error.message ? error.message : 'Could not submit review. Please try again.';
        } finally {
          if (btn) {
            btn.disabled = false;
            btn.textContent = _reviewIdToEdit ? 'Update Review' : 'Submit Review';
          }
        }
      };
      submitReview.__zwPhotoPatched = true;
      window.submitReview = submitReview;
    }

    if (typeof window.openAllReviewsModal === 'function' && !window.openAllReviewsModal.__zwPhotoPatched) {
      const originalOpenAllReviewsModal = window.openAllReviewsModal;
      window.openAllReviewsModal = async function patchedOpenAllReviewsModal(pid, domId, productName) {
        await originalOpenAllReviewsModal(pid, domId, productName);
        const list = document.getElementById('all-reviews-list');
        const reviews = typeof _reviewCache !== 'undefined' ? normalizeReviewCollection(_reviewCache[pid] || []) : [];
        appendReviewPhotoNodes(list, reviews);
      };
      window.openAllReviewsModal.__zwPhotoPatched = true;
    }

    if (typeof renderReviews === 'function' && !renderReviews.__zwPhotoPatched) {
      const originalRenderReviews = renderReviews;
      renderReviews = function patchedRenderReviews() {
        if (typeof currentProduct !== 'undefined' && currentProduct) normalizeReviewCollection(currentProduct.reviews);
        const result = originalRenderReviews();
        appendInlineProductReviewPhotos();
        renderSizeRecommendation();
        return result;
      };
      renderReviews.__zwPhotoPatched = true;
      window.renderReviews = renderReviews;
    }
  }

  function patchProductPageFunctions() {
    if (!isProductPage()) return;

    if (typeof renderProduct === 'function' && !renderProduct.__zwStorefrontPatched) {
      const originalRenderProduct = renderProduct;
      renderProduct = function patchedRenderProduct() {
        if (typeof currentProduct !== 'undefined' && currentProduct) normalizeReviewCollection(currentProduct.reviews);
        const result = originalRenderProduct.apply(this, arguments);
        if (typeof currentProduct !== 'undefined' && currentProduct) trackRecentlyViewedProduct(currentProduct);
        renderReassuranceBlock();
        renderSizeRecommendation();
        syncBackInStockPanel();
        syncStickyBuyBar();
        refreshProductSaveButton();
        updateWishlistVisibility();
        return result;
      };
      renderProduct.__zwStorefrontPatched = true;
      window.renderProduct = renderProduct;
    }

    if (typeof updateStockInfo === 'function' && !updateStockInfo.__zwStorefrontPatched) {
      const originalUpdateStockInfo = updateStockInfo;
      updateStockInfo = function patchedUpdateStockInfo() {
        const result = originalUpdateStockInfo.apply(this, arguments);
        syncBackInStockPanel();
        syncStickyBuyBar();
        return result;
      };
      updateStockInfo.__zwStorefrontPatched = true;
      window.updateStockInfo = updateStockInfo;
    }

    const colorSwatches = document.getElementById('colorSwatches');
    if (colorSwatches && !colorSwatches.__zwStorefrontBound) {
      colorSwatches.addEventListener('click', () => {
        window.setTimeout(() => {
          syncBackInStockPanel();
          syncStickyBuyBar();
        }, 0);
      });
      colorSwatches.__zwStorefrontBound = true;
    }

    if (!window.__zwStickyBound) {
      window.addEventListener('scroll', syncStickyBuyBar, { passive: true });
      window.addEventListener('resize', syncStickyBuyBar);
      window.__zwStickyBound = true;
    }

    if (window.sb && window.sb.auth && !window.__zwStorefrontAuthBound) {
      window.sb.auth.onAuthStateChange(() => {
        refreshProductSaveButton();
        syncBackInStockPanel();
      });
      window.__zwStorefrontAuthBound = true;
    }
  }

  function applyStorefrontFeatures() {
    window.zwStorefrontFeatures = getStorefrontFeatures();
    attachReviewPhotoInputHandlers();
    updateWishlistVisibility();
    renderRecentlyViewedProducts(window.__zwHomeProducts || safeParseJSON(sessionStorage.getItem('zw_home_products') || '[]', []));
    resetReviewPhotoField();

    if (isProductPage()) {
      renderReassuranceBlock();
      renderSizeRecommendation();
      syncBackInStockPanel();
      syncStickyBuyBar();
      refreshProductSaveButton();
    }
  }

  window.renderRecentlyViewedProducts = renderRecentlyViewedProducts;
  window.applyStorefrontFeatures = applyStorefrontFeatures;
  window.submitBackInStockRequest = submitBackInStockRequest;
  window.handleStickyBuyAction = handleStickyBuyAction;
  window.toggleProductSaveForLater = toggleProductSaveForLater;
  window.zwParseReviewBody = parseReviewBody;
  window.zwNormalizeReviewRecord = normalizeReviewRecord;

  const initializeStorefrontEnhancements = () => {
    patchReviewFlows();
    patchProductPageFunctions();
    applyStorefrontFeatures();
  };

  initializeStorefrontEnhancements();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeStorefrontEnhancements, { once: true });
  }
})();
