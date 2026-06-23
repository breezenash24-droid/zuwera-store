/* ────────────────────────────────────────────────────────────────────────────
   nav-menu.js — admin-editable mega-menu navigation.

   Reads site_settings.nav_menu, an array of top-level items:
     [{ label, url?, columns?: [{ heading?, links: [{ text, url }] }] }]
   • A top item with `columns` opens a hover mega-menu (desktop) / accordion
     (mobile). A top item with just `url` (no columns) is a plain link.
   • Renders the desktop mega-menu into #nav-category-links (homepage) and the
     mobile accordion into #mobile-category-links (every storefront page).
   • Falls back to the page's existing auto/static nav when nav_menu is empty
     (it simply doesn't touch the DOM, and leaves window.__zwCustomNavApplied
     unset so storefront.js's auto-category render still runs on the homepage).
   • Cached in localStorage (zw_nav_menu) for a flash-free first paint.
   CSS lives in storefront-cohesion.css (.zw-navitem / .zw-mega / .zw-macc-*).
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
  var REST = 'https://qfgnrsifcwdubkolsgsq.supabase.co/rest/v1/site_settings?select=value&key=eq.nav_menu';
  var CACHE = 'zw_nav_menu';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // Allow safe link targets only (anchors, absolute/relative paths, full http(s),
  // mailto/tel). Matches by PREFIX so a complete "https://…?a=b&c=d" URL passes.
  function safeUrl(u) {
    u = String(u == null ? '' : u).trim();
    if (!u || u.slice(0, 2) === '//') return '#';                 // protocol-relative
    if (/^(?:javascript|data|vbscript|file):/i.test(u)) return '#'; // dangerous schemes
    if (/^[#/]/.test(u)) return u;                                 // #anchor or /path
    if (/^(?:https?:\/\/|mailto:|tel:)/i.test(u)) return u;        // safe schemes (+ rest)
    if (/^[\w][\w./?=&%#+-]*$/.test(u)) return u;                  // relative, e.g. drop001.html?category=X
    return '#';
  }
  function cols_(item) {
    return Array.isArray(item.columns)
      ? item.columns.filter(function (c) { return c && (c.heading || (c.links && c.links.length)); })
      : [];
  }
  function cached() { try { return JSON.parse(localStorage.getItem(CACHE) || 'null'); } catch (_) { return null; } }

  function renderDesktop(menu) {
    var host = document.getElementById('nav-category-links');
    if (!host) return;
    host.innerHTML = menu.map(function (item) {
      var cols = cols_(item);
      var label = esc(item.label || '');
      var top = item.url
        ? '<a href="' + esc(safeUrl(item.url)) + '" class="nav-link">' + label + '</a>'
        : '<button type="button" class="nav-link zw-navtrigger">' + label + '</button>';
      if (!cols.length) return '<div class="zw-navitem">' + top + '</div>';
      var mega = '<div class="zw-mega">' + cols.map(function (c) {
        var links = (c.links || []).map(function (l) {
          return '<a href="' + esc(safeUrl(l.url)) + '">' + esc(l.text || '') + '</a>';
        }).join('');
        return '<div class="zw-mega-col">' + (c.heading ? '<h4>' + esc(c.heading) + '</h4>' : '') + links + '</div>';
      }).join('') + '</div>';
      return '<div class="zw-navitem zw-has-mega">' + top + mega + '</div>';
    }).join('');
  }

  function renderMobile(menu) {
    var host = document.getElementById('mobile-category-links');
    if (!host) return;
    host.innerHTML = menu.map(function (item) {
      var cols = cols_(item);
      var label = esc(item.label || '');
      if (!cols.length) {
        return '<a href="' + esc(safeUrl(item.url)) + '" class="mobile-nav-link zw-mobile-primary-link">' + label + '</a>';
      }
      var sub = cols.map(function (c) {
        var h = c.heading ? '<p class="zw-macc-head">' + esc(c.heading) + '</p>' : '';
        return h + (c.links || []).map(function (l) {
          return '<a href="' + esc(safeUrl(l.url)) + '" class="zw-macc-link">' + esc(l.text || '') + '</a>';
        }).join('');
      }).join('');
      return '<button type="button" class="mobile-nav-link zw-mobile-primary-link zw-macc-trigger" aria-expanded="false">' +
        label + '<span class="zw-macc-ico" aria-hidden="true"></span></button>' +
        '<div class="zw-macc-panel">' + sub + '</div>';
    }).join('');
  }

  function render(menu) {
    if (!Array.isArray(menu) || !menu.length) return false;
    window.__zwCustomNavApplied = true;
    renderDesktop(menu);
    renderMobile(menu);
    return true;
  }

  // Mobile accordion toggle (delegated).
  document.addEventListener('click', function (e) {
    var t = e.target.closest('.zw-macc-trigger');
    if (!t) return;
    e.preventDefault();
    var panel = t.nextElementSibling;
    var open = t.classList.toggle('open');
    t.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (panel) panel.style.maxHeight = open ? (panel.scrollHeight + 'px') : '0px';
  });

  function init() {
    render(cached());
    try {
      fetch(REST, { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (rows) {
          if (!rows) return;
          var v = rows[0] && rows[0].value;
          if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) {} }
          try { localStorage.setItem(CACHE, JSON.stringify(v || null)); } catch (_) {}
          render(v);
        })
        .catch(function () {});
    } catch (_) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
