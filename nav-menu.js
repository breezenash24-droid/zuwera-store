/* ────────────────────────────────────────────────────────────────────────────
   nav-menu.js — admin-editable header navigation with hover mega-menu.

   Reads site_settings.nav_menu — an array of top-level items. Each item is one of:
     • Gender group — { type:"gender", label:"Men", gender:"Men", shopAll?:true,
         columns?:[{ heading, categories:[subtitle,…] }] }
       Auto-lists the product categories (subtitle) that exist for that gender,
       where Unisex products count for both Men and Women (not Kids). Empty
       categories/columns are hidden, so it grows with the catalogue. Links go to
       drop001.html?gender=<Gender>[&category=<subtitle>].
     • Tag item — { type:"tag", label:"New", tag:"New" }
       A link to drop001.html?tag=<tag> (products carry a tags[] field).
     • Custom link — { type:"link", label, url?, columns?:[{heading, links:[{text,url}]}] }
       Plain link and/or a manual mega-menu.

   Renders the desktop mega-menu into #nav-category-links (homepage) and the
   mobile accordion into #mobile-category-links (every storefront page). Falls
   back to the auto-category nav when nav_menu is empty. Cached in localStorage.
   CSS: .zw-navitem / .zw-mega / .zw-macc-* in storefront-cohesion.css.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
  var SB = 'https://qfgnrsifcwdubkolsgsq.supabase.co/rest/v1/';
  var H = { apikey: ANON, Authorization: 'Bearer ' + ANON };

  var navCfg = null;   // array of raw items
  var tax = null;      // { byGender:{men:{Jackets:true,…},…}, tags:{…} }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function safeUrl(u) {
    u = String(u == null ? '' : u).trim();
    if (!u || u.slice(0, 2) === '//') return '#';
    if (/^(?:javascript|data|vbscript|file):/i.test(u)) return '#';
    if (/^[#/]/.test(u)) return u;
    if (/^(?:https?:\/\/|mailto:|tel:)/i.test(u)) return u;
    if (/^[\w][\w./?=&%#+-]*$/.test(u)) return u;
    return '#';
  }
  function cacheGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } }

  // Build the gender→categories + tags index from a lightweight product list.
  function buildTax(products) {
    var byGender = {}, tags = {};
    function add(g, sub) { (byGender[g] = byGender[g] || {})[sub] = true; }
    (products || []).forEach(function (p) {
      var sub = String((p && p.subtitle) || '').trim();
      var g = String((p && p.gender) || '').trim().toLowerCase();
      if (sub) {
        if (g) add(g, sub);
        if (g === 'unisex') { add('men', sub); add('women', sub); }
      }
      ((p && Array.isArray(p.tags)) ? p.tags : []).forEach(function (t) {
        t = String(t || '').trim(); if (t) tags[t.toLowerCase()] = t;
      });
    });
    return { byGender: byGender, tags: tags };
  }

  // Normalize any raw item to { label, url, columns:[{heading,links:[{text,url}]}] }.
  // url '' means the top is a hover trigger only. Returns null to hide the item.
  function resolveItem(item) {
    if (!item || !item.label) return null;
    var type = item.type || (item.gender ? 'gender' : (item.tag ? 'tag' : 'link'));
    var label = item.label;

    if (type === 'gender') {
      var gender = item.gender || item.label;
      var set = (tax && tax.byGender[String(gender).toLowerCase()]) || null;
      // Top link → the gender landing page; mega-menu links → the filtered PLP.
      var landing = item.url || ('landing.html?page=' + encodeURIComponent(String(gender).toLowerCase()));
      if (!tax) return { label: label, url: landing, columns: [] };
      if (!set) return null; // no products for this gender — hide it
      var avail = {}; Object.keys(set).forEach(function (s) { avail[s.toLowerCase()] = s; });
      var base = 'drop001.html?gender=' + encodeURIComponent(gender);
      var columns = [], placed = {};
      var defs = (Array.isArray(item.columns) && item.columns.length) ? item.columns : null;
      if (defs) {
        defs.forEach(function (col) {
          var links = (col.categories || []).map(function (c) {
            var actual = avail[String(c).toLowerCase()];
            if (actual) { placed[actual.toLowerCase()] = true; return { text: actual, url: base + '&category=' + encodeURIComponent(actual) }; }
            return null;
          }).filter(Boolean);
          if (links.length) columns.push({ heading: col.heading || '', links: links });
        });
      }
      var leftovers = Object.keys(avail).filter(function (k) { return !placed[k]; }).map(function (k) { return avail[k]; });
      if (leftovers.length) columns.push({ heading: defs ? 'More' : '', links: leftovers.map(function (c) { return { text: c, url: base + '&category=' + encodeURIComponent(c) }; }) });
      if (item.shopAll !== false) columns.unshift({ heading: '', links: [{ text: 'Shop all ' + label, url: base }] });
      return { label: label, url: landing, columns: columns };
    }

    if (type === 'tag') {
      // Tag top-level link → its editable landing page (hero/featured/categories).
      return { label: label, url: 'landing.html?tag=' + encodeURIComponent(item.tag || label), columns: [] };
    }

    // custom link
    var cols = (item.columns || []).map(function (col) {
      return {
        heading: col.heading || '',
        links: (col.links || []).map(function (l) { return { text: l.text || '', url: safeUrl(l.url) }; }).filter(function (l) { return l.text; })
      };
    }).filter(function (c) { return c.heading || c.links.length; });
    return { label: label, url: item.url ? safeUrl(item.url) : '', columns: cols };
  }

  function resolveAll() {
    return (navCfg || []).map(resolveItem).filter(Boolean);
  }

  function renderDesktop(items) {
    var host = document.getElementById('nav-category-links');
    if (!host) return;
    host.innerHTML = items.map(function (n) {
      var top = n.url
        ? '<a href="' + esc(n.url) + '" class="nav-link">' + esc(n.label) + '</a>'
        : '<button type="button" class="nav-link zw-navtrigger">' + esc(n.label) + '</button>';
      if (!n.columns.length) return '<div class="zw-navitem">' + top + '</div>';
      var mega = '<div class="zw-mega">' + n.columns.map(function (c) {
        var links = c.links.map(function (l) { return '<a href="' + esc(l.url) + '">' + esc(l.text) + '</a>'; }).join('');
        return '<div class="zw-mega-col">' + (c.heading ? '<h4>' + esc(c.heading) + '</h4>' : '') + links + '</div>';
      }).join('') + '</div>';
      return '<div class="zw-navitem zw-has-mega">' + top + mega + '</div>';
    }).join('');
  }

  function renderMobile(items) {
    var host = document.getElementById('mobile-category-links');
    if (!host) return;
    host.innerHTML = items.map(function (n) {
      if (!n.columns.length) {
        return '<a href="' + esc(n.url || '#') + '" class="mobile-nav-link zw-mobile-primary-link">' + esc(n.label) + '</a>';
      }
      var sub = n.columns.map(function (c) {
        return (c.heading ? '<p class="zw-macc-head">' + esc(c.heading) + '</p>' : '') +
          c.links.map(function (l) { return '<a href="' + esc(l.url) + '" class="zw-macc-link">' + esc(l.text) + '</a>'; }).join('');
      }).join('');
      return '<button type="button" class="mobile-nav-link zw-mobile-primary-link zw-macc-trigger" aria-expanded="false">' +
        esc(n.label) + '<span class="zw-macc-ico" aria-hidden="true"></span></button>' +
        '<div class="zw-macc-panel">' + sub + '</div>';
    }).join('');
  }

  function render() {
    // Reveal the nav once we've settled (custom rendered OR confirmed none),
    // clearing the no-flash hide set in <head>.
    function ready() { document.documentElement.classList.add('zw-nav-ready'); }
    if (!Array.isArray(navCfg) || !navCfg.length) { ready(); return; }
    window.__zwCustomNavApplied = true;
    var items = resolveAll();
    renderDesktop(items);
    renderMobile(items);
    ready();
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
    navCfg = cacheGet('zw_nav_menu');
    var t = cacheGet('zw_nav_tax');
    if (t) tax = t;
    render();
    // Refresh nav config + product taxonomy from the server.
    try {
      fetch(SB + 'site_settings?select=value&key=eq.nav_menu', { headers: H })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (rows) {
          var v = rows && rows[0] && rows[0].value;
          if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) {} }
          navCfg = Array.isArray(v) ? v : [];
          try { localStorage.setItem('zw_nav_menu', JSON.stringify(navCfg)); } catch (_) {}
          render();
        }).catch(function () {});
      fetch(SB + 'products?select=gender,subtitle,tags&status=neq.Legacy&status=neq.Draft', { headers: H })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (products) {
          if (!Array.isArray(products)) return;
          tax = buildTax(products);
          try { localStorage.setItem('zw_nav_tax', JSON.stringify(tax)); } catch (_) {}
          render();
        }).catch(function () {});
    } catch (_) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
