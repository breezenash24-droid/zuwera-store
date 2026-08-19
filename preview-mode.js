/* ────────────────────────────────────────────────────────────────────────────
   preview-mode.js — view unpublished storefront changes on the real site.

   An admin presses "Preview unpublished" in the admin or the page builder. That
   mints a short-lived signed token (/api/preview-token, admin + builder_edit
   only) and opens the storefront with ?zwpreview=<token>.

   This module spots that parameter, fetches the DRAFT config for it
   (/api/preview-config, which verifies the token server-side), and hands it to
   the page before the normal render runs. So a preview is the real storefront
   drawing real draft data — not a second renderer that could disagree with what
   publishing will actually produce.

   Two things it deliberately does NOT do:
     • It never writes anything. A preview cannot change what is published.
     • It never persists the token. Close the tab and the preview is gone; the
       link itself expires on its own.

   window.__zwPreviewReady is a promise every consumer awaits — it resolves to
   the draft settings, or null when there is no preview. Resolving to null (and
   never rejecting) means a normal page load is not slowed down or broken by
   this file: consumers await a promise that is already settled.
   ──────────────────────────────────────────────────────────────────────────── */
/* ── THE PUBLISHED VALUE IS HELD UNTIL THE DRAFT HAS HAD ITS SAY ────────────
 *
 * Every module that can show draft content has the same shape: apply what is
 * cached, apply what the server publishes, and apply the draft when it turns
 * up. On the real storefront that order is right — the cached and published
 * values agree, so painting the cache immediately avoids a reflow.
 *
 * IN A PREVIEW THEY DO NOT AGREE. The whole reason anyone is looking at the
 * canvas is that the draft differs from what is live, and the published value
 * is the one that arrives FIRST because it is local, while the draft has to be
 * fetched or posted in. So the preview rendered the published site and then
 * corrected itself, on every single load — which is not a flash, it is the old
 * version of the page being shown to someone whose job is reviewing the new
 * one.
 *
 * header-layouts.js solved this for itself and the fix was right, but it stayed
 * there: the nav, the announcement bar, page copy, the bag panel and the
 * sections all still painted published-then-draft. One gate, so the answer
 * cannot be right in one module and missing in five.
 *
 * The rule is three lines long:
 *   · outside a preview, nothing changes at all;
 *   · inside one, a published value is HELD, not applied;
 *   · a draft releases the hold — by replacing it, or, if the draft turns out
 *     to carry nothing, by letting the held value through after all.
 *
 * A draft that never arrives must not leave the canvas blank, so the builder's
 * postMessage path arms a timer. The ?zwpreview= path needs none: its promise
 * always settles.
 */
window.ZWPreviewHold = function (apply) {
  var preview = !!(window.__ZW_BUILDER_PREVIEW__
    || (window.__zwPreviewReady && window.__zwPreviewReady.then));
  var held = null, has = false, settled = false, draftWon = false;

  function release() {
    if (!has) return;
    var v = held; has = false; held = null;
    apply(v);
  }
  /* Long enough that a message sent on load wins in practice; short enough that
     nobody reads the wrong page for long. Only the builder needs it — a preview
     LINK resolves through a promise that always settles. */
  if (preview && window.__ZW_BUILDER_PREVIEW__) {
    setTimeout(function () { if (!settled) { settled = true; release(); } }, 1500);
  }

  return {
    preview: preview,
    /* What the cache and the server say. Held in a preview until a draft has
       answered, and ignored entirely once one has — a published value arriving
       late must never paint over the draft it was standing in for. */
    published: function (v) {
      if (preview && draftWon) return;
      if (preview && !settled) { held = v; has = true; return; }
      apply(v);
    },
    /* The draft. null or undefined means "there is no draft for this" — which
       is not the same as an empty draft, and is why the held value is released
       rather than replaced.
       ── EXCEPT IN THE BUILDER, and this cost a measurement to find. Every
       module asks the preview-LINK promise for a draft, and on a ?builder=1
       load that promise resolves to null immediately, because there is no link
       — there is a postMessage still on its way. Treating that null as "no
       draft" settled the gate and released the published value about 200ms
       before the message arrived, which is precisely the old-page-first flash
       the gate exists to remove, reintroduced by the gate itself. In the
       builder only the message, or the timer, may settle it. */
    draft: function (v) {
      if (v === null || v === undefined) {
        if (window.__ZW_BUILDER_PREVIEW__) return;
        settled = true; release(); return;
      }
      settled = true; draftWon = true; has = false; held = null;
      apply(v);
    },
  };
};

(function () {
  'use strict';

  var SESSION_KEY = 'zw_preview_token';

  var token = '';
  var fromUrl = false;
  try {
    token = new URLSearchParams(location.search).get('zwpreview') || '';
    fromUrl = !!token;
    // Carried in the tab rather than the address bar once we have seen it, so a
    // reload or a link that lost the parameter still resolves to the same
    // preview.
    if (!token) token = sessionStorage.getItem(SESSION_KEY) || '';
  } catch (_) {}

  window.__zwPreview = null;
  if (!token) { window.__zwPreviewReady = Promise.resolve(null); return; }

  // Keep the token out of anything that records URLs. It is short-lived and
  // low-power, but there is no reason for it to end up in an analytics payload
  // or a referrer header.
  window.__zwPreviewActive = true;
  // Other modules that need it (the product page fetches its own draft config)
  // read it here rather than from the URL, which is about to lose it.
  window.__zwPreviewToken = token;

  /* Take the token out of the address bar the moment it has been read.
     A preview link is a bearer link — whoever holds the string sees the drafts,
     from any device, until it expires. That is the deal, and it is what makes it
     shareable. What is NOT part of the deal is the working token sitting in the
     address bar of every page for the whole session, ready to be copied,
     screenshotted, or left in browser history: the commonest way one of these
     escapes is not an attack, it is someone pasting the URL they were looking at.
     It moves to sessionStorage, which lives in this tab and dies with it. */
  if (fromUrl) {
    try { sessionStorage.setItem(SESSION_KEY, token); } catch (_) {}
    try {
      var clean = new URL(location.href);
      clean.searchParams.delete('zwpreview');
      history.replaceState(history.state, '', clean.pathname + clean.search + clean.hash);
    } catch (_) {}
  }

  window.__zwPreviewReady = fetch('/api/preview-config?token=' + encodeURIComponent(token), { cache: 'no-store' })
    .then(function (r) { return r.json().catch(function () { return null; }); })
    .then(function (data) {
      if (!data || !data.ok || !data.settings) {
        banner('This preview link is not valid or has expired.', true);
        return null;
      }
      window.__zwPreview = data.settings;
      banner('Previewing unpublished changes', false, data.expiresAt);
      return data.settings;
    })
    .catch(function () {
      banner('Could not load the preview.', true);
      return null;
    });

  /**
   * A bar across the top saying this is not the live site. Without it a draft
   * homepage is indistinguishable from the published one, and someone will
   * eventually report a "bug" that is really an unpublished change — or worse,
   * assume something shipped when it hasn't.
   */
  function banner(text, isError, expiresAt) {
    function build() {
      if (document.getElementById('zw-preview-bar')) return;
      // Admin-chosen colour (Admin → Settings → Preview bar). Falls back to a
      // blue that is obviously not part of the storefront's palette.
      var colour = isError ? '#7f1d1d' : '#1d4ed8';
      try {
        var saved = localStorage.getItem('zw_preview_bar_colour');
        if (!isError && saved && /^#[0-9a-f]{3,8}$/i.test(saved)) colour = saved;
      } catch (_) {}

      var bar = document.createElement('div');
      bar.id = 'zw-preview-bar';
      bar.setAttribute('role', 'status');
      bar.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0',
        // Above everything, including the announcement bar (230) and the site's
        // own modals — the whole point is to review the real page furniture, so
        // the bar must never be the thing hiding it.
        'z-index:2147483000',
        'display:flex', 'align-items:center', 'justify-content:center', 'gap:1rem',
        'padding:.5rem 1rem', 'box-sizing:border-box',
        'background:' + colour, 'color:#fff',
        "font-family:var(--zw-font-mono,'IBM Plex Mono',monospace)",
        'font-size:.68rem', 'letter-spacing:.14em', 'text-transform:uppercase',
        'box-shadow:0 1px 8px rgba(0,0,0,.3)',
        'transition:transform .25s ease',
      ].join(';');

      var label = document.createElement('span');
      label.textContent = text;
      bar.appendChild(label);

      if (expiresAt) {
        var when = document.createElement('span');
        when.style.cssText = 'opacity:.7;text-transform:none;letter-spacing:.06em';
        try {
          when.textContent = 'link expires ' + new Date(expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        } catch (_) {}
        bar.appendChild(when);
      }

      var exit = document.createElement('a');
      exit.href = location.pathname;          // same page, no token
      exit.textContent = 'Exit preview';
      // Drop the tab's copy too, or "exit" would only last until the next load.
      exit.addEventListener('click', function () {
        try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
      });
      exit.style.cssText = 'color:#fff;text-decoration:underline;text-underline-offset:3px';
      bar.appendChild(exit);

      document.body.appendChild(bar);

      // Collapse to a tab. The bar sits above the announcement bar and the nav
      // by design, which is exactly what you want until you are trying to LOOK
      // at the announcement bar — so it folds away to a small handle and comes
      // back on a click. The choice is remembered for the session, so it stays
      // out of the way as you click through the site.
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.id = 'zw-preview-tab';
      tab.setAttribute('aria-label', 'Show preview banner');
      tab.textContent = '▾ PREVIEW';
      tab.style.cssText = [
        'position:fixed', 'top:0', 'left:50%', 'transform:translateX(-50%)',
        'z-index:2147483001', 'display:none', 'border:0', 'cursor:pointer',
        'padding:.2rem .8rem', 'border-radius:0 0 6px 6px',
        'background:' + colour, 'color:#fff',
        "font-family:var(--zw-font-mono,'IBM Plex Mono',monospace)",
        'font-size:.6rem', 'letter-spacing:.14em',
      ].join(';');
      document.body.appendChild(tab);

      function setCollapsed(on) {
        bar.style.transform = on ? 'translateY(-100%)' : '';
        tab.style.display = on ? 'block' : 'none';
        // Give the page its space back when the bar is away, so what sits under
        // it can be judged at its real position.
        document.body.style.paddingTop = on ? '' : bar.offsetHeight + 'px';
        document.documentElement.style.setProperty('scroll-padding-top', on ? '0px' : bar.offsetHeight + 'px');
        try { sessionStorage.setItem('zw_preview_collapsed', on ? '1' : '0'); } catch (_) {}
      }

      var hide = document.createElement('button');
      hide.type = 'button';
      hide.setAttribute('aria-label', 'Hide preview banner');
      hide.textContent = '▴ HIDE';
      hide.style.cssText = 'background:transparent;border:1px solid rgba(255,255,255,.4);color:#fff;font:inherit;cursor:pointer;padding:.1rem .5rem;border-radius:3px';
      hide.addEventListener('click', function () { setCollapsed(true); });
      bar.appendChild(hide);
      tab.addEventListener('click', function () { setCollapsed(false); });

      // Push the page down rather than covering the header, unless the admin
      // already folded it away earlier in this session.
      var wasCollapsed = false;
      try { wasCollapsed = sessionStorage.getItem('zw_preview_collapsed') === '1'; } catch (_) {}
      setCollapsed(wasCollapsed);
    }
    if (document.body) build();
    else document.addEventListener('DOMContentLoaded', build, { once: true });
  }

  /**
   * Keep the preview alive across in-site navigation, so an admin can click
   * from the draft homepage into a draft landing page without the token being
   * dropped and the site silently reverting to published content mid-review.
   */
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.id === 'zw-preview-exit') return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#' || /^(mailto:|tel:|javascript:)/i.test(href)) return;
    var url;
    try { url = new URL(a.href, location.href); } catch (_) { return; }
    if (url.origin !== location.origin) return;              // leaving the site
    if (url.searchParams.get('zwpreview')) return;           // already carried
    if (a.textContent === 'Exit preview') return;            // the one link that must drop it
    url.searchParams.set('zwpreview', token);
    a.setAttribute('href', url.pathname + url.search + url.hash);
  }, true);
})();
