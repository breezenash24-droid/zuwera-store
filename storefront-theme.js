(function() {
  'use strict';

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
    try { localStorage.setItem('zw_theme_mode', resolved); } catch(_) {}
    window.dispatchEvent(new CustomEvent('zw-theme-applied', { detail: { mode: resolved } }));
  }

  // CSS selectors for each section override target (must match SECTION_DEFS in admin.html)
  var SECTION_SELECTORS = {
    'logo':         '.flogo, .nav-logo span, .zw-nav-logo span',
    'nav':          '.nbtn, .mobile-nav-link, .zw-mobile-primary-link',
    'announce':     '#announcementText',
    'hero-title':   '.hero-h1',
    'hero-sub':     '.hero-sub',
    'sec-head':     '.sec-head h2',
    'product-name': '.pcard-name',
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

      if (roles.head && roles.head.stack) {
        vars['--font-head'] = roles.head.stack;
        vars['--font-display'] = roles.head.stack;
        vars['--fw'] = roles.head.stack;
        if (roles.head.url) urls.push(roles.head.url);
      }
      if (roles.body && roles.body.stack) {
        vars['--font-body'] = roles.body.stack;
        vars['--fb'] = roles.body.stack;
        if (roles.body.url) urls.push(roles.body.url);
      }
      if (roles.mono && roles.mono.stack) {
        vars['--font-mono'] = roles.mono.stack;
        vars['--fm'] = roles.mono.stack;
        if (roles.mono.url) urls.push(roles.mono.url);
      }

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
        var headUrl = LEGACY_FONT_URLS[fonts.head] || _buildGoogleFontUrl(fonts.head);
        urls.push(headUrl);
      }
      if (fonts.body && fonts.body !== 'Barlow') {
        var bodyStack = LEGACY_FONT_STACKS[fonts.body] || ("'" + fonts.body + "', sans-serif");
        vars['--font-body'] = bodyStack;
        vars['--fb'] = bodyStack;
        var bodyUrl = LEGACY_FONT_URLS[fonts.body] || _buildGoogleFontUrl(fonts.body);
        urls.push(bodyUrl);
      }
      if (fonts.mono && fonts.mono !== 'IBM Plex Mono') {
        var monoStack = LEGACY_FONT_STACKS[fonts.mono] || ("'" + fonts.mono + "', monospace");
        vars['--font-mono'] = monoStack;
        vars['--fm'] = monoStack;
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

  async function loadSiteSettings() {
    try {
      var controller = new AbortController();
      var timeoutId = setTimeout(function() { controller.abort(); }, 5000);
      var response = await fetch(
        SUPABASE_URL + '/rest/v1/site_settings?key=in.(theme,brand,fonts)&select=key,value',
        {
          cache: 'no-store',
          signal: controller.signal,
          headers: {
            apikey: SUPABASE_ANON,
            Authorization: 'Bearer ' + SUPABASE_ANON
          }
        }
      );
      clearTimeout(timeoutId);
      if (!response.ok) return;
      var rows = await response.json();

      rows.forEach(function(row) {
        if (row.key === 'theme') {
          var mode = row.value && row.value.mode === 'dark' ? 'dark'
                   : row.value && row.value.mode === 'super-light' ? 'super-light' : 'light';
          applyThemeMode(mode);
        }
        if (row.key === 'brand') {
          var faviconUrl = row.value && row.value.favicon;
          if (faviconUrl && window.__zwApplyFavicon) {
            window.__zwApplyFavicon(faviconUrl);
          }
        }
        if (row.key === 'fonts') {
          applyStorefrontFonts(row.value);
        }
      });
    } catch (_) {
      if (window.__zwSyncThemeColor) window.__zwSyncThemeColor();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadSiteSettings);
  } else {
    loadSiteSettings();
  }

  window.addEventListener('pageshow', function(e) {
    if (e.persisted) {
      var mode = 'dark';
      try { mode = localStorage.getItem('zw_theme_mode') || 'dark'; } catch(_) {}
      applyThemeMode(mode);
    }
  });

  if ('serviceWorker' in navigator) {
    (function clearStaleServiceWorkers() {
      var hadController = !!navigator.serviceWorker.controller;
      var clearRegistrations = navigator.serviceWorker.getRegistrations
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

      Promise.all([clearRegistrations, clearCaches])
        .then(function() {
          if (!hadController) return;
          try {
            if (sessionStorage.getItem('zw_sw_clear_reload')) return;
            sessionStorage.setItem('zw_sw_clear_reload', '1');
          } catch (_) {}
          window.location.reload();
        })
        .catch(function() {});
    })();
  }
})();
