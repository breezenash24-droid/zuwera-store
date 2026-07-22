// quick-add-modal.js
// The Quick-Add product modal — SINGLE SOURCE OF TRUTH, shared by:
//   • index.html  (loaded before storefront.js; the grid wiring there calls
//     window.quickAddToCart — the old in-file copy was removed)
//   • bag.html    (saved-items "Add to Bag")
// Injects its own markup when the page doesn't carry #quick-add-review-modal
// statically (index.html does; bag.html doesn't).
//
// Exposes: window.quickAddToCart(productId, title, price, sku, image, weightLb, btn)
//          window.openQuickAddReviewModal(item)
// Depends (all optional, guarded): window.renderCart, window.loadCartCount,
//          window.showToast, window.animateAddToBag, window.ZWModalScrollLock,
//          window.gtag.
(function () {
  'use strict';

  // If a page already provides the modal (storefront.js), don't double-define.
  if (typeof window.quickAddToCart === 'function') return;

  var SUPABASE_URL = window.SUPABASE_URL || window.SUPA_URL || 'https://qfgnrsifcwdubkolsgsq.supabase.co';
  var SUPABASE_ANON = window.SUPABASE_ANON || window.SUPA_ANON || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';

  function toast(msg) { if (typeof window.showToast === 'function') window.showToast(msg); }
  function refreshCart() { if (typeof window.renderCart === 'function') window.renderCart(); }

  function qaSlug(name) {
    // Matches storefront.js productSlug: the brand prefix is dropped from URLs.
    return String(name || 'product').replace(/^zuwera\s+/i, '').toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'product';
  }
  function qaProductHref(item) {
    return '/product/' + qaSlug(item.title) + '?id=' + encodeURIComponent(item.productId);
  }

  // ── Modal markup: inject once if the page doesn't already include it ──
  var MODAL_HTML =
    '<div id="quick-add-review-modal" class="modal quick-add-review-modal" role="dialog" aria-modal="true" aria-labelledby="quick-add-review-title" aria-hidden="true">' +
      '<div class="mbox quick-add-review-box quick-add-product-box">' +
        '<button class="mclose" id="quick-add-review-close" aria-label="Close">&#215;</button>' +
        '<div class="quick-add-product-layout">' +
          '<div class="quick-add-product-gallery">' +
            '<div class="quick-add-review-media" id="quick-add-review-media"><span class="quick-add-review-placeholder">Image Coming Soon</span></div>' +
            '<div class="quick-add-thumbs" id="quick-add-review-thumbs" aria-label="Product images"></div>' +
          '</div>' +
          '<div class="quick-add-review-body quick-add-product-body">' +
            '<h2 class="quick-add-review-title" id="quick-add-review-title">Product</h2>' +
            '<div class="quick-add-product-meta"><span id="quick-add-review-price">$0.00</span><span id="quick-add-review-sku">-</span></div>' +
            '<div class="quick-add-option-block"><div class="quick-add-option-head"><span>Color</span><strong id="quick-add-review-color">Standard</strong></div><div class="quick-add-option-grid quick-add-colors" id="quick-add-review-colors"></div></div>' +
            '<div class="quick-add-option-block"><div class="quick-add-option-head"><span>Size</span><strong id="quick-add-review-size">Choose size</strong></div><div class="quick-add-option-grid quick-add-sizes" id="quick-add-review-sizes"></div></div>' +
            '<p class="quick-add-review-message" id="quick-add-review-message">Choose your options.</p>' +
            '<div class="quick-add-review-actions">' +
              '<button type="button" class="quick-add-review-confirm" id="quick-add-review-confirm">Add to Bag</button>' +
              '<button type="button" id="quick-add-review-cancel">Leave</button>' +
              '<a href="" id="quick-add-review-view">Full Product Page</a>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  // Back-in-stock capture markup — also injected into a STATIC modal (e.g. the
  // homepage pre-renders #quick-add-review-modal in index.html) that predates it.
  // Styled to match the product page's #restock-panel exactly (pink-tinted box,
  // --white/--black button so the label reads on any theme).
  var RESTOCK_HINT_HTML = '<p class="quick-add-size-hint" id="quick-add-size-hint" style="display:none;font-family:var(--fm);font-size:.62rem;letter-spacing:.08em;opacity:.7;margin:.5rem 0 0">Tap a sold-out size to get notified when it\'s back.</p>';
  var RESTOCK_PANEL_HTML = '<div class="quick-add-restock" id="quick-add-restock" style="display:none;margin-top:.9rem;padding:.95rem 1rem;border:1px solid rgba(248,145,165,.3);background:rgba(248,145,165,.05)">' +
      '<p id="quick-add-restock-label" style="font-family:var(--fm);font-size:.62rem;letter-spacing:.12em;text-transform:uppercase;margin-bottom:.6rem;opacity:.85"></p>' +
      '<div style="display:flex;gap:.5rem">' +
        '<input type="email" id="quick-add-restock-email" placeholder="you@example.com" autocomplete="email" style="flex:1;min-width:0;background:rgba(244,241,235,.04);border:1px solid rgba(244,241,235,.18);color:inherit;padding:.6rem .75rem;font-family:var(--fb);font-size:max(16px,.85rem);outline:none">' +
        '<button type="button" id="quick-add-restock-submit" style="background:#09090b !important;color:#f4f1eb !important;border:none;padding:.6rem 1rem;font-family:var(--fm);font-size:.6rem;letter-spacing:.14em;text-transform:uppercase;font-weight:600;cursor:pointer;white-space:nowrap">Notify Me</button>' +
      '</div>' +
      '<p id="quick-add-restock-msg" style="font-family:var(--fm);font-size:.62rem;margin-top:.5rem;min-height:.9rem;letter-spacing:.04em"></p>' +
    '</div>';

  // Inject the hint + panel if this modal instance doesn't already have them
  // (a statically pre-rendered modal won't).
  function ensureRestockUI(el) {
    if (!el) return;
    var sizesGrid = el.querySelector('#quick-add-review-sizes');
    if (!sizesGrid) return;
    if (!el.querySelector('#quick-add-size-hint')) {
      var h = document.createElement('div'); h.innerHTML = RESTOCK_HINT_HTML;
      if (h.firstChild) sizesGrid.insertAdjacentElement('afterend', h.firstChild);
    }
    if (!el.querySelector('#quick-add-restock')) {
      var block = (sizesGrid.closest && sizesGrid.closest('.quick-add-option-block')) || sizesGrid.parentNode;
      var p = document.createElement('div'); p.innerHTML = RESTOCK_PANEL_HTML;
      if (p.firstChild && block) block.insertAdjacentElement('afterend', p.firstChild);
    }
  }

  // Wire submit (click + Enter) once per element, for both created and static modals.
  function bindRestock(el) {
    var rbtn = el.querySelector('#quick-add-restock-submit');
    if (rbtn && !rbtn._zwBound) { rbtn._zwBound = true; rbtn.addEventListener('click', quickAddSubmitRestock); }
    var remail = el.querySelector('#quick-add-restock-email');
    if (remail && !remail._zwBound) { remail._zwBound = true; remail.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); quickAddSubmitRestock(); } }); }
  }

  function ensureModal() {
    var el = document.getElementById('quick-add-review-modal');
    if (!el) {
      var wrap = document.createElement('div');
      wrap.innerHTML = MODAL_HTML;
      el = wrap.firstChild;
      document.body.appendChild(el);
    }
    ensureRestockUI(el);   // self-heal a static modal that lacks the capture
    bindRestock(el);       // wire the submit handler (runs for the static modal too)
    return el;
  }

  // ── Back-in-stock capture (mirrors the product page) ──────────────────────
  function quickAddOpenRestock(item, size) {
    // Respect the feature flag — permissive: only an explicit false hides it.
    try { var f = window.__zwFlags && window.__zwFlags.feature_back_in_stock; if (f && f.enabled === false) return; } catch (e) {}
    var panel = document.getElementById('quick-add-restock');
    var label = document.getElementById('quick-add-restock-label');
    var email = document.getElementById('quick-add-restock-email');
    var msg = document.getElementById('quick-add-restock-msg');
    if (!panel) return;
    panel.dataset.size = size;
    panel.dataset.productId = item.productId || '';
    panel.dataset.color = (item.selectedColor && item.selectedColor.color_name) || '';
    if (label) label.textContent = 'Size ' + size + " is sold out — get notified when it's back";
    if (msg) { msg.textContent = ''; msg.style.color = ''; }
    if (email && !email.value.trim()) {
      try {
        var u = window.__zwSessionUser;
        if (u && u.email) email.value = u.email;
        else if (window.sb) window.sb.auth.getSession().then(function (r) {
          var e = r && r.data && r.data.session && r.data.session.user && r.data.session.user.email;
          if (e && email && !email.value.trim()) email.value = e;
        }).catch(function () {});
      } catch (e2) {}
    }
    panel.style.display = 'block';
    if (email) { try { email.focus({ preventScroll: true }); } catch (e3) { email.focus(); } }
  }
  function quickAddHideRestock() {
    var panel = document.getElementById('quick-add-restock');
    if (panel) panel.style.display = 'none';
  }
  async function quickAddSubmitRestock() {
    var panel = document.getElementById('quick-add-restock');
    var email = document.getElementById('quick-add-restock-email');
    var msg = document.getElementById('quick-add-restock-msg');
    var btn = document.getElementById('quick-add-restock-submit');
    if (!panel) return;
    var val = ((email && email.value) || '').trim();
    var size = panel.dataset.size;
    var productId = panel.dataset.productId;
    var color = panel.dataset.color || null;
    if (!size || !productId) return;
    if (!val || val.indexOf('@') < 0) { if (msg) { msg.textContent = 'Enter a valid email.'; msg.style.color = 'var(--red,#dc2626)'; } return; }
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    // The homepage loads Supabase lazily — make sure the client exists before inserting.
    if (!window.sb && typeof window.zwEnsureSupabase === 'function') {
      try { await window.zwEnsureSupabase(); } catch (_) {}
    }
    if (!window.sb) {
      if (msg) { msg.textContent = 'Could not connect — please try again.'; msg.style.color = 'var(--red,#dc2626)'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Notify Me'; }
      return;
    }
    try {
      var res = await window.sb.from('restock_requests').insert({ product_id: productId, size: size, color_name: color, email: val });
      if (res.error) {
        if (String(res.error.code) === '23505') { if (msg) { msg.textContent = "You're already on the list for this size."; msg.style.color = ''; } }
        else throw res.error;
      } else if (msg) { msg.textContent = "✓ We'll email you when " + size + ' is back.'; msg.style.color = 'rgba(110,210,130,.95)'; }
    } catch (e) {
      if (msg) { msg.textContent = (e && e.message) || 'Could not save that — try again.'; msg.style.color = 'var(--red,#dc2626)'; }
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Notify Me'; }
  }

  var _quickAddReviewItem = null;

  function shouldBypassQuickAddModal() {
    return window.matchMedia('(max-width: 900px)').matches;
  }
  function quickAddGoToProduct(payload) {
    window.location.assign(qaProductHref({ productId: payload.productId, title: payload.title }));
  }

  var QUICK_ADD_BUTTON_LABEL = 'Add to Bag';
  function setQuickAddButtonLoading(btn, loading) {
    if (!btn) return;
    btn.classList.toggle('loading', Boolean(loading));
    btn.classList.toggle('disabled', Boolean(loading));
    // Preserve markup (homepage pcard buttons wrap the label in a span).
    if (loading) { btn.dataset.qaHtml = btn.innerHTML; btn.innerHTML = '...'; }
    else { btn.innerHTML = btn.dataset.qaHtml || QUICK_ADD_BUTTON_LABEL; }
  }

  function quickAddMoney(value) {
    var amount = parseFloat(value) || 0;
    return amount ? '$' + amount.toFixed(2) : 'Price TBA';
  }
  function quickAddEscapeAttr(value) {
    return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function quickAddIsVideo(src) {
    return /\.(mp4|webm|mov|m4v|ogv)(\?.*)?$/i.test(src || '');
  }

  function quickAddGetImagesForColor(allImageRows, primaryImage, colorVariantId) {
    var all = Array.isArray(allImageRows) ? allImageRows : [];
    var filtered;
    if (!colorVariantId) {
      filtered = all.filter(function (r) { return !r.color_variant_id; });
      if (!filtered.length) filtered = all;
    } else {
      var specific = all.filter(function (r) { return r.color_variant_id === colorVariantId; });
      var shared = all.filter(function (r) { return !r.color_variant_id; });
      filtered = specific.length ? specific.concat(shared) : (shared.length ? shared : all);
    }
    var urls = [];
    filtered.forEach(function (r) { if (r.image_url && urls.indexOf(r.image_url) === -1) urls.push(r.image_url); });
    if (!urls.length && primaryImage) urls.push(primaryImage);
    return urls;
  }

  function quickAddSizeEntries(sizeRows, colorName) {
    var rows = Array.isArray(sizeRows) ? sizeRows : [];
    // Per-colour stock: for each size use the selected colour's rows, falling back to
    // colour-agnostic rows (color_name null) for legacy products; with no colour, use
    // the null rows if present else sum across colours.
    var order = [];
    var sizeMap = {};
    rows.forEach(function (row) {
      if (!row || !row.size) return;
      if (!(row.size in sizeMap)) { sizeMap[row.size] = 0; order.push(row.size); }
    });
    order.forEach(function (size) {
      var forSize = rows.filter(function (r) { return r && r.size === size; });
      var use;
      if (colorName) {
        var _nc = String(colorName).trim().toLowerCase();
        var c = forSize.filter(function (r) { return String(r.color_name || '').trim().toLowerCase() === _nc; });
        var n = forSize.filter(function (r) { return !r.color_name; });
        use = c.length ? c : (n.length ? n : []);
      } else {
        var nn = forSize.filter(function (r) { return !r.color_name; });
        use = nn.length ? nn : forSize;
      }
      sizeMap[size] = use.reduce(function (s, r) { return s + (Number(r.stock_quantity) || 0); }, 0);
    });
    var entries = order.map(function (s) { return [s, sizeMap[s]]; });
    return entries.length ? entries : [['One Size', 1]];
  }

  function quickAddActiveImageIndex(item, images) {
    var current = item.activeImage || item.image || (images && images[0]) || '';
    var index = images.indexOf(current);
    return index >= 0 ? index : 0;
  }
  function quickAddMoveGallery(item, direction) {
    var images = (item.images && item.images.length) ? item.images : (item.image ? [item.image] : []);
    if (!images.length) return;
    var currentIndex = quickAddActiveImageIndex(item, images);
    var nextIndex = (currentIndex + direction + images.length) % images.length;
    item.activeImage = images[nextIndex];
    quickAddRenderGallery(item, { type: 'slide', dir: direction });
  }

  function quickAddSetScrollLock(locked) {
    if (window.ZWModalScrollLock && typeof window.ZWModalScrollLock.refresh === 'function') {
      // Lock SYNCHRONOUSLY (same as the login modal), not via requestAnimationFrame.
      // Deferring by a frame let the modal paint once at the pre-lock viewport width
      // (scrollbar still present); the next frame removed the scrollbar and the whole
      // fixed-coordinate system jumped sideways. A synchronous refresh removes the
      // scrollbar in the same frame the modal opens, so nothing shifts.
      window.ZWModalScrollLock.refresh();
      return;
    }
    if (typeof window.setPageScrollLock === 'function') window.setPageScrollLock(locked);
    else document.body.style.overflow = locked ? 'hidden' : '';
  }
  function quickAddFocusWithoutScroll(element) {
    if (!element || typeof element.focus !== 'function') return;
    var x = window.scrollX || 0, y = window.scrollY || 0;
    try { element.focus({ preventScroll: true }); }
    catch (_) { element.focus(); window.scrollTo(x, y); }
  }

  function quickAddFinalizeReviewedItem(cartItem) {
    var cart; try { cart = JSON.parse(localStorage.getItem('cart') || '[]') || []; } catch (_) { cart = []; }
    var existIdx = cart.findIndex(function (i) {
      return i.productId === cartItem.productId && i.size === cartItem.size && i.colorName === cartItem.colorName;
    });
    if (existIdx > -1) cart[existIdx].quantity += 1;
    else cart.push(cartItem);
    localStorage.setItem('cart', JSON.stringify(cart));
    refreshCart();
    if (typeof window.loadCartCount === 'function') window.loadCartCount();
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'add_to_cart', { currency: 'USD', value: cartItem.price, items: [{ item_id: cartItem.productId, item_name: cartItem.title, price: cartItem.price, quantity: 1 }] });
    }
    if (window.zwPixel) window.zwPixel.addToCart(cartItem);
    if (typeof window.animateAddToBag === 'function') {
      window.animateAddToBag(document.querySelector('#quick-add-review-media img') || document.getElementById('quick-add-review-confirm'), cartItem.image);
    }
    toast('Added to bag');
    window.setTimeout(closeQuickAddReviewModal, 160);
  }

  function closeQuickAddReviewModal() {
    var modal = document.getElementById('quick-add-review-modal');
    if (modal) modal.classList.remove('open');
    _quickAddReviewItem = null;
    quickAddSetScrollLock(false);
  }

  function quickAddRenderGallery(item, anim) {
    var media = document.getElementById('quick-add-review-media');
    var thumbs = document.getElementById('quick-add-review-thumbs');
    var images = (item.images && item.images.length) ? item.images : (item.image ? [item.image] : []);
    var currentIndex = quickAddActiveImageIndex(item, images);
    var current = images[currentIndex] || '';
    item.activeImage = current;
    var hasMultipleImages = images.length > 1;
    if (media) {
      var focalY = (item.imageFocalY != null ? item.imageFocalY : 50);
      var imgStyle = 'style="object-position:50% ' + focalY + '%"';
      var mediaEl = current
        ? (quickAddIsVideo(current)
            ? '<video src="' + quickAddEscapeAttr(current) + '" muted loop playsinline autoplay style="width:100%;height:auto;max-height:100%;object-fit:contain;background:#000" aria-label="' + quickAddEscapeAttr(item.title) + '"></video>'
            : '<img src="' + quickAddEscapeAttr(current) + '" alt="' + quickAddEscapeAttr(item.title) + '" ' + imgStyle + '>')
        : '';
      media.innerHTML = current
        ? (hasMultipleImages ? '<button type="button" class="quick-add-gallery-arrow prev" data-gallery-step="-1" aria-label="Previous product image"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>' : '') + mediaEl + (hasMultipleImages ? '<button type="button" class="quick-add-gallery-arrow next" data-gallery-step="1" aria-label="Next product image"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg></button>' : '')
        : '<span class="quick-add-review-placeholder">Image Coming Soon</span>';
      media.querySelectorAll('[data-gallery-step]').forEach(function (button) {
        button.addEventListener('click', function (event) {
          event.preventDefault(); event.stopPropagation();
          quickAddMoveGallery(item, Number(button.dataset.galleryStep) || 1);
        });
      });
      var touchStartX = 0;
      media.ontouchstart = function (event) { touchStartX = (event.changedTouches && event.changedTouches[0] && event.changedTouches[0].screenX) || 0; };
      media.ontouchend = function (event) {
        if (!hasMultipleImages || !touchStartX) return;
        var touchEndX = (event.changedTouches && event.changedTouches[0] && event.changedTouches[0].screenX) || 0;
        if (touchEndX < touchStartX - 40) quickAddMoveGallery(item, 1);
        if (touchEndX > touchStartX + 40) quickAddMoveGallery(item, -1);
      };
      // Animate the swap to match the product page: directional slide for photo
      // nav, soft fade for colorway switches.
      var animEl = media.querySelector('img, video');
      if (animEl && anim) {
        animEl.classList.remove('zw-img-in', 'zw-slide-next', 'zw-slide-prev');
        void animEl.offsetWidth;
        if (anim.type === 'fade') animEl.classList.add('zw-img-in');
        else animEl.classList.add(anim.dir < 0 ? 'zw-slide-prev' : 'zw-slide-next');
      }
    }
    if (!thumbs) return;
    thumbs.innerHTML = images.map(function (src, idx) {
      var inner = quickAddIsVideo(src)
        ? '<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:#09090b;"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="12" fill="rgba(255,255,255,.15)"/><polygon points="10,8 18,12 10,16" fill="white"/></svg></span>'
        : '<img src="' + quickAddEscapeAttr(src) + '" alt="" loading="lazy">';
      return '<button type="button" class="quick-add-thumb' + (src === current ? ' active' : '') + '" data-img="' + quickAddEscapeAttr(src) + '" aria-label="View product media ' + (idx + 1) + '">' + inner + '</button>';
    }).join('');
    thumbs.querySelectorAll('.quick-add-thumb').forEach(function (button) {
      var activateThumb = function () {
        var imgs = (item.images && item.images.length) ? item.images : (item.image ? [item.image] : []);
        if (item.activeImage === button.dataset.img) return;
        var prevI = quickAddActiveImageIndex(item, imgs);
        item.activeImage = button.dataset.img;
        var newI = imgs.indexOf(button.dataset.img);
        quickAddRenderGallery(item, { type: 'slide', dir: newI < prevI ? -1 : 1 });
      };
      button.addEventListener('click', activateThumb);
      button.addEventListener('mouseenter', activateThumb);
    });
  }

  function quickAddRenderOptions(item) {
    // Per-colour sizes: ensure a colour is chosen, then (re)compute size availability
    // for it. Recomputed each render, so switching colour updates the sold-out states.
    quickAddHideRestock();  // reset the back-in-stock capture on every re-render (colour/size change)
    if (!item.selectedColor && Array.isArray(item.colors) && item.colors.length) item.selectedColor = item.colors[0];
    if (Array.isArray(item.sizeRows)) {
      item.sizes = quickAddSizeEntries(item.sizeRows, (item.selectedColor && item.selectedColor.color_name) || null);
    }
    var colorWrap = document.getElementById('quick-add-review-colors');
    var sizeWrap = document.getElementById('quick-add-review-sizes');
    var message = document.getElementById('quick-add-review-message');
    var confirm = document.getElementById('quick-add-review-confirm');
    var selectedColor = item.selectedColor;
    var selectedSize = item.selectedSize;

    if (colorWrap) {
      var colors = Array.isArray(item.colors) ? item.colors : [];
      colorWrap.innerHTML = colors.length
        ? colors.map(function (color, idx) {
            var name = color.color_name || ('Color ' + (idx + 1));
            var active = (selectedColor && selectedColor.color_name === color.color_name) ? ' active' : '';
            // Product-photo thumbnail per colour (matches the full product page).
            var cimgs = item.allImageRows ? quickAddGetImagesForColor(item.allImageRows, item.image, color.id || null) : [];
            var thumbSrc = '';
            for (var ci = 0; ci < cimgs.length; ci++) { if (!quickAddIsVideo(cimgs[ci])) { thumbSrc = cimgs[ci]; break; } }
            if (!thumbSrc) thumbSrc = cimgs[0] || '';
            var styleAttr = thumbSrc ? "background-image:url('" + quickAddEscapeAttr(thumbSrc) + "')" : 'background:' + quickAddEscapeAttr(color.hex_color || '#888');
            return '<button type="button" class="quick-add-color' + active + (thumbSrc ? ' has-thumb' : '') + '" data-index="' + idx + '" title="' + quickAddEscapeAttr(name) + '" aria-label="' + quickAddEscapeAttr(name) + '" style="' + styleAttr + '"></button>';
          }).join('')
        : '<p class="quick-add-empty-option">Standard colorway</p>';
      colorWrap.querySelectorAll('.quick-add-color').forEach(function (button) {
        button.addEventListener('click', function () {
          var prevIndex = quickAddActiveImageIndex(item, item.images);
          item.selectedColor = colors[Number(button.dataset.index)] || null;
          item.sku = (item.selectedColor && item.selectedColor.variant_sku) || item.baseSku || item.sku || '';
          if (item.allImageRows) {
            item.images = quickAddGetImagesForColor(item.allImageRows, item.image, (item.selectedColor && item.selectedColor.id) || null);
            var clampedIndex = Math.min(prevIndex, Math.max(item.images.length - 1, 0));
            item.activeImage = item.images[clampedIndex] || item.images[0] || '';
            quickAddRenderGallery(item, { type: 'fade' });
          }
          quickAddRenderOptions(item);
        });
      });
    }

    if (sizeWrap) {
      var sizes = Array.isArray(item.sizes) ? item.sizes : [];
      sizeWrap.innerHTML = sizes.map(function (pair) {
        var size = pair[0], stock = pair[1];
        var soldOut = Number(stock) <= 0;
        var active = selectedSize === size ? ' active' : '';
        // Sold-out sizes stay clickable (no `disabled`) so they open the
        // back-in-stock capture instead of being a dead end.
        return '<button type="button" class="quick-add-size' + active + (soldOut ? ' sold-out' : '') + '" data-size="' + quickAddEscapeAttr(size) + '"' + (soldOut ? ' data-soldout="1" aria-label="' + quickAddEscapeAttr(size) + ' sold out — get notified"' : '') + '>' + quickAddEscapeAttr(size) + (soldOut ? ' - Sold Out' : '') + '</button>';
      }).join('') || '<p class="quick-add-empty-option">One Size</p>';
      sizeWrap.querySelectorAll('.quick-add-size').forEach(function (button) {
        button.addEventListener('click', function () {
          if (button.dataset.soldout) { quickAddOpenRestock(item, button.dataset.size || 'One Size'); return; }
          item.selectedSize = button.dataset.size || 'One Size';
          quickAddRenderOptions(item);
        });
      });
      // Nudge shoppers that a sold-out size is tappable for the notify capture.
      var sizeHint = document.getElementById('quick-add-size-hint');
      if (sizeHint) {
        var anySoldOut = sizes.some(function (pair) { return Number(pair[1]) <= 0; });
        var bisOff = false;
        try { var ff = window.__zwFlags && window.__zwFlags.feature_back_in_stock; bisOff = !!(ff && ff.enabled === false); } catch (e) {}
        sizeHint.style.display = (anySoldOut && !bisOff) ? '' : 'none';
      }
    }

    var needsColor = Array.isArray(item.colors) && item.colors.length > 0 && !item.selectedColor;
    var hasAvailableSize = Array.isArray(item.sizes) && item.sizes.some(function (pair) { return Number(pair[1]) > 0; });
    var needsSize = hasAvailableSize && !item.selectedSize;
    if (message) {
      message.textContent = !hasAvailableSize ? 'This item is currently sold out.' : needsColor ? 'Choose a colorway.' : needsSize ? 'Choose a size.' : 'Ready to add to your bag.';
    }
    if (confirm) confirm.disabled = !hasAvailableSize || needsColor || needsSize;

    var colorField = document.getElementById('quick-add-review-color');
    var sizeField = document.getElementById('quick-add-review-size');
    var skuField = document.getElementById('quick-add-review-sku');
    if (colorField) {
      var _selName = (item.selectedColor && item.selectedColor.color_name) || 'Standard';
      var _selHex = (item.selectedColor && item.selectedColor.hex_color) || '';
      colorField.innerHTML = (_selHex ? '<span class="quick-add-color-dot" style="background:' + quickAddEscapeAttr(_selHex) + '"></span>' : '') + quickAddEscapeAttr(_selName);
    }
    if (sizeField) sizeField.textContent = item.selectedSize || 'Choose size';
    if (skuField) skuField.textContent = item.sku || '-';
  }

  function openQuickAddReviewModal(item) {
    if (shouldBypassQuickAddModal()) {
      quickAddGoToProduct({ productId: item.productId, sku: item.baseSku || item.sku, title: item.title });
      return;
    }
    var _qaColors = Array.isArray(item.colors) ? item.colors : [];
    if (!item.selectedColor && _qaColors.length > 0) item.selectedColor = _qaColors[0];
    if (item.selectedColor && item.selectedColor.variant_sku) item.sku = item.selectedColor.variant_sku;
    var inStockSizes = (item.sizes || []).filter(function (pair) { return Number(pair[1]) > 0; });
    if (!item.selectedSize) item.selectedSize = inStockSizes.length === 1 ? inStockSizes[0][0] : null;
    if (item.allImageRows) {
      item.images = quickAddGetImagesForColor(item.allImageRows, item.image, (item.selectedColor && item.selectedColor.id) || null);
    }
    item.activeImage = (item.images && item.images[0]) || item.image || '';
    _quickAddReviewItem = item;

    var modal = ensureModal();
    if (!modal) return;

    var fields = {
      'quick-add-review-title': item.title,
      'quick-add-review-price': quickAddMoney(item.price),
      'quick-add-review-sku': item.sku || '-'
    };
    Object.keys(fields).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = fields[id];
    });

    var view = document.getElementById('quick-add-review-view');
    if (view) view.href = qaProductHref(item);

    quickAddRenderGallery(item);
    quickAddRenderOptions(item);
    modal.classList.add('open');
    modal.style.setProperty('background', 'transparent', 'important');
    modal.style.setProperty('backdrop-filter', 'none', 'important');
    modal.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
    quickAddSetScrollLock(true);
    window.requestAnimationFrame(function () { quickAddFocusWithoutScroll(document.getElementById('quick-add-review-confirm')); });
  }

  async function quickAddToCart(productId, productTitle, productPrice, productSku, productImage, productWeightLb, btn, preselectColorName) {
    // Early-access gate: admin-enabled members-only window (see storefront-theme.js).
    if (typeof window.zwEarlyAccessBlocked === 'function' && window.zwEarlyAccessBlocked()) {
      toast('Early access is for members — sign in to shop first.');
      var openAuthFn = window.zwOpenAuth || window.openAuthModal || window.openAuth || window.__zwOpenAuth;
      if (typeof openAuthFn === 'function') openAuthFn('signin');
      return;
    }
    // Close any open inline quick-size panels (homepage product grid).
    document.querySelectorAll('.quick-size-panel.open').forEach(function (p) { p.classList.remove('open'); });
    setQuickAddButtonLoading(btn, true);

    var modalItem = {
      productId: productId,
      sku: productSku || '',
      baseSku: productSku || '',
      title: productTitle,
      regularPrice: parseFloat(productPrice) || 0,
      memberPrice: null,
      price: parseFloat(productPrice) || 0,
      image: productImage || '',
      images: productImage ? [productImage] : [],
      colors: [],
      sizes: [['One Size', 1]],
      selectedColor: null,
      selectedSize: null,
      weightLb: parseFloat(productWeightLb) || 0.5,
      quantity: 1
    };

    openQuickAddReviewModal(modalItem);

    try {
      var headers = { 'apikey': SUPABASE_ANON, 'Authorization': 'Bearer ' + SUPABASE_ANON };
      var encodedId = encodeURIComponent(productId);
      var results = await Promise.all([
        fetch(SUPABASE_URL + '/rest/v1/color_variants?select=id,color_name,hex_color,variant_sku&product_id=eq.' + encodedId + '&order=sort_order.asc', { headers: headers }),
        // no-store: the mini quick-add modal's per-size stock must reflect an admin
        // stock edit immediately — never a cached "previous" quantity.
        fetch(SUPABASE_URL + '/rest/v1/product_sizes?select=size,stock_quantity,color_name&product_id=eq.' + encodedId + '&order=created_at.asc', { headers: headers, cache: 'no-store' }),
        fetch(SUPABASE_URL + '/rest/v1/product_images?select=image_url,alt_text,sort_order,color_variant_id,media_type&product_id=eq.' + encodedId + '&order=sort_order.asc', { headers: headers })
      ]);
      var colors = results[0].ok ? await results[0].json() : [];
      var sizeRows = results[1].ok ? await results[1].json() : [];
      var imageRows = results[2].ok ? await results[2].json() : [];
      var sizeEntries = quickAddSizeEntries(sizeRows);
      modalItem.allImageRows = Array.isArray(imageRows) ? imageRows : [];
      var images = quickAddGetImagesForColor(modalItem.allImageRows, productImage, null);

      modalItem.image = images[0] || productImage || '';
      modalItem.images = images;
      modalItem.colors = Array.isArray(colors) ? colors : [];
      modalItem.sizeRows = Array.isArray(sizeRows) ? sizeRows : [];
      modalItem.sizes = sizeEntries;
      // Preselect a color when opened from a grid swatch click (openQuickAddReviewModal
      // then recomputes the gallery for it). Falls back to first color if no match.
      modalItem.selectedColor = preselectColorName
        ? (modalItem.colors.find(function (c) { return (c.color_name || '').toLowerCase() === String(preselectColorName).toLowerCase(); }) || null)
        : null;
      modalItem.selectedSize = null;
      if (_quickAddReviewItem === modalItem) openQuickAddReviewModal(modalItem);
    } catch (e) {
      console.error('Quick add failed:', e);
      var message = document.getElementById('quick-add-review-message');
      if (message && _quickAddReviewItem === modalItem) {
        message.textContent = 'Options are still loading. You can add the standard option or open the full product page.';
      }
    } finally {
      setQuickAddButtonLoading(btn, false);
    }
  }

  function initQuickAddReviewModal() {
    var modal = ensureModal();
    if (!modal) return;
    var closeBtn = document.getElementById('quick-add-review-close');
    if (closeBtn) closeBtn.addEventListener('click', closeQuickAddReviewModal);
    var cancelBtn = document.getElementById('quick-add-review-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', closeQuickAddReviewModal);
    var confirmBtn = document.getElementById('quick-add-review-confirm');
    if (confirmBtn) confirmBtn.addEventListener('click', function () {
      if (!_quickAddReviewItem) return;
      var item = _quickAddReviewItem;
      var colorName = (item.selectedColor && item.selectedColor.color_name) || 'Standard';
      var size = item.selectedSize || 'One Size';
      quickAddFinalizeReviewedItem({
        productId: item.productId,
        sku: item.sku || item.baseSku || '',
        title: item.title,
        size: size,
        colorName: colorName,
        colorHex: (item.selectedColor && item.selectedColor.hex_color) || '',
        regularPrice: item.regularPrice,
        memberPrice: item.memberPrice,
        price: item.price,
        image: item.activeImage || item.image || '',
        weightLb: parseFloat(item.weightLb) || 0.5,
        quantity: 1
      });
      closeQuickAddReviewModal();
    });
    modal.addEventListener('click', function (e) { if (e.target === modal) closeQuickAddReviewModal(); });
  }

  window.quickAddToCart = quickAddToCart;
  window.openQuickAddReviewModal = openQuickAddReviewModal;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initQuickAddReviewModal);
  } else {
    initQuickAddReviewModal();
  }
})();
