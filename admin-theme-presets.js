/* ────────────────────────────────────────────────────────────────────────────
   admin-theme-presets.js — save the whole look as a theme, and put it back.

   A Shopify theme is code: Liquid templates plus assets, which is why moving
   one to another platform means rewriting it. Nothing here is code. Every
   decision that adds up to "how this site looks" already lives as JSON in a
   settings row — the palette, the type, the icons, the button radius, the
   homepage sections. So a theme is not something to generate. It is a snapshot
   of rows that already exist, and porting it is a file, not a rewrite.

   Capture reads those keys and stores them under a name. Apply writes them
   back. Export hands you the JSON. Import takes it. That is the whole feature,
   and it is small because the groundwork — making the site read its appearance
   from settings instead of from hardcoded CSS — was the actual work.

   TWO SCOPES, because they answer different questions.

     Look          colours, type, icons, button shape, spacing, card style.
                   Safe to move between stores: it carries no words and no
                   pictures, so it cannot overwrite anyone's copy.
     Look + layout adds the homepage sections, the nav and the page configs.
                   This is the one that makes a second store look like this
                   one — and the one that will replace content, which is why
                   it is not the default and says so before it runs.

   What a preset never carries: products, orders, customers, keys, or anything
   under Configuration. A theme is how the store looks, not what it sells or
   who it sells to.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* Presentation only. Every key here is something an admin chose about
     appearance; none of it is business data, and none of it is a secret. */
  var LOOK_KEYS = [
    'theme_modes',        // the palette, and which page wears which theme
    'icons',              // icon set, per-icon overrides, the frame shape
    'fonts',              // type roles and per-section overrides
    'builder_theme',      // button radius, content width, section spacing
    'brand',              // logo treatment and store name
    'product_card_cta',   // add-to-bag vs colour swatches
    'image_effects',      // hover zoom and friends
    'header_behavior',
    'bag_panel',
    'theme',              // modal backdrop and the older theme bag
  ];

  /* Layout and the words in it. Kept apart because applying these to a store
     that already has content replaces that content. */
  var LAYOUT_KEYS = [
    'page_builder_published',
    'landing_pages_published',
    'collection_page',
    'product_page',
    'nav_menu',
    'announcement_bar',
  ];

  var STORE_KEY = 'theme_presets';
  var state = { presets: [] };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function status(msg, bad) {
    var el = document.getElementById('preset-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = bad ? 'var(--error)' : 'var(--success, #4ade80)';
  }

  // ── Reading and writing the underlying rows ──────────────────────────────
  async function readKeys(keys) {
    var out = {};
    try {
      var res = await sb.from('site_settings').select('key,value').in('key', keys);
      (res.data || []).forEach(function (row) {
        var v = row.value;
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) {} }
        out[row.key] = v;
      });
    } catch (_) {}
    return out;
  }

  async function writeKeys(map) {
    var rows = Object.keys(map).map(function (k) { return { key: k, value: map[k] }; });
    if (!rows.length) return;
    var res = await sb.from('site_settings').upsert(rows, { onConflict: 'key' });
    if (res.error) throw res.error;
  }

  // ── Load / save the preset list itself ───────────────────────────────────
  async function load() {
    if (!window.sb) return;
    try {
      var res = await sb.from('site_settings').select('value').eq('key', STORE_KEY).maybeSingle();
      var v = res.data && res.data.value;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
      if (v && Array.isArray(v.presets)) state = { presets: v.presets };
    } catch (_) {}
    render();
  }

  async function persist() {
    var res = await sb.from('site_settings').upsert({ key: STORE_KEY, value: state }, { onConflict: 'key' });
    if (res.error) throw res.error;
  }

  // ── Capture ──────────────────────────────────────────────────────────────
  window.presetCapture = async function () {
    var nameEl = document.getElementById('preset-name');
    var name = (nameEl && nameEl.value.trim()) || '';
    if (!name) { status('Give it a name first.', true); return; }
    var withLayout = !!(document.getElementById('preset-layout') || {}).checked;

    status('Capturing…');
    try {
      var keys = withLayout ? LOOK_KEYS.concat(LAYOUT_KEYS) : LOOK_KEYS;
      var captured = await readKeys(keys);
      state.presets.push({
        id: 'preset-' + Date.now().toString(36),
        name: name,
        scope: withLayout ? 'layout' : 'look',
        createdAt: new Date().toISOString(),
        // Only the keys that actually had a row. Storing an explicit null for a
        // key that was never set would, on apply, write that null over a value
        // the target store legitimately has.
        keys: captured,
      });
      await persist();
      if (nameEl) nameEl.value = '';
      if (typeof logAdminAudit === 'function') {
        void logAdminAudit('settings.update', 'site_settings', STORE_KEY, { captured: name, keys: Object.keys(captured).length });
      }
      status('Saved “' + name + '” — ' + Object.keys(captured).length + ' settings captured.');
      render();
    } catch (err) {
      status('Could not capture: ' + ((err && err.message) || 'unknown error'), true);
    }
  };

  // ── Apply ────────────────────────────────────────────────────────────────
  window.presetApply = async function (id) {
    var p = state.presets.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    var n = Object.keys(p.keys || {}).length;
    var warn = p.scope === 'layout'
      ? 'Apply “' + p.name + '”?\n\nThis carries page layouts and their content, so the homepage sections, nav and announcement bar of this store will be REPLACED by the ones in the theme.\n\n' + n + ' settings will be overwritten.'
      : 'Apply “' + p.name + '”?\n\nColours, type, icons and spacing will be replaced. Your pages and their content are untouched.\n\n' + n + ' settings will be overwritten.';
    if (!confirm(warn)) return;

    status('Applying…');
    try {
      await writeKeys(p.keys || {});
      if (typeof logAdminAudit === 'function') {
        void logAdminAudit('settings.update', 'site_settings', STORE_KEY, { applied: p.name, keys: n });
      }
      status('Applied “' + p.name + '”. Reload the storefront to see it.');
      // The theme editor above is now showing stale values.
      if (typeof window.themeLoad === 'function') window.themeLoad();
    } catch (err) {
      status('Could not apply: ' + ((err && err.message) || 'unknown error'), true);
    }
  };

  window.presetDelete = async function (id) {
    var p = state.presets.filter(function (x) { return x.id === id; })[0];
    if (!p || !confirm('Delete the saved theme “' + p.name + '”?\n\nThe site keeps its current look — this only removes the snapshot.')) return;
    state.presets = state.presets.filter(function (x) { return x.id !== id; });
    try { await persist(); status('Deleted.'); render(); }
    catch (err) { status('Could not delete: ' + ((err && err.message) || 'error'), true); }
  };

  // ── Export / import ──────────────────────────────────────────────────────
  /* A file, not a zip of templates. That is the whole difference from porting a
     Shopify theme: there is no Liquid to convert, so the same JSON that
     describes this store's look describes it on any deployment of this code. */
  window.presetExport = function (id) {
    var p = state.presets.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    var blob = new Blob([JSON.stringify({ zuweraTheme: 1, preset: p }, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = p.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.theme.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  };

  window.presetImport = function (input) {
    var file = input && input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = async function () {
      try {
        var parsed = JSON.parse(String(reader.result));
        var p = parsed && parsed.preset;
        if (!p || !p.keys) throw new Error('That file is not a theme export.');
        // A fresh id, so importing the same file twice gives two entries rather
        // than silently replacing the first.
        p.id = 'preset-' + Date.now().toString(36);
        p.name = String(p.name || 'Imported theme');
        state.presets.push(p);
        await persist();
        status('Imported “' + p.name + '”. It is saved but not applied — press Apply when you want it.');
        render();
      } catch (err) {
        status('Could not import: ' + ((err && err.message) || 'unreadable file'), true);
      }
      input.value = '';
    };
    reader.readAsText(file);
  };

  // ── Rendering ────────────────────────────────────────────────────────────
  function render() {
    var host = document.getElementById('preset-list');
    if (!host) return;
    if (!state.presets.length) {
      host.innerHTML = '<p style="color:var(--text-secondary);font-size:.83rem;line-height:1.6;">' +
        'No saved themes yet. Capture the look you have now and it becomes one you can come back to — or move to another store.</p>';
      return;
    }
    host.innerHTML = state.presets.slice().reverse().map(function (p) {
      var when = '';
      try { when = new Date(p.createdAt).toLocaleDateString(); } catch (_) {}
      var n = Object.keys(p.keys || {}).length;
      return '<div style="border:1px solid var(--border);border-radius:8px;padding:14px;background:var(--bg-primary);display:flex;align-items:center;gap:14px;flex-wrap:wrap;">' +
        '<div style="min-width:0;flex:1;">' +
          '<strong style="font-size:.92rem;">' + esc(p.name) + '</strong>' +
          '<div style="font-size:.75rem;color:var(--text-secondary);margin-top:3px;">' +
            (p.scope === 'layout' ? 'Look + layout' : 'Look only') + ' · ' + n + ' settings' + (when ? ' · ' + esc(when) : '') +
          '</div>' +
        '</div>' +
        '<button class="btn btn-primary" onclick="presetApply(&quot;' + esc(p.id) + '&quot;)">Apply</button>' +
        '<button class="btn btn-secondary" onclick="presetExport(&quot;' + esc(p.id) + '&quot;)">Export</button>' +
        '<button class="btn btn-secondary" style="color:var(--error);" onclick="presetDelete(&quot;' + esc(p.id) + '&quot;)">Delete</button>' +
      '</div>';
    }).join('');
  }

  window.presetLoad = load;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, { once: true });
  else load();
})();
