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

  window.__zwApplyAdminTheme = applyThemeMode;
  window.__zwSyncThemeColor = function() {
    applyThemeMode(document.body && document.body.classList.contains('light-mode') ? 'light' : 'dark');
  };

  async function loadSiteSettings() {
    try {
      var response = await fetch(
        SUPABASE_URL + '/rest/v1/site_settings?key=in.(theme,brand)&select=key,value',
        {
          cache: 'no-store',
          headers: {
            apikey: SUPABASE_ANON,
            Authorization: 'Bearer ' + SUPABASE_ANON
          }
        }
      );
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
})();
