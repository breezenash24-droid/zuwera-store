/**
 * products.js — Shared product loading for index.html + product.html
 * Queries Supabase 'products' table, fallback to demo data if fails/empty.
 */

const PRODUCTS_SUPABASE_URL = 'https://qfgnrsifcwdubkolsgsq.supabase.co';
const PRODUCTS_SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';

// Reuse existing _sb if available, else init safely without redeclaring const
if (!window._sb && typeof supabase !== 'undefined') {
  window._sb = supabase.createClient(PRODUCTS_SUPABASE_URL, PRODUCTS_SUPABASE_ANON);
}

// Demo fallback products (if Supabase empty/fails)
const FALLBACK_PRODUCTS = [
  {
    id: 'jacket-001',
    title: 'Zuwera Jacket 001',
    subtitle: 'Jackets',
    current_price: 248,
    status: 'coming_soon',
    image_url: 'https://zuwera.store/assets/jacket-001.jpg', // Update with real images
    sort_order: 1
  },
  {
    id: 'jacket-002', 
    title: 'Zuwera Jacket 002',
    subtitle: 'Jackets',
    current_price: 248,
    status: 'coming_soon',
    image_url: 'https://zuwera.store/assets/jacket-002.jpg',
    sort_order: 2
  },
  {
    id: 'jacket-003',
    title: 'Zuwera Jacket 003', 
    subtitle: 'Jackets',
    current_price: 248,
    status: 'coming_soon',
    image_url: 'https://zuwera.store/assets/jacket-003.jpg',
    sort_order: 3
  }
];

/**
 * Load products from Supabase, fallback to demo data.
 * Updates #products-grid in index.html.
 * Returns { data, error } for product.html use.
 */
async function loadProducts(gridSelector = '#products-grid') {
  const grid = document.querySelector(gridSelector);
  if (!grid) {
    console.error('Products grid not found:', gridSelector);
    return { data: [], error: 'Grid not found' };
  }

  // Show loading
  grid.innerHTML = '<div class="pcard" style="opacity:.6;text-align:center;padding:4rem;font-family:var(--fm);font-size:.85rem">🔄 Loading Release 001…</div>';

  try {
    if (!window._sb) throw new Error('Supabase not loaded');

    let { data, error } = await window._sb
      .from('products')
      .select('*, product_images(*)')
      .order('sort_order', { ascending: true });

    if (error) throw error;

    console.log('✅ Loaded', data?.length || 0, 'products from Supabase');

    if (!data || data.length === 0) {
      console.warn('No products in Supabase — using fallback demo');
      data = FALLBACK_PRODUCTS;
    }

    let renderList = data;
    // If only 1 product, show its different images as separate cards
    if (data.length === 1 && data[0].product_images && data[0].product_images.length > 1) {
      const p = data[0];
      let allImages = [...p.product_images].sort((a, b) => a.sort_order - b.sort_order);
      if (p.image_url && !allImages.some(img => img.image_url === p.image_url)) {
        allImages.unshift({ image_url: p.image_url, sort_order: -1 });
      }
      renderList = allImages.map(img => ({
        ...p,
        image_url: img.image_url,
        product_images: [img]
      }));
    }

    renderProducts(grid, renderList);
    return { data: renderList, error: null };

  } catch (error) {
    console.error('❌ Products load failed:', error.message);
    grid.innerHTML = `
      <div class="pcard single-item" style="max-width:480px;margin:0 auto;opacity:.4;text-align:center;padding:4rem">
        <svg style="width:56px;height:56px;margin:0 auto 1rem;opacity:.3" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/></svg>
        <p style="font-family:var(--fm);letter-spacing:.15em;font-size:.82rem">Coming Soon — Launching Sep 20, 2026</p>
        <p style="font-size:.7rem;opacity:.6;margin-top:.5rem">Release 001: 3 Jacket Styles</p>
      </div>
    `;
    return { data: [], error };
  }
}

function renderProducts(grid, products) {
  grid.classList.remove('single-item', 'two-items');
  if (products.length === 1) {
    grid.classList.add('single-item');
  } else if (products.length === 2) {
    grid.classList.add('two-items');
  }

  grid.innerHTML = products.map(p => {
    // Normalize: title from title or name; price; status badge
    const productName = p.title || p.name || 'Untitled Product';
    const productCategory = p.subtitle || p.category || 'Jackets'; 
    const productPrice = p.current_price || p.price || 0;
    const badgeText = p.status?.toLowerCase().includes('soon') ? 'Coming Soon' : (p.status === 'live' ? 'Available' : 'Coming Soon');
    let firstImg = p.image_url;
    if (p.product_images && p.product_images.length > 0) {
      p.product_images.sort((a, b) => a.sort_order - b.sort_order);
      if (p.product_images[0].image_url) firstImg = p.product_images[0].image_url;
    }


    return `
      <div class="pcard" data-product-slug="${(p.slug || productName.toLowerCase().replace(/[^a-z0-9]/g,'-')).slice(0,50)}" onclick="window.location.href='product.html?slug=${encodeURIComponent(productName.toLowerCase().replace(/[^a-z0-9]/g,'-'))}'" style="cursor:pointer">
        <div class="pcard-img" style="background:transparent">
          <img src="${firstImg || ''}" alt="${productName}" loading="lazy" style="width:100%;height:100%;object-fit:cover;object-position:center" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
          <div style="display:none;align-items:center;justify-content:center;flex-direction:column;gap:.8rem;height:100%;opacity:.08">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style="width:48px;height:48px"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
            <p style="font-family:var(--fm);font-size:.58rem;letter-spacing:.2em;text-transform:uppercase">Image Soon</p>
          </div>
          <div class="pcard-badge">${badgeText}</div>
          <button class="heart-btn" data-product-id="${p.id}" data-product-name="${productName}" data-price="$${productPrice.toFixed(2)}" aria-label="Toggle favorite">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </button>
        </div>
        <div class="pcard-info">
          <p class="pcard-cat">${productCategory}</p>
          <p class="pcard-name">${productName}</p>
          <p class="pcard-price">${productPrice > 0 ? '$' + productPrice.toFixed(0) : 'Price TBA'}</p>
          <div class="pcard-action" onclick="event.stopPropagation(); toggleReviews('${p.id}')">
            <span id="avg-${p.id}" style="color:rgba(244,241,235,.2)">☆☆☆☆☆</span>
            <span id="cnt-${p.id}">Be the first to review</span>
          </div>
          <div class="reviews-panel" id="panel-${p.id}" style="display:none;margin-top:1rem;padding-top:1rem;border-top:1px solid rgba(244,241,235,.06)">
            <div class="reviews-list" id="list-${p.id}" style="margin-bottom:1rem"></div>
            <button class="write-review-btn" onclick="event.stopPropagation(); openReviewForm('${p.id}', '${productName}')">✎ Write a Review</button>
          </div>
        </div>
      </div>`;
  }).join('');

  // Re-init event listeners post-render
  initHeartButtons();
  initReviewToggles();
}

// Init listeners for newly rendered hearts/reviews
function initHeartButtons() {
  document.querySelectorAll('.heart-btn').forEach(btn => {
    // Remove existing listener to avoid duplicates
    btn.replaceWith(btn.cloneNode(true));
    const newBtn = btn.nextElementSibling || btn; // cloned
    newBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof toggleFavorite === 'function') toggleFavorite(newBtn);
    });
  });
}

function initReviewToggles() {
  document.querySelectorAll('.pcard-action').forEach(action => {
    action.addEventListener('click', (e) => {
      e.stopPropagation();
      const pid = e.currentTarget.parentElement.parentElement.querySelector('.heart-btn')?.dataset.productId;
      if (pid && typeof toggleReviews === 'function') toggleReviews(pid);
    });
  });
}

// Auto-init on load if grid exists (for index.html)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => loadProducts());
} else {
  loadProducts();
}

// Export for product.html/manual calls
window.loadProducts = loadProducts;
window._products_sb = window._sb; // share client
