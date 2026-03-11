/**
 * reviews.js — Product reviews powered by Supabase
 *
 * Requires:
 *  - Supabase client (_sb) already initialised in auth.js
 *  - _openModal() / _closeModal() from cart.js
 *  - showToast() from cart.js
 *
 * Supabase table (run once in the Supabase SQL editor):
 * ─────────────────────────────────────────────────────
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

// ── State ──────────────────────────────────────────────────────────
let _reviewProductId   = null;   // currently open form target
let _reviewProductName = null;
let _reviewRating      = 0;

// Cache of loaded reviews per product to avoid redundant DB calls
const _reviewCache = {};

// ── Stars helpers ──────────────────────────────────────────────────
function starsHtml(rating, size = 'sm') {
  const full  = Math.round(rating);
  const filled = '★'.repeat(full);
  const empty  = '☆'.repeat(5 - full);
  return `<span style="color:#F891A5">${filled}</span><span style="color:rgba(244,241,235,.15)">${empty}</span>`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Load & render reviews for a product ───────────────────────────
async function loadReviews(pid) {
  if (!_sb) return [];
  if (_reviewCache[pid]) return _reviewCache[pid];

  const { data, error } = await _sb
    .from('reviews')
    .select('id, rating, body, reviewer_name, created_at')
    .eq('product_id', pid)
    .order('created_at', { ascending: false });

  if (error) { console.error('Reviews load error:', error); return []; }
  _reviewCache[pid] = data || [];
  return _reviewCache[pid];
}

function updateProductStarDisplay(pid, reviews) {
  const avgEl = document.getElementById(`avg-${pid}`);
  const cntEl = document.getElementById(`cnt-${pid}`);
  if (!avgEl || !cntEl) return;

  if (!reviews.length) {
    avgEl.innerHTML = '<span style="color:rgba(244,241,235,.2)">☆☆☆☆☆</span>';
    cntEl.textContent = 'Be the first to review';
    return;
  }
  const avg = reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
  avgEl.innerHTML = starsHtml(avg);
  cntEl.textContent = `${reviews.length} review${reviews.length !== 1 ? 's' : ''} · ${avg.toFixed(1)}`;
}

function renderReviewsList(pid, reviews) {
  const listEl = document.getElementById(`list-${pid}`);
  if (!listEl) return;

  if (!reviews.length) {
    listEl.innerHTML = '<p class="reviews-empty">No reviews yet — be the first!</p>';
    return;
  }
  listEl.innerHTML = reviews.map(r => `
    <div class="review-item">
      <div class="review-item-header">
        <span class="review-item-stars">${starsHtml(r.rating)}</span>
        <span class="review-item-meta">${formatDate(r.created_at)}</span>
      </div>
      ${r.body ? `<p class="review-item-body">${escHtml(r.body)}</p>` : ''}
      <p class="review-item-author">${escHtml(r.reviewer_name || 'Anonymous')}</p>
    </div>
  `).join('');
}

// ── Toggle reviews panel open / closed ────────────────────────────
async function toggleReviews(pid) {
  const panel   = document.getElementById(`panel-${pid}`);
  const listEl  = document.getElementById(`list-${pid}`);
  if (!panel) return;

  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';

  if (!isOpen) {
    // Show loading state then fetch
    listEl.innerHTML = '<p class="reviews-loading">Loading reviews…</p>';
    const reviews = await loadReviews(pid);
    renderReviewsList(pid, reviews);
    updateProductStarDisplay(pid, reviews);
  }
}

// ── Open the write-a-review modal ─────────────────────────────────
function openReviewForm(pid, pname) {
  if (!_currentUser) {
    // Not logged in — show auth modal instead
    openAuthModal('signin');
    return;
  }
  _reviewProductId   = pid;
  _reviewProductName = pname;
  _reviewRating      = 0;

  document.getElementById('review-product-label').textContent = pname;
  document.getElementById('review-body-input').value = '';
  document.getElementById('review-error').textContent = '';
  document.getElementById('review-submit-btn').disabled = false;
  document.getElementById('review-submit-btn').textContent = 'Submit Review';
  setStarSelection(0);

  _openModal('review-modal');
}

// ── Star selector interaction ──────────────────────────────────────
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

// ── Submit review ─────────────────────────────────────────────────
async function submitReview() {
  const errEl  = document.getElementById('review-error');
  const btn    = document.getElementById('review-submit-btn');
  const body   = document.getElementById('review-body-input').value.trim();
  errEl.textContent = '';

  if (!_reviewRating)        { errEl.textContent = 'Please select a star rating.'; return; }
  if (!_reviewProductId)     { errEl.textContent = 'No product selected.'; return; }
  if (!_sb || !_currentUser) { errEl.textContent = 'Please sign in to leave a review.'; return; }

  btn.disabled    = true;
  btn.textContent = 'Submitting…';

  const reviewerName = _currentUser.user_metadata?.full_name
    || _currentUser.email?.split('@')[0]
    || 'Anonymous';

  const { error } = await _sb.from('reviews').insert({
    user_id:       _currentUser.id,
    product_id:    _reviewProductId,
    rating:        _reviewRating,
    body:          body || null,
    reviewer_name: reviewerName,
  });

  if (error) {
    errEl.textContent = error.message || 'Could not submit review. Please try again.';
    btn.disabled    = false;
    btn.textContent = 'Submit Review';
    return;
  }

  // Bust cache so the new review shows immediately
  delete _reviewCache[_reviewProductId];

  _closeModal('review-modal');
  showToast('Review submitted — thank you!');

  // Refresh the panel if it's open
  const panel = document.getElementById(`panel-${_reviewProductId}`);
  if (panel && panel.style.display !== 'none') {
    const reviews = await loadReviews(_reviewProductId);
    renderReviewsList(_reviewProductId, reviews);
    updateProductStarDisplay(_reviewProductId, reviews);
  } else {
    // Still update the star summary in the toggle button
    const reviews = await loadReviews(_reviewProductId);
    updateProductStarDisplay(_reviewProductId, reviews);
  }
}

// ── Init: load star averages for all product cards on page load ───
(async function initReviewSummaries() {
  const pids = Array.from(document.querySelectorAll('[data-review-pid]'))
    .map(el => el.dataset.reviewPid);

  await Promise.all(pids.map(async pid => {
    const reviews = await loadReviews(pid);
    updateProductStarDisplay(pid, reviews);
  }));
})();

// ── Utility: escape HTML to prevent XSS in review text ───────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Close review modal on backdrop click ─────────────────────────
document.getElementById('review-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) _closeModal('review-modal');
});
document.getElementById('review-modal-close').addEventListener('click', () => {
  _closeModal('review-modal');
});
