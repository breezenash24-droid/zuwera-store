(function() {
  'use strict';

  // Immediately set notch bar color from localStorage to minimize theme FOUC
  try {
      var _nm = localStorage.getItem('zw_theme_mode') || 'dark';
      document.documentElement.style.setProperty('--zw-notch-bar',
        _nm === 'super-light' ? '#FFFFFF' : _nm === 'light' ? '#F0EEE9' : '#09090b');
  } catch(_) {}

  var SUPABASE_URL = window.SUPABASE_URL || window.SUPA_URL || 'https://qfgnrsifcwdubkolsgsq.supabase.co';
  var SUPABASE_ANON = window.SUPABASE_ANON || window.SUPA_ANON || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';

  function applyThemeMode(mode) {
    var resolved = mode === 'dark' ? 'dark' : mode === 'super-light' ? 'super-light' : 'light';
    if (!document.body) return;
    document.body.classList.toggle('light-mode', resolved !== 'dark');
    document.body.classList.toggle('super-light-mode', resolved === 'super-light');
    var color = resolved === 'dark' ? '#09090b' : resolved === 'super-light' ? '#FFFFFF' : '#F0EEE9';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', color);
    document.documentElement.style.backgroundColor = color;
    document.documentElement.style.setProperty('--zw-notch-bar', color);
    try {
      // Don't persist while inside the builder preview iframe — the preview shares
      // localStorage with the live homepage (same origin), so remembering a
      // previewed theme here would "stick" the live homepage to it. The live
      // homepage sets zw_homepage_theme_mode itself from the published config.
      if (!window.__ZW_BUILDER_PREVIEW__) {
        var key = window.__zwPageBuilderActive ? 'zw_homepage_theme_mode' : 'zw_theme_mode';
        localStorage.setItem(key, resolved);
      }
    } catch(_) {}
    window.dispatchEvent(new CustomEvent('zw-theme-applied', { detail: { mode: resolved } }));
  }

  // CSS selectors for each section override target (must match SECTION_DEFS in admin.html)
  // This map is what actually reaches the page. admin.html's SECTION_DEFS carries
  // a cssSel copy for its own preview, and the two MUST stay identical — they had
  // drifted: 'nav' listed .nav-link there and not here, so Typography → Header
  // Categories saved a setting that never touched the header. Anything added to one
  // has to be added to the other.
  //
  // The injected rules are !important, which matters: storefront-cohesion.css:195
  // locks :is(.nbtn,…,.nav-link,…) to var(--zw-font-mono) !important, and only an
  // equally-important rule injected later can override it.
  var SECTION_SELECTORS = {
    'logo':         '.flogo, .nav-logo span, .zw-nav-logo span',
    'nav':          '.nav-link, .nbtn, .mobile-nav-link, .zw-mobile-primary-link, .zw-macc-toggle',
    'subnav':       '.zw-mega-col a, .zw-mega-col h4, .zw-macc-panel a',
    // The two header panels. Their text is built by storefront-features.js, so it
    // never inherited any of the page's font settings — these are the only handle.
    'bag':          '.zwf-bag-hd h2, .zwf-bag-nm, .zwf-bag-meta, .zwf-bag-price, .zwf-bag-review, .zwf-bag-links h3, .zwf-bag-link, .zwf-bag-empty',
    'search':       '.zwf-search-input, .zwf-search-input::placeholder, .zwf-search-meta, .zwf-sr-nm, .zwf-sr-meta',
    'announce':     '#announcementText',
    'hero-title':   '.hero-h1',
    'hero-sub':     '.hero-sub',
    'sec-head':     '.sec-head h2',
    'product-name': '.pcard-name',
    // The product PAGE title is .product-title — a different class from the card's
    // .pcard-name, so "Product Names" never touched it and nothing else did either.
    'product-title': '.product-title, .product-subtitle',
    'product-detail': '.accordion-header, .accordion-body, .colorway-section .section-label',
    // Modals build their own markup, so none of the page's type reached them.
    'modal':        '.zwf-modal-title, .zwf-modal-sub, .zwf-fit-btn, .zwf-fit-go, .zwf-fit-again, .quick-add-option-head, .quick-add-product-meta, .quick-add-empty-option',
    'price':        '.pcard-price, .pcard-cat',
    'btn':          '.add-to-cart-btn, .pcard-add-btn, #checkout-btn, #pay-submit',
    'footer':       '.fcopy, .flinks a, .fig',
  };

  function _loadFontUrl(url) {
    var id = 'gf-' + btoa(url).replace(/[^a-z0-9]/gi, '').substring(0, 32);
    if (document.getElementById(id)) return;
    var link = document.createElement('link');
    link.id = id; link.rel = 'stylesheet'; link.href = url;
    document.head.appendChild(link);
  }

  function _buildGoogleFontUrl(family) {
    return 'https://fonts.googleapis.com/css2?family=' + family.replace(/ /g, '+') + ':wght@300;400;500;600;700&display=swap';
  }

  // Legacy flat-format font names → Google Font URLs
  var LEGACY_FONT_URLS = {
    'Oswald':           'https://fonts.googleapis.com/css2?family=Oswald:wght@300;400;500;600;700&display=swap',
    'Rajdhani':         'https://fonts.googleapis.com/css2?family=Rajdhani:wght@300;400;500;600;700&display=swap',
    'Bebas Neue':       'https://fonts.googleapis.com/css2?family=Bebas+Neue:wght@400&display=swap',
    'Anton':            'https://fonts.googleapis.com/css2?family=Anton:wght@400&display=swap',
    'League Gothic':    'https://fonts.googleapis.com/css2?family=League+Gothic:wght@400&display=swap',
    'Michroma':         'https://fonts.googleapis.com/css2?family=Michroma:wght@400&display=swap',
    'Exo 2':            'https://fonts.googleapis.com/css2?family=Exo+2:wght@300;400;500;600;700&display=swap',
    'Inter':            'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap',
    'DM Sans':          'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap',
    'Outfit':           'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap',
    'Manrope':          'https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700&display=swap',
    'Plus Jakarta Sans':'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap',
    'Space Mono':       'https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap',
    'JetBrains Mono':   'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap',
    'Courier Prime':    'https://fonts.googleapis.com/css2?family=Courier+Prime:wght@400;700&display=swap',
    'Roboto Mono':      'https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@300;400;500;600;700&display=swap',
  };

  var LEGACY_FONT_STACKS = {
    'Barlow Condensed': "'Barlow Condensed', sans-serif",
    'Oswald':           "'Oswald', sans-serif",
    'Rajdhani':         "'Rajdhani', sans-serif",
    'Bebas Neue':       "'Bebas Neue', sans-serif",
    'Anton':            "'Anton', sans-serif",
    'League Gothic':    "'League Gothic', sans-serif",
    'Michroma':         "'Michroma', sans-serif",
    'Exo 2':            "'Exo 2', sans-serif",
    'Barlow':           "'Barlow', sans-serif",
    'Inter':            "'Inter', sans-serif",
    'DM Sans':          "'DM Sans', sans-serif",
    'Outfit':           "'Outfit', sans-serif",
    'Manrope':          "'Manrope', sans-serif",
    'Plus Jakarta Sans':"'Plus Jakarta Sans', sans-serif",
    'IBM Plex Mono':    "'IBM Plex Mono', monospace",
    'Space Mono':       "'Space Mono', monospace",
    'JetBrains Mono':   "'JetBrains Mono', monospace",
    'Courier Prime':    "'Courier Prime', monospace",
    'Roboto Mono':      "'Roboto Mono', monospace",
  };

  function applyStorefrontFonts(fonts) {
    if (!fonts) return;

    var root = document.documentElement;
    var vars = {};
    var urls = [];
    var cssParts = [];

    // ── New format: { roles, sections, custom } ──
    if (fonts.roles) {
      var roles = fonts.roles;

      // --zw-font-* is NOT optional. storefront-cohesion.css reads those names in
      // 14 rules — and they're the !important ones that decide .nav-link, .nbtn,
      // .pcard-name, .pcard-price, .pcard-cat. Setting only the legacy --fw/--fb/--fm
      // meant a role change here landed on names those rules never read, so picking
      // a new font in Admin → Typography visibly did nothing to half the page.
      // storefront.js's theme path already sets both; this one didn't.
      if (roles.head && roles.head.stack) {
        vars['--font-head'] = roles.head.stack;
        vars['--font-display'] = roles.head.stack;
        vars['--fw'] = roles.head.stack;
        vars['--zw-font-head'] = roles.head.stack;
        if (roles.head.url) urls.push(roles.head.url);
      }
      if (roles.body && roles.body.stack) {
        vars['--font-body'] = roles.body.stack;
        vars['--fb'] = roles.body.stack;
        vars['--zw-font-body'] = roles.body.stack;
        if (roles.body.url) urls.push(roles.body.url);
      }
      if (roles.mono && roles.mono.stack) {
        vars['--font-mono'] = roles.mono.stack;
        vars['--fm'] = roles.mono.stack;
        vars['--zw-font-mono'] = roles.mono.stack;
        if (roles.mono.url) urls.push(roles.mono.url);
      }

      // Heading treatment — now owned by Admin → Typography, and applied here, which
      // means every page. It used to live only in the builder's "Global Theme" panel,
      // applied by storefront.js: a file only index.html loads. So heading weight and
      // style reached the homepage and nothing else, and setting a font meant using
      // two panels. Fallbacks are the values those rules already hardcoded, so an
      // older saved row (no headingWeight key) renders exactly as before.
      vars['--zw-fw-head'] = fonts.headingWeight || '900';
      vars['--zw-fst-head'] = fonts.headingStyle || 'italic';
      vars['--zw-head-tracking'] = fonts.headingTracking || 'normal';
      vars['--zw-head-case'] = fonts.headingCase || 'uppercase';
      vars['--zw-body-leading'] = fonts.bodyLineHeight || '1.75';

      // Custom fonts
      if (Array.isArray(fonts.custom)) {
        fonts.custom.forEach(function(f) {
          if (f && f.url) urls.push(f.url);
        });
      }

      // Section overrides → CSS injection
      if (fonts.sections) {
        Object.keys(fonts.sections).forEach(function(sectionId) {
          var override = fonts.sections[sectionId];
          if (!override || !override.stack) return;
          var sel = SECTION_SELECTORS[sectionId];
          if (!sel) return;
          cssParts.push(sel + '{font-family:' + override.stack + '!important}');
          if (override.url) urls.push(override.url);
        });
      }

    } else {
      // ── Legacy flat format: { head: 'Name', body: 'Name', mono: 'Name' } ──
      if (fonts.head && fonts.head !== 'Barlow Condensed') {
        var headStack = LEGACY_FONT_STACKS[fonts.head] || ("'" + fonts.head + "', sans-serif");
        vars['--font-head'] = headStack;
        vars['--font-display'] = headStack;
        vars['--fw'] = headStack;
        vars['--zw-font-head'] = headStack;   // cohesion's !important rules read this name
        var headUrl = LEGACY_FONT_URLS[fonts.head] || _buildGoogleFontUrl(fonts.head);
        urls.push(headUrl);
      }
      if (fonts.body && fonts.body !== 'Barlow') {
        var bodyStack = LEGACY_FONT_STACKS[fonts.body] || ("'" + fonts.body + "', sans-serif");
        vars['--font-body'] = bodyStack;
        vars['--fb'] = bodyStack;
        vars['--zw-font-body'] = bodyStack;
        var bodyUrl = LEGACY_FONT_URLS[fonts.body] || _buildGoogleFontUrl(fonts.body);
        urls.push(bodyUrl);
      }
      if (fonts.mono && fonts.mono !== 'IBM Plex Mono') {
        var monoStack = LEGACY_FONT_STACKS[fonts.mono] || ("'" + fonts.mono + "', monospace");
        vars['--font-mono'] = monoStack;
        vars['--fm'] = monoStack;
        vars['--zw-font-mono'] = monoStack;
        var monoUrl = LEGACY_FONT_URLS[fonts.mono] || _buildGoogleFontUrl(fonts.mono);
        urls.push(monoUrl);
      }
    }

    // Apply CSS variables
    Object.keys(vars).forEach(function(k) { root.style.setProperty(k, vars[k]); });

    // Load font stylesheets (deduplicated)
    var seen = {};
    urls.forEach(function(u) {
      if (!u || seen[u]) return;
      seen[u] = true;
      _loadFontUrl(u);
    });

    // Inject section overrides
    var css = cssParts.join('');
    var styleEl = document.getElementById('zw-font-overrides');
    if (css) {
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'zw-font-overrides';
        document.head.appendChild(styleEl);
      }
      styleEl.textContent = css;
    } else if (styleEl) {
      styleEl.textContent = '';
    }

    // Save to localStorage for FOUC prevention on next load
    try {
      localStorage.setItem('zw_fonts', JSON.stringify({ vars: vars, urls: Object.keys(seen), css: css }));
    } catch(_) {}
  }

  window.__zwApplyAdminTheme = applyThemeMode;
  window.__zwSyncThemeColor = function() {
    var m = document.body && document.body.classList.contains('super-light-mode') ? 'super-light'
          : document.body && document.body.classList.contains('light-mode') ? 'light' : 'dark';
    applyThemeMode(m);
  };

  function applySettingsRows(rows) {
    rows.forEach(function(row) {
      if (row.key === 'theme') {
        var isHomepage = window.location.pathname === '/' || window.location.pathname.endsWith('/index.html') || window.location.pathname.endsWith('/');
        if (isHomepage || window.__ZW_BUILDER_PREVIEW__) return;
        // site_settings.theme (the admin appearance toggle) is authoritative for
        // the storefront. Apply the server value directly so theme changes reach
        // returning visitors — previously a cached zw_theme_mode shadowed the
        // server value and permanently pinned whatever theme was seen first.
        // applyThemeMode rewrites zw_theme_mode to match, keeping reloads FOUC-free.
        var mode = row.value && row.value.mode === 'dark' ? 'dark'
                 : row.value && row.value.mode === 'super-light' ? 'super-light' : 'light';
        applyThemeMode(mode);
      }
      if (row.key === 'brand') {
        var faviconUrl = row.value && row.value.favicon;
        if (faviconUrl && window.__zwApplyFavicon) window.__zwApplyFavicon(faviconUrl);
      }
      if (row.key === 'fonts') {
        applyStorefrontFonts(row.value);
      }
      if (row.key === 'early_access') {
        window.__zwEarlyAccess = row.value || null;
      }
    });
  }

  // Early-access gate: when the admin enables it (Settings → Early Access),
  // only signed-in members can add to bag until the window ends. Checked at
  // add-to-bag time by product.html and quick-add-modal.js.
  window.zwEarlyAccessBlocked = function() {
    var ea = window.__zwEarlyAccess;
    if (!ea || !ea.enabled) return false;
    if (ea.ends_at && Date.now() > new Date(ea.ends_at).getTime()) return false;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && /^(?:zuwera-auth|sb-[a-z0-9-]+-auth-token)/.test(k) && localStorage.getItem(k)) return false; // signed in
      }
    } catch (_) {}
    return true;
  };

  // Expose so index.html's loadSiteSettings can feed rows directly (avoids duplicate fetch)
  window.__zwApplyThemeRows = applySettingsRows;

  async function loadSiteSettings() {
    // Skip fetch on pages that handle their own settings (e.g. index.html)
    if (window.__zwSkipThemeFetch) return;
    // Deduplicate: if another instance of this function is already in-flight, reuse its promise
    if (window.__zwThemePromise) { try { await window.__zwThemePromise; } catch(_) {} return; }

    window.__zwThemePromise = (async function() {
      try {
        var controller = new AbortController();
        var timeoutId = setTimeout(function() { controller.abort(); }, 5000);
        var response = await fetch(
          SUPABASE_URL + '/rest/v1/site_settings?key=in.(theme,brand,fonts)&select=key,value',
          {
            cache: 'no-store',
            signal: controller.signal,
            headers: { apikey: SUPABASE_ANON, Authorization: 'Bearer ' + SUPABASE_ANON }
          }
        );
        clearTimeout(timeoutId);
        if (!response.ok) return;
        var rows = await response.json();
        applySettingsRows(rows);
      } catch (_) {
        if (window.__zwSyncThemeColor) window.__zwSyncThemeColor();
      } finally {
        window.__zwThemePromise = null;
      }
    })();

    try { await window.__zwThemePromise; } catch(_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadSiteSettings);
  } else {
    loadSiteSettings();
  }

  window.addEventListener('pageshow', function(e) {
    if (e.persisted) {
      var mode = 'dark';
      try {
        var isHomepage = window.location.pathname === '/' || window.location.pathname.endsWith('/index.html') || window.location.pathname.endsWith('/');
        var key = isHomepage ? 'zw_homepage_theme_mode' : 'zw_theme_mode';
        mode = localStorage.getItem(key) || localStorage.getItem('zw_theme_mode') || 'dark';
      } catch(_) {}
      applyThemeMode(mode);
    }
  });

  if ('serviceWorker' in navigator) {
    (function clearStaleServiceWorkers() {
      var unregisterAll = navigator.serviceWorker.getRegistrations
        ? navigator.serviceWorker.getRegistrations().then(function(registrations) {
            return Promise.all(registrations.map(function(registration) {
              return registration.unregister();
            }));
          })
        : Promise.resolve();
      var clearCaches = window.caches && window.caches.keys
        ? window.caches.keys().then(function(keys) {
            return Promise.all(keys.map(function(key) { return window.caches.delete(key); }));
          })
        : Promise.resolve();

      // No SW is controlling this page → it's already fresh from the network. Just
      // tidy up any dormant registration/caches and reset the retry counter.
      if (!navigator.serviceWorker.controller) {
        unregisterAll; clearCaches;
        try { sessionStorage.removeItem('zw_sw_clear_tries'); } catch (_) {}
        return;
      }

      // A STALE service worker (from an older build of the site — the site no longer
      // ships one) is controlling this page and can serve old cached HTML over the
      // fresh one. Unregister it + wipe every cache, then reload so the page re-reads
      // from the network. Keep retrying until no SW controls the page: a single reload
      // can race the unregister and still be served stale (which stranded people on the
      // old layout). Capped so it can never loop forever.
      var tries = 0;
      try { tries = parseInt(sessionStorage.getItem('zw_sw_clear_tries') || '0', 10) || 0; } catch (_) {}
      if (tries >= 4) return;

      Promise.all([unregisterAll, clearCaches])
        .then(function() {
          try { sessionStorage.setItem('zw_sw_clear_tries', String(tries + 1)); } catch (_) {}
          window.location.reload();
        })
        .catch(function() {});
    })();
  }
})();
