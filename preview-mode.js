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
(function () {
  'use strict';

  var token = '';
  try { token = new URLSearchParams(location.search).get('zwpreview') || ''; } catch (_) {}

  window.__zwPreview = null;
  if (!token) { window.__zwPreviewReady = Promise.resolve(null); return; }

  // Keep the token out of anything that records URLs. It is short-lived and
  // low-power, but there is no reason for it to end up in an analytics payload
  // or a referrer header.
  window.__zwPreviewActive = true;

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
      var bar = document.createElement('div');
      bar.id = 'zw-preview-bar';
      bar.setAttribute('role', 'status');
      bar.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483000',
        'display:flex', 'align-items:center', 'justify-content:center', 'gap:1rem',
        'padding:.5rem 1rem', 'box-sizing:border-box',
        'background:' + (isError ? '#7f1d1d' : '#1d4ed8'), 'color:#fff',
        "font-family:var(--zw-font-mono,'IBM Plex Mono',monospace)",
        'font-size:.68rem', 'letter-spacing:.14em', 'text-transform:uppercase',
        'box-shadow:0 1px 8px rgba(0,0,0,.3)',
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
      exit.style.cssText = 'color:#fff;text-decoration:underline;text-underline-offset:3px';
      bar.appendChild(exit);

      document.body.appendChild(bar);
      // Push the page down rather than covering the header. The announcement
      // bar and the nav are both fixed to the top, so they would sit under this
      // otherwise.
      document.documentElement.style.setProperty('scroll-padding-top', bar.offsetHeight + 'px');
      document.body.style.paddingTop = bar.offsetHeight + 'px';
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
