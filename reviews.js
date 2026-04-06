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

// ââ Stars helpers ââââââââââââââââââââââââââââââââââââââââââââââââââ
function starsHtml(rating, size = 'sm') {
  const full  = Math.round(rating);
  const filled = 'â'.repeat(full);
  const empty  = 'â'.repeat(5 - full);
  return `<span style="color:#F891A5">${filled}</span><span style="color:rgba(244,241,235,.15)">${empty}</span>`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ââ Load & render reviews for a product âââââââââââââââââââââââââââ
async function loadReviews(pid) {
  if (!_sb) return [];
  if (_reviewCache[pid]) return _reviewCache[pid];

  const { data, error } = await _sb
    .from('reviews')
    .select('id, user_id, rating, title, body, reviewer_name, created_at, admin_response, fit_rating, comfort_rating, recommend')
    .eq('product_id', pid)
    .order('created_at', { ascending: false });

  if (error) { console.error('Reviews load error:', error); return []; }
  _reviewCache[pid] = data || [];
  return _reviewCache[pid];
}

function updateProductStarDisplay(domId, reviews) {
  const avgEl = document.getElementById(`avg-${domId}`);
  const cntEl = document.getElementById(`cnt-${domId}`);
  if (!avgEl || !cntEl) return;

  if (!reviews.length) {
    avgEl.innerHTML = '<span style="color:rgba(244,241,235,.2)">âââââ</span>';
    cntEl.textContent = 'Be the first to review';
    return;
  }
  const avg = reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
  avgEl.innerHTML = starsHtml(avg);
  cntEl.textContent = `${reviews.length} review${reviews.length !== 1 ? 's' : ''} Â· ${avg.toFixed(1)}`;
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

function renderReviewsList(domId, reviews) {
  const listEl = document.getElementById(`list-${domId}`);
  if (!listEl) return;

  if (!reviews.length) {
    listEl.innerHTML = '<p class="reviews-empty">No reviews yet â be the first!</p>';
    return;
  }
  const summaryHtml = generateReviewSummaryHtml(reviews);
  const listHtml = reviews.map(r => {
    let editBtn = '';
    if (typeof _currentUser !== 'undefined' && _currentUser && r.user_id === _currentUser.id) {
      editBtn = `<button onclick="openEditReviewForm('${r.id}', ${r.rating}, '${escHtml(r.body||'')}')" style="background:none;border:none;color:#F891A5;font-size:0.65rem;cursor:pointer;margin-left:8px;text-decoration:underline;text-transform:uppercase;letter-spacing:0.05em;font-family:'IBM Plex Mono', monospace;">Edit</button>`;
    }

    const adminResponseHtml = r.admin_response ? `
      <div class="admin-response" style="margin-top: 10px; padding: 10px; background: var(--admin-res-bg, rgba(248,145,165,0.08)); border-left: 2px solid var(--admin-res-text, #F891A5); border-radius: 4px;">
        <strong style="color: var(--admin-res-text, #F891A5); font-size: 0.8rem; letter-spacing: 0.05em; font-family: 'Bebas Neue', sans-serif;">Zuwera Team</strong>
        <p style="margin-top: 4px; font-size: 0.85rem; color: var(--admin-res-text, rgba(244,241,235,0.7));">${escHtml(r.admin_response)}</p>
      </div>
    ` : '';
    return `
      <div class="review-item">
        <div class="review-item-header">
        <div>
          <span class="review-item-stars">${starsHtml(r.rating)}</span>
          ${editBtn}
        </div>
          <span class="review-item-meta">${formatDate(r.created_at)}</span>
        </div>
      ${r.title ? `<p class="review-item-title" style="font-weight:bold;font-size:0.85rem;margin-bottom:0.2rem;color:rgba(244,241,235,0.9);">${escHtml(r.title)}</p>` : ''}
        ${r.body ? `<p class="review-item-body">${escHtml(r.body)}</p>` : ''}
        <p class="review-item-author">${escHtml(r.reviewer_name || 'Anonymous')}</p>
        ${adminResponseHtml}
      </div>
    `;
  }).join('');
  
  const translateHtml = `
    <div style="display:flex; gap:10px; margin-bottom:1.5rem; margin-top:1rem;">
      <select id="translate-lang-${domId}" style="flex:1; background:rgba(244,241,235,0.05); color:#f4f1eb; border:1px solid rgba(244,241,235,0.2); padding:0.8rem 1rem; border-radius:4px; font-family:'DM Sans', sans-serif; outline:none; -webkit-appearance:none; appearance:none; background-image:url('data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'12\\' height=\\'7\\'><path d=\\'M1 1l5 5 5-5\\' stroke=\\'%23f4f1eb\\' stroke-width=\\'1.5\\' fill=\\'none\\' opacity=\\'0.4\\'/></svg>'); background-repeat:no-repeat; background-position:right 1rem center; cursor:pointer;">
        <option value="es" style="background:#09090b;">Spanish</option>
        <option value="fr" style="background:#09090b;">French</option>
        <option value="zh" style="background:#09090b;">Mandarin Chinese</option>
      </select>
      <button id="translate-reviews-btn-${domId}" class="translate-btn" style="margin-bottom:0; width:auto; padding:0.8rem 1.5rem;" onclick="translateReviews('${domId}')">Translate</button>
    </div>
  `;
  listEl.innerHTML = summaryHtml + translateHtml + listHtml;
}

// ââ Toggle reviews panel open / closed ââââââââââââââââââââââââââââ
async function toggleReviews(pid, domId = pid) {
  const panel   = document.getElementById(`panel-${domId}`);
  const listEl  = document.getElementById(`list-${domId}`);
  if (!panel) return;

  _domIdToPid[domId] = pid;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';

  if (!isOpen) {
    // Show loading state then fetch
    listEl.innerHTML = '<p class="reviews-loading">Loading reviewsâ¦</p>';
    const reviews = await loadReviews(pid);
    renderReviewsList(domId, reviews);
    updateProductStarDisplay(domId, reviews);
  }
}

// ââ Open the write-a-review modal âââââââââââââââââââââââââââââââââ
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

// ââ Star selector interaction ââââââââââââââââââââââââââââââââââââââ
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

// ââ Submit review âââââââââââââââââââââââââââââââââââââââââââââââââ
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
  // if (!_sb || typeof _user === 'undefined' || !_user) { errEl.textContent = 'Please sign in to leave a review.'; return; }

  btn.disabled    = true;
  btn.textContent = 'Submittingâ¦';

  const reviewerName = (typeof _currentUser !== 'undefined' && _currentUser) ? (_currentUser.user_metadata?.full_name
    || _currentUser.email?.split('@')[0]) : 'Anonymous';

  let error;
  if (_reviewIdToEdit) {
    const res = await _sb.from('reviews').update({
      rating: _reviewRating,
      body:   body || null,
      fit_rating: fit ? parseInt(fit) : null,
      comfort_rating: comfort ? parseInt(comfort) : null,
      recommend: recommend === 'yes' ? true : (recommend === 'no' ? false : null)
    }).eq('id', _reviewIdToEdit);
    error = res.error;
  } else {
    const res = await _sb.from('reviews').insert({
      user_id:       (typeof _currentUser !== 'undefined' && _currentUser) ? _currentUser.id : null,
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
  showToast('Review submitted â thank you!');

  // Refresh all instances of panels and stars for this product
  const reviews = await loadReviews(_reviewProductId);
  document.querySelectorAll(`[id^="panel-${_reviewProductId}"]`).forEach(panel => {
      if (panel.style.display !== 'none') {
          const domId = panel.id.replace('panel-', '');
          renderReviewsList(domId, reviews);
          updateProductStarDisplay(domId, reviews);
      }
  });
  document.querySelectorAll(`[id^="avg-${_reviewProductId}"]`).forEach(el => {
      const domId = el.id.replace('avg-', '');
      updateProductStarDisplay(domId, reviews);
  });
}

// ââ Init: load star averages for all product cards on page load âââ
(async function initReviewSummaries() {
  const pids = Array.from(document.querySelectorAll('[data-review-pid]'))
    .map(el => el.dataset.reviewPid);

  await Promise.all(pids.map(async pid => {
    const reviews = await loadReviews(pid);
    updateProductStarDisplay(pid, reviews);
  }));
})();

// ââ Utility: escape HTML to prevent XSS in review text âââââââââââ
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
  
  const pid = _domIdToPid[domId];
  const reviews = _reviewCache[pid];
  if (!reviews || reviews.length === 0) return;
  
  if(btn) { btn.textContent = 'Translating...'; btn.disabled = true; }
  
  try {
    const textsToTranslate = [];
    const map = [];
    
    reviews.forEach((r, i) => {
      if (r.original_title === undefined) r.original_title = r.title;
      if (r.original_body === undefined) r.original_body = r.body;

      if (r.original_title) { textsToTranslate.push(r.original_title); map.push({ index: i, field: 'title' }); }
      if (r.original_body) { textsToTranslate.push(r.original_body); map.push({ index: i, field: 'body' }); }
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
        reviews[mapping.index][mapping.field] = txt.value;
      });
    }

    renderReviewsList(domId, reviews);
    
    if (typeof showToast === 'function') showToast('Reviews translated to ' + lang + '!');
    if(btn) { btn.textContent = 'Translated â'; btn.disabled = false; }
  } catch (err) {
    console.error('Translation failed:', err);
    if (typeof showToast === 'function') showToast('Translation failed. Check API keys.');
    if(btn) { btn.textContent = 'Translate'; btn.disabled = false; }
  }
};

// ââ Close review modal on backdrop click âââââââââââââââââââââââââ
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
