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
let _reviewIdToEdit    = null;

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
    .select('id, user_id, rating, title, body, reviewer_name, created_at, admin_response')
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
    avgEl.innerHTML = '<span style="color:rgba(244,241,235,.2)">☆☆☆☆☆</span>';
    cntEl.textContent = 'Be the first to review';
    return;
  }
  const avg = reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
  avgEl.innerHTML = starsHtml(avg);
  cntEl.textContent = `${reviews.length} review${reviews.length !== 1 ? 's' : ''} · ${avg.toFixed(1)}`;
}

function renderReviewsList(domId, reviews) {
  const listEl = document.getElementById(`list-${domId}`);
  if (!listEl) return;

  if (!reviews.length) {
    listEl.innerHTML = '<p class="reviews-empty">No reviews yet — be the first!</p>';
    return;
  }
  listEl.innerHTML = reviews.map(r => {
    let editBtn = '';
    if (typeof _user !== 'undefined' && _user && r.user_id === _user.id) {
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
}

// ── Toggle reviews panel open / closed ────────────────────────────
async function toggleReviews(pid, domId = pid) {
  const panel   = document.getElementById(`panel-${domId}`);
  const listEl  = document.getElementById(`list-${domId}`);
  if (!panel) return;

  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';

  if (!isOpen) {
    // Show loading state then fetch
    listEl.innerHTML = '<p class="reviews-loading">Loading reviews…</p>';
    const reviews = await loadReviews(pid);
    renderReviewsList(domId, reviews);
    updateProductStarDisplay(domId, reviews);
  }
}

// ── Open the write-a-review modal ─────────────────────────────────
function openReviewForm(pid, pname) {
  if (typeof _user === 'undefined' || !_user) {
    // Not logged in — show auth modal instead
    if (typeof openAuth === 'function') openAuth('signin');
    return;
  }
  _reviewProductId   = pid;
  _reviewProductName = pname;
  _reviewRating      = 0;
  _reviewIdToEdit    = null;

  document.getElementById('review-product-label').textContent = pname;
  document.getElementById('review-body-input').value = '';
  document.getElementById('review-error').textContent = '';
  document.getElementById('review-submit-btn').disabled = false;
  document.getElementById('review-submit-btn').textContent = 'Submit Review';
  setStarSelection(0);

  document.getElementById('review-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function openEditReviewForm(id, rating, body) {
  _reviewIdToEdit = id;
  _reviewRating = rating;

  const bodyInput = document.getElementById('review-body-input');
  if (bodyInput) bodyInput.value = body || '';

  document.getElementById('review-error').textContent = '';
  const btn = document.getElementById('review-submit-btn');
Account home

Recents
Turnstile
Application securi...

Workers & Pages
Compute

Overview
Domains

Edge Certificates
zuwera.store
/
SSL/TLS

Overview
zuwera.store
/
Rules


Analytics & logs

Domains
Build

Compute
Workers & Pages
Observability
Workers for Platforms
Containers
Beta
Durable Objects
Queues
Workflows
Browser Rendering
VPC
Beta

Email Service
Workers plans

AI

Storage & databases

Media
Protect & Connect

Application security
Zero Trust

Networking

Delivery & performance

Manage account
Workers & Pages
zuwera-store
Deployments
Metrics
Custom domains
Settings
Build
Variables and Secrets
Bindings
Runtime
General
Pages configuration
Give feedback
Choose Environment:
Build
Git repository

breezenash24-droid/zuwera-store
Build configuration
Build command:
npm install
Build output:
.
Root directory:
Build comments:
Enabled
Build cache
Disabled
Branch control
Production branch:
main
Automatic deployments:
Enabled
Build watch paths
Include paths:
*
Build system version
Version 3
Deploy Hooks
No deploy hooks defined
Variables and Secrets
Define the text, secret or build variables for your project

Type
Name
Value
Secret
SENDGRID_API_KEY
Value encrypted


Plaintext
SENDGRID_FROM_EMAIL
orders@zuwera.store


Secret
SHIPPO_API_KEY
Value encrypted


Plaintext
SHIPPO_FROM_CITY
Los Angeles


Plaintext
SHIPPO_FROM_COUNTRY
US


Plaintext
SHIPPO_FROM_EMAIL
orders@zuwera.store


Plaintext
SHIPPO_FROM_NAME
Zuwera


Plaintext
SHIPPO_FROM_STATE
CA


Plaintext
SHIPPO_FROM_STREET1
123 Brand St


Plaintext
SHIPPO_FROM_ZIP
90001


Plaintext
SITE_URL
https://zuwera.store


Secret
STRIPE_SECRET_KEY
Value encrypted


Secret
STRIPE_WEBHOOK_SECRET
Value encrypted


Secret
SUPABASE_SERVICE_KEY
Value encrypted


Plaintext
SUPABASE_URL
https://ebrqmtghprdxwjgnuqsm.supabase.co


Bindings
Define the set of resources available to your Pages Functions


Configure ways to interact with storage, databases, AI and more from your Worker
Runtime
Define the runtime configuration for your Pages Functions

Placement
Default
Compatibility date
Sep 23, 2024
Compatibility flags
nodejs_compat
Fail open/closed
Fail open
General
Name
zuwera-store
Notifications
Subscribe to specific events by adding a notification to your project
Access policy
Control access to preview deployments with Cloudflare Access.
Permanently delete this Pages project including all deployments, assets, functions and configurations associated with it.
Support
System status
Careers
Terms of Use
Report Security Issues
Privacy Policy
A blue and white pill with a checkmark and an x, representing privacy choicesYour Privacy Choices
© 2026 Cloudflare, Inc.
Need more help?

Good evening.
What are we doing today?


Transfer a domain
Walk me through the process

Durable Objects
Explain how they work

Domain settings
Show my configuration

Find my account ID
Locate account and zone IDs

Orange vs Gray Cloud
What is the difference?
Chats are recorded to improve the service and are processed in accordance with our Privacy Policy.

What can we help you with?
    btn.disabled = false;
    btn.textContent = 'Update Review';
  }
  setStarSelection(rating);
  document.getElementById('review-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
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
  if (!_sb || typeof _user === 'undefined' || !_user) { errEl.textContent = 'Please sign in to leave a review.'; return; }

  btn.disabled    = true;
  btn.textContent = 'Submitting…';

  const reviewerName = _user.user_metadata?.full_name
    || _user.email?.split('@')[0]
    || 'Anonymous';

  let error;
  if (_reviewIdToEdit) {
    const res = await _sb.from('reviews').update({
      rating: _reviewRating,
      body:   body || null
    }).eq('id', _reviewIdToEdit);
    error = res.error;
  } else {
    const res = await _sb.from('reviews').insert({
      user_id:       _user.id,
      product_id:    _reviewProductId,
      rating:        _reviewRating,
      body:          body || null,
      reviewer_name: reviewerName,
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
  showToast('Review submitted — thank you!');

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
  if (e.target === e.currentTarget) {
    document.getElementById('review-modal').classList.remove('open');
    document.body.style.overflow = '';
  }
});
document.getElementById('review-modal-close').addEventListener('click', () => {
  document.getElementById('review-modal').classList.remove('open');
  document.body.style.overflow = '';
});
