/**
 * reviews.js â Product reviews powered by Supabase
 *
 * Requires:
 *  - Supabase client (_sb) already initialised in auth.js
 *  - _openModal() / _closeModal() from cart.js
 *  - showToast() from cart.js
 *
 * Supabase table (run once in the Supabase SQL editor):
 * âââââââââââââââââââââââââââââââââââââââââââââââââââââ
 *  create table reviews (
 *    id            uuid    default gen_random_uuid() primary key,
 *    user_id       uuid    references auth.users(id) on delete cascade,
 *    product_id    text    not null,
 *    rating        int     not null check (rating >= 1 and rating <= 5),
 *    body          text,
 *    reviewer_name text,
 *    created_at    timestamptz default now()
 *  );
 *
 *  -- Allow anyone to read; only the owner can insert/delete
 *  alter table reviews enable row level security;
 *  create policy "Public read"   on reviews for select using (true);
 *  create policy "Auth insert"   on reviews for insert with check (auth.uid() = user_id);
 *  create policy "Owner delete"  on reviews for delete using (auth.uid() = user_id);
 */

// ââ State ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
let _reviewProductId   = null;   // currently open form target
let _reviewProductName = null;
let _reviewRating      = 0;
let _reviewIdToEdit    = null;

// Cache of loaded reviews per product to avoid redundant DB calls
const _reviewCache = {};
const _domIdToPid = {};

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

// -- Stars helpers ----------------------------------------------------
function starsHtml(rating, size = 'sm') {
  const full   = Math.max(0, Math.min(5, Math.round(rating || 0)));
  const filled = '\u2605'.repeat(full);        // ★  — Unicode escape avoids charset issues
  const empty  = '\u2605'.repeat(5 - full);   // ★ (dimmed via color)
  return `<span style="color:#F891A5">${filled}</span><span style="color:rgba(244,241,235,.12)">${empty}</span>`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// -- Load & render reviews for a product ------------------------------
async function loadReviews(pid) {
  if (_reviewCache[pid]) return _reviewCache[pid];
  const reviewSelect = '*';

  try {
    if (typeof SUPABASE_URL !== 'undefined' && typeof SUPABASE_ANON !== 'undefined') {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/reviews?product_id=eq.${encodeURIComponent(pid)}&select=${encodeURIComponent(reviewSelect)}&order=created_at.desc`,
        {
          headers: { 'apikey': SUPABASE_ANON, 'Authorization': `Bearer ${SUPABASE_ANON}` },
          signal: controller.signal,
        }
      );
      clearTimeout(timeoutId);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      _reviewCache[pid] = Array.isArray(data) ? data : [];
      return _reviewCache[pid];
    }

    if (!window.sb) return [];
    const { data, error } = await window.sb
      .from('reviews')
      .select(reviewSelect)
      .eq('product_id', pid)
      .order('created_at', { ascending: false });

    if (error) throw error;
    _reviewCache[pid] = data || [];
    return _reviewCache[pid];
  } catch (error) {
    console.error('Reviews load error:', error);
    _reviewCache[pid] = [];
    return _reviewCache[pid];
  }
}

function updateProductStarDisplay(domId, reviews) {
  const avgEl = document.getElementById(`avg-${domId}`);
  const cntEl = document.getElementById(`cnt-${domId}`);
  if (!avgEl || !cntEl) return;

  if (!reviews.length) {
    avgEl.innerHTML = '<span style="color:rgba(244,241,235,.2)">\u2605\u2605\u2605\u2605\u2605</span>';
    cntEl.textContent = 'Be the first to review';
    return;
  }
  const avg = reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
  avgEl.innerHTML = starsHtml(avg);
  cntEl.textContent = `${reviews.length} review${reviews.length !== 1 ? 's' : ''} · ${avg.toFixed(1)}`;
}

function generateReviewSummaryHtml(reviews) {
  if (!reviews || reviews.length === 0) return '';
  
  let sumRating = 0, sumFit = 0, fitCount = 0, sumComfort = 0, comfortCount = 0;
  let recYes = 0, recNo = 0;
  
  reviews.forEach(r => {
    sumRating += r.rating || 0;
    if (r.fit_rating) { sumFit += r.fit_rating; fitCount++; }
    if (r.comfort_rating) { sumComfort += r.comfort_rating; comfortCount++; }
    if (r.recommend === true) recYes++;
    if (r.recommend === false) recNo++;
  });
  
  const avgRating = (sumRating / reviews.length).toFixed(1);
  const avgFit = fitCount > 0 ? (sumFit / fitCount) : 3;
  const avgComfort = comfortCount > 0 ? (sumComfort / comfortCount) : 5;
  
  const fitPct = Math.round(((avgFit - 1) / 4) * 100);
  const comfortPct = Math.round(((avgComfort - 1) / 4) * 100);

  return `
    <div class="review-summary-box">
      <div class="rs-left">
        <div class="rs-rating">${avgRating}</div>
        <div class="rs-stars">${starsHtml(Math.round(avgRating))}</div>
        <div class="rs-count">${avgRating} out of 5 stars</div>
        <div class="rs-count">${reviews.length} Review${reviews.length !== 1 ? 's' : ''}</div>
      </div>
      <div class="rs-right">
        <div class="rs-metric">
          <div class="rs-metric-title">How did this product fit?</div>
          <div class="rs-metric-subtitle">${fitPct}% between Runs Small and Runs Big</div>
          <div class="rs-metric-bar"><div class="rs-metric-fill" style="left: ${fitPct}%;"></div></div>
          <div class="rs-metric-labels"><span>Runs Small</span><span>Runs Big</span></div>
        </div>
        <div class="rs-metric">
          <div class="rs-metric-title">How comfortable was this product?</div>
          <div class="rs-metric-subtitle">${comfortPct}% between Uncomfortable and Very Comfortable</div>
          <div class="rs-metric-bar"><div class="rs-metric-fill" style="left: ${comfortPct}%;"></div></div>
          <div class="rs-metric-labels"><span>Uncomfortable</span><span>Very Comfortable</span></div>
        </div>
        <div class="rs-recommend">
          <div class="rs-metric-title">Would you recommend this product?</div>
          <div class="rs-metric-subtitle">Yes (${recYes}) / No (${recNo})</div>
        </div>
      </div>
    </div>
  `;
}

window.openAllReviewsModal = async function(pid, domId, productName) {
  const modal = document.getElementById('all-reviews-modal');
  if (!modal) return;
  
  _domIdToPid[domId] = pid;
  window._domIdToPname = window._domIdToPname || {};
  window._domIdToPname[domId] = productName;
  _reviewProductId = pid;
  
  const list = document.getElementById('all-reviews-list');
  const summary = document.getElementById('all-reviews-summary');
  
  const translateSelect = modal.querySelector('select[id^="translate-lang"]');
  const translateBtn = modal.querySelector('button[id^="translate-reviews-btn"]');
  if (translateSelect) translateSelect.id = 'translate-lang-' + domId;
  if (translateBtn) {
    translateBtn.id = 'translate-reviews-btn-' + domId;
    translateBtn.setAttribute('onclick', `translateReviews('${domId}')`);
  }
  
  let writeBtn = document.getElementById('all-reviews-write-btn');
  if (!writeBtn) {
    writeBtn = document.createElement('button');
    writeBtn.id = 'all-reviews-write-btn';
    writeBtn.style.cssText = 'width:100%; margin-bottom: 1.5rem; padding: 0.9rem; font-family: var(--fw, "Bebas Neue", sans-serif); font-weight: 900; font-style: italic; font-size: 1.1rem; letter-spacing: 0.12em; text-transform: uppercase; background: var(--paper, #f4f1eb); color: var(--ink, #09090b); border: none; cursor: pointer; transition: opacity 0.2s; border-radius: 4px;';
    writeBtn.textContent = 'Write a Review';
    writeBtn.onmouseover = () => writeBtn.style.opacity = '0.85';
    writeBtn.onmouseout = () => writeBtn.style.opacity = '1';
    summary.parentNode.insertBefore(writeBtn, summary);
  }
  
  writeBtn.onclick = () => {
    modal.classList.remove('open');
    openReviewForm(pid, productName);
  };

  list.innerHTML = '<p style="padding:2rem;text-align:center;color:rgba(244,241,235,.5);font-family:\'DM Sans\',sans-serif;">Loading reviews...</p>';
  summary.innerHTML = '';
  
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';

  try {
    const reviews = await withTimeout(loadReviews(pid), 8000, 'Reviews request');
  
    let user = null;
    if (typeof currentUser !== 'undefined' && currentUser) user = currentUser;
    else if (typeof _user !== 'undefined' && _user) user = _user;
    else if (typeof _currentUser !== 'undefined' && _currentUser) user = _currentUser;
  
  list.innerHTML = '';
  if (!reviews || reviews.length === 0) {
    list.innerHTML = '<p style="padding:2rem;text-align:center;color:rgba(244,241,235,.5);font-family:\'DM Sans\',sans-serif;">No reviews yet — be the first to review!</p>';
    return;
  }
  
  summary.innerHTML = generateReviewSummaryHtml(reviews);
  
  reviews.forEach(review => {
    const reviewEl = document.createElement('div');
    reviewEl.className = 'review-item';
    reviewEl.style.cssText = 'padding: 1.5rem 0; border-bottom: 1px solid rgba(244,241,235,.08); font-family: \'DM Sans\', sans-serif; text-align: left;';
    
    const adminResponseHtml = review.admin_response ? `
      <div class="admin-response" style="margin-top: 12px; padding: 12px; background: var(--admin-res-bg, rgba(248,145,165,0.08)); border-left: 2px solid var(--admin-res-text, #F891A5); border-radius: 4px;">
        <strong style="color: var(--admin-res-text, #F891A5); font-size: 0.85rem; letter-spacing: 0.05em; font-family: 'Bebas Neue', sans-serif;">Zuwera Team</strong>
        <p style="margin-top: 4px; font-size: 0.85rem; color: var(--admin-res-text, rgba(244,241,235,0.7));">${escHtml(review.admin_response)}</p>
      </div>
    ` : '';

    let editBtnHtml = '';
    if (user && review.user_id === user.id) {
      editBtnHtml = `<button onclick="openEditReviewForm('${review.id}', ${review.rating}, '${escHtml(review.body || '')}'); document.getElementById('all-reviews-modal').classList.remove('open');" style="background:none;border:none;color:#F891A5;font-size:0.75rem;cursor:pointer;margin-left:10px;text-decoration:underline;">Edit</button>`;
    }

    reviewEl.innerHTML = `
      <div class="review-header" style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        <div class="review-rating" style="color:var(--gold, #F891A5);">${starsHtml(review.rating)}</div>
        <span class="review-author" style="font-size:0.85rem;opacity:0.8;color:#f4f1eb;">${escHtml(review.nickname || review.reviewer_name || 'Anonymous')}</span>
        ${review.verified_purchase ? '<span class="verified-badge" style="font-size:0.65rem;background:rgba(16,185,129,.1);color:#10b981;padding:2px 6px;border-radius:4px;">Verified</span>' : ''}
        ${editBtnHtml}
      </div>
      ${review.title ? `<p class="review-title" style="font-weight:700;font-size:1rem;margin-bottom:6px;color:#f4f1eb;">${escHtml(review.title)}</p>` : ''}
      ${review.body ? `<p class="review-body" style="font-size:0.9rem;line-height:1.6;opacity:0.8;color:#f4f1eb;">${escHtml(review.body)}</p>` : ''}
      ${adminResponseHtml}
    `;
    list.appendChild(reviewEl);
  });
  } catch (error) {
    console.error('All reviews modal failed:', error);
    summary.innerHTML = '';
    list.innerHTML = '<p style="padding:2rem;text-align:center;color:rgba(244,241,235,.5);font-family:\'DM Sans\',sans-serif;">Could not load reviews right now. Please try again.</p>';
  }
};

// -- Open the write-a-review modal ------------------------------------
function openReviewForm(pid, pname) {
  /*
  if (typeof _currentUser === 'undefined' || !_currentUser) {
    // Not logged in â show auth modal instead
    if (typeof openAuth === 'function') openAuth('signin');
    return;
  }
  */
  _reviewProductId   = pid;
  _reviewProductName = pname;
  _reviewRating      = 0;
  _reviewIdToEdit    = null;

  document.getElementById('review-product-label').textContent = pname;
  document.getElementById('review-body-input').value = '';
  document.getElementById('review-error').textContent = '';
  document.getElementById('review-submit-btn').disabled = false;
  document.getElementById('review-submit-btn').textContent = 'Submit Review';
  
  const fitToggle = document.getElementById('rateFitToggle');
  if (fitToggle) {
    fitToggle.checked = false;
    const adv = document.getElementById('advancedRatings');
    if (adv) adv.style.display = 'none';
  }

  if (document.getElementById('reviewFit')) document.getElementById('reviewFit').value = "3";
  if (document.getElementById('reviewComfort')) document.getElementById('reviewComfort').value = "5";
  if (document.querySelector('input[name="reviewRecommend"][value="yes"]')) document.querySelector('input[name="reviewRecommend"][value="yes"]').checked = true;

  setStarSelection(0);

  document.getElementById('review-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function openEditReviewForm(id, rating, body) {
  _reviewIdToEdit = id;
  _reviewRating = rating;

  const bodyInput = document.getElementById('review-body-input');
  if (bodyInput) bodyInput.value = body || '';

  const review = _reviewCache[_reviewProductId]?.find(r => r.id === id);
  const fitToggle = document.getElementById('rateFitToggle');
  const adv = document.getElementById('advancedRatings');
  if (review) {
    const hasAdvanced = review.fit_rating || review.comfort_rating || review.recommend !== null;
    if (fitToggle) fitToggle.checked = !!hasAdvanced;
    if (adv) adv.style.display = hasAdvanced ? 'block' : 'none';

    if (document.getElementById('reviewFit') && review.fit_rating) document.getElementById('reviewFit').value = review.fit_rating;
    if (document.getElementById('reviewComfort') && review.comfort_rating) document.getElementById('reviewComfort').value = review.comfort_rating;
    if (review.recommend !== null) {
      const radio = document.querySelector(`input[name="reviewRecommend"][value="${review.recommend ? 'yes' : 'no'}"]`);
      if (radio) radio.checked = true;
    }
  }

  document.getElementById('review-error').textContent = '';
  const btn = document.getElementById('review-submit-btn');
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Update Review';
  }
  setStarSelection(rating);
  document.getElementById('review-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

// -- Star selector interaction ----------------------------------------
function setStarSelection(val) {
  _reviewRating = val;
  document.querySelectorAll('#star-selector button').forEach(btn => {
    btn.classList.toggle('lit', Number(btn.dataset.v) <= val);
  });
}

document.querySelectorAll('#star-selector button').forEach(btn => {
  const v = Number(btn.dataset.v);
  btn.addEventListener('click',      () => setStarSelection(v));
  btn.addEventListener('mouseenter', () => {
    document.querySelectorAll('#star-selector button').forEach(b => {
      b.classList.toggle('hover', Number(b.dataset.v) <= v);
    });
  });
  btn.addEventListener('mouseleave', () => {
    document.querySelectorAll('#star-selector button').forEach(b => b.classList.remove('hover'));
  });
});

// -- Submit review ----------------------------------------------------
async function submitReview() {
  const errEl  = document.getElementById('review-error');
  const btn    = document.getElementById('review-submit-btn');
  const body   = document.getElementById('review-body-input').value.trim();
  
  const isAdvancedChecked = document.getElementById('rateFitToggle')?.checked;
  const fit = isAdvancedChecked ? document.getElementById('reviewFit')?.value : null;
  const comfort = isAdvancedChecked ? document.getElementById('reviewComfort')?.value : null;
  const recommend = isAdvancedChecked ? document.querySelector('input[name="reviewRecommend"]:checked')?.value : null;
  errEl.textContent = '';

  if (!_reviewRating)        { errEl.textContent = 'Please select a star rating.'; return; }
  if (!_reviewProductId)     { errEl.textContent = 'No product selected.'; return; }

  let user = null;
  if (window.sb) {
     const { data } = await window.sb.auth.getSession();
     user = data?.session?.user || null;
  }
  if (!user) { errEl.textContent = 'Please sign in to leave a review.'; return; }

  btn.disabled    = true;
  btn.textContent = 'Submitting...';

  const reviewerName = user.user_metadata?.full_name || user.email?.split('@')[0] || 'Anonymous';

  let error;
  if (_reviewIdToEdit) {
    const res = await window.sb.from('reviews').update({
      rating: _reviewRating,
      body:   body || null,
      fit_rating: fit ? parseInt(fit) : null,
      comfort_rating: comfort ? parseInt(comfort) : null,
      recommend: recommend === 'yes' ? true : (recommend === 'no' ? false : null)
    }).eq('id', _reviewIdToEdit);
    error = res.error;
  } else {
    const res = await window.sb.from('reviews').insert({
      user_id:       user.id,
      product_id:    _reviewProductId,
      rating:        _reviewRating,
      body:          body || null,
      reviewer_name: reviewerName,
      fit_rating: fit ? parseInt(fit) : null,
      comfort_rating: comfort ? parseInt(comfort) : null,
      recommend: recommend === 'yes' ? true : (recommend === 'no' ? false : null)
    });
    error = res.error;
  }

  if (error) {
    errEl.textContent = error.message || 'Could not submit review. Please try again.';
    btn.disabled    = false;
    btn.textContent = 'Submit Review';
    return;
  }

  _reviewIdToEdit = null;

  // Bust cache so the new review shows immediately
  delete _reviewCache[_reviewProductId];

  document.getElementById('review-modal').classList.remove('open');
  document.body.style.overflow = '';
  if (typeof showToast === 'function') showToast('Review submitted — thank you!');

  // Refresh all instances of panels and stars for this product
  const reviews = await loadReviews(_reviewProductId);
  document.querySelectorAll(`[id^="avg-${_reviewProductId}"]`).forEach(el => {
      const domId = el.id.replace('avg-', '');
      updateProductStarDisplay(domId, reviews);
  });

  if (typeof renderReviews === 'function') renderReviews(); // update product.html inline reviews summary
  const allModal = document.getElementById('all-reviews-modal');
  if (allModal && allModal.classList.contains('open')) {
    openAllReviewsModal(_reviewProductId, _reviewProductId, window._domIdToPname?.[_reviewProductId]);
  }
}

// -- Init: load star averages for all product cards on page load ------
async function initReviewSummaries() {
  const els = Array.from(document.querySelectorAll('[data-review-pid]'));
  await Promise.all(els.map(async el => {
    const pid   = el.dataset.reviewPid;
    const domId = el.dataset.reviewDomid || pid;
    const reviews = await loadReviews(pid);
    updateProductStarDisplay(domId, reviews);
  }));
}
// Expose as initReviews so loadProducts() can call it after dynamic render
window.initReviews = initReviewSummaries;
// If loadProducts() already finished before this script ran (rare but possible),
// a pending flag was left — init immediately.
if (window._reviewsPending) {
  window._reviewsPending = false;
  initReviewSummaries();
}
// Also run for any cards already in the DOM right now
initReviewSummaries();

// -- Utility: escape HTML to prevent XSS in review text ---------------
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window.translateReviews = async function(domId) {
  const selectId = domId ? 'translate-lang-' + domId : 'translate-lang';
  const btnId = domId ? 'translate-reviews-btn-' + domId : 'translate-reviews-btn';
  const select = document.getElementById(selectId);
  const langCode = select ? select.value : 'es';
  const lang = select ? select.options[select.selectedIndex].text : 'English';
  const btn = document.getElementById(btnId);
  
  const pid = _domIdToPid[domId] || _reviewProductId;
  let reviewsToTranslate = [];
  if (_reviewCache[pid]) reviewsToTranslate.push(..._reviewCache[pid]);
  if (typeof currentProduct !== 'undefined' && currentProduct && currentProduct.id === pid && currentProduct.reviews) {
      reviewsToTranslate.push(...currentProduct.reviews);
  }
  
  // Filter to a unique array to avoid duplicating translation API requests
  const allReviews = Array.from(new Set(reviewsToTranslate));
  if (allReviews.length === 0) return;
  
  if(btn) { btn.textContent = 'Translating...'; btn.disabled = true; }
  
  try {
    const textsToTranslate = [];
    const map = [];
    
    allReviews.forEach((r, i) => {
      if (r.original_title === undefined) r.original_title = r.title;
      if (r.original_body === undefined) r.original_body = r.body;

      if (r.original_title) { textsToTranslate.push(r.original_title); map.push({ obj: r, field: 'title' }); }
      if (r.original_body) { textsToTranslate.push(r.original_body); map.push({ obj: r, field: 'body' }); }
    });

    if (textsToTranslate.length > 0) {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: textsToTranslate, target: langCode })
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      data.translations.forEach((translatedText, i) => {
        const mapping = map[i];
        const txt = document.createElement('textarea');
        txt.innerHTML = translatedText;
        mapping.obj[mapping.field] = txt.value;
      });
    }

    if (typeof renderReviews === 'function') renderReviews();
    if (document.getElementById('all-reviews-modal').classList.contains('open')) {
      openAllReviewsModal(pid, domId, window._domIdToPname?.[domId]);
    }
    
    if (typeof showToast === 'function') showToast('Reviews translated to ' + lang + '!');
    if(btn) { btn.textContent = 'Translated ✓'; btn.disabled = false; }
  } catch (err) {
    console.error('Translation failed:', err);
    if (typeof showToast === 'function') showToast('Translation failed. Check API keys.');
    if(btn) { btn.textContent = 'Translate'; btn.disabled = false; }
  }
};

// -- Close review modal on backdrop click -----------------------------
document.getElementById('review-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) {
    document.getElementById('review-modal').classList.remove('open');
    document.body.style.overflow = '';
  }
});
document.getElementById('review-modal-close').addEventListener('click', () => {
  document.getElementById('review-modal').classList.remove('open');
  document.body.style.overflow = '';
});

// Ensure all-reviews-modal can be safely closed globally
document.addEventListener('DOMContentLoaded', () => {
  const allModal = document.getElementById('all-reviews-modal');
  if (allModal) {
    allModal.addEventListener('click', e => {
      if (e.target === e.currentTarget) {
        allModal.classList.remove('open');
        document.body.style.overflow = '';
      }
    });
    const closeBtn = document.getElementById('all-reviews-close');
    if (closeBtn) closeBtn.addEventListener('click', () => {
      allModal.classList.remove('open');
      document.body.style.overflow = '';
    });
  }
});
