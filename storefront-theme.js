(function() {
  'use strict';

  var SUPABASE_URL = window.SUPABASE_URL || window.SUPA_URL || 'https://qfgnrsifcwdubkolsgsq.supabase.co';
  var SUPABASE_ANON = window.SUPABASE_ANON || window.SUPA_ANON || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';

  function applyThemeMode(mode) {
    var resolved = mode === 'dark' ? 'dark' : 'light';
    if (!document.body) return;
    document.body.classList.toggle('light-mode', resolved === 'light');
    var color = resolved === 'light' ? '#F0EEE9' : '#09090b';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', color);
    document.documentElement.style.backgroundColor = color;
    try { localStorage.setItem('zw_theme_mode', resolved); } catch(_) {}
    window.dispatchEvent(new CustomEvent('zw-theme-applied', { detail: { mode: resolved } }));
  }

  var FONT_STACKS = {
    'Barlow Condensed': "'Barlow Condensed', sans-serif",
    'Oswald':           "'Oswald', sans-serif",
    'Rajdhani':         "'Rajdhani', sans-serif",
    'Bebas Neue':       "'Bebas Neue', sans-serif",
    'Anton':            "'Anton', sans-serif",
    'League Gothic':    "'League Gothic', sans-serif",
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

  function loadGoogleFont(family) {
    var id = 'gf-' + family.replace(/\s+/g, '-').toLowerCase();
    if (document.getElementById(id)) return;
    var link = document.createElement('link');
    link.id = id; link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=' + family.replace(/ /g, '+') + ':wght@300;400;500;600;700&display=swap';
    document.head.appendChild(link);
  }

  function applyStorefrontFonts(fonts) {
    if (!fonts) return;
    var root = document.documentElement;
    if (fonts.head && fonts.head !== 'Barlow Condensed') {
      var headStack = FONT_STACKS[fonts.head] || ("'" + fonts.head + "', sans-serif");
      root.style.setProperty('--font-head', headStack);
      root.style.setProperty('--font-display', headStack);
      root.style.setProperty('--fw', headStack);
      loadGoogleFont(fonts.head);
    }
    if (fonts.body && fonts.body !== 'Barlow') {
      var bodyStack = FONT_STACKS[fonts.body] || ("'" + fonts.body + "', sans-serif");
      root.style.setProperty('--font-body', bodyStack);
      root.style.setProperty('--fb', bodyStack);
      loadGoogleFont(fonts.body);
    }
    if (fonts.mono && fonts.mono !== 'IBM Plex Mono') {
      var monoStack = FONT_STACKS[fonts.mono] || ("'" + fonts.mono + "', monospace");
      root.style.setProperty('--font-mono', monoStack);
      root.style.setProperty('--fm', monoStack);
      loadGoogleFont(fonts.mono);
    }
  }

  window.__zwApplyAdminTheme = applyThemeMode;
  window.__zwSyncThemeColor = function() {
    applyThemeMode(document.body && document.body.classList.contains('light-mode') ? 'light' : 'dark');
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
          var mode = row.value && row.value.mode === 'dark' ? 'dark' : 'light';
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
