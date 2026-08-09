/* ────────────────────────────────────────────────────────────────────────────
   admin-themes.js — the theme editor behind Appearance → Themes.

   Writes site_settings.theme_modes, which theme-engine.js reads on the
   storefront. Deliberately a small surface: seven colours, a name, an icon and
   a base. Everything else on the site derives from those, so a longer form
   would be offering control that does not exist.

   `base` is the one field that needs explaining rather than picking, and the
   help text says it plainly: it decides which set of structural CSS the theme
   sits on. Hundreds of existing rules are written as `body.light-mode .thing`,
   and a new theme has to land on one side of that line or the other or it
   renders unstyled. Dark for dark themes, Light for light ones — a purple
   theme is a Light theme with purple colours.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var BUILTIN_IDS = ['dark', 'light', 'super-light'];

  var DEFAULT_MODES = [
    { id: 'dark', label: 'Dark', icon: '🌙', base: 'dark',
      tokens: { fg: '244 241 235', bg: '9 9 11', ink: '#09090b', paper: '#f4f1eb', surface: '#F0EEE9', accent: '#F891A5', err: '#ef4444' } },
    { id: 'light', label: 'Light', icon: '☀️', base: 'light',
      tokens: { fg: '10 10 10', bg: '240 238 233', ink: '#F0EEE9', paper: '#09090b', surface: '#F0EEE9', accent: '#F891A5', err: '#ef4444' } },
    { id: 'super-light', label: 'Super Light', icon: '⚪', base: 'super-light',
      tokens: { fg: '10 10 10', bg: '255 255 255', ink: '#FFFFFF', paper: '#09090b', surface: '#FFFFFF', accent: '#F891A5', err: '#ef4444' } },
    { id: 'two-tone', label: 'Two-tone', icon: '◐', base: 'light',
      tokens: { fg: '10 10 10', bg: '240 238 233', ink: '#F0EEE9', paper: '#09090b', surface: '#F0EEE9', accent: '#F891A5', err: '#ef4444',
                navBg: '#09090b', navFg: '#f4f1eb' } },
  ];

  /* The seven. `rgb` ones are stored as bare triplets because the alpha ladder
     splices them into rgb(… / n%) — the colour input speaks hex, so those two
     convert on the way in and out. */
  var FIELDS = [
    { key: 'fg', label: 'Text', kind: 'rgb', help: 'Body text, and every border, divider and muted label — those are this colour at a lower opacity.' },
    { key: 'bg', label: 'Page background', kind: 'rgb', help: 'The page itself.' },
    { key: 'accent', label: 'Accent', kind: 'hex', help: 'Links, focus rings, the small highlights.' },
    { key: 'surface', label: 'Surface', kind: 'hex', help: 'Panels and strips that sit just off the page colour.' },
    { key: 'paper', label: 'Inverted text', kind: 'hex', help: 'Text on a filled button — the opposite of Text.' },
    { key: 'ink', label: 'Inverted background', kind: 'hex', help: 'A filled button’s background.' },
    { key: 'err', label: 'Error', kind: 'hex', help: 'Failed payments, validation, anything gone wrong.' },
    { key: 'navBg', label: 'Header background', kind: 'hex', optional: true, help: 'Leave off and the header matches the page. Set it to give the site a header in a different colour from the page below it — a black bar over a light page, say.' },
    { key: 'navFg', label: 'Header text', kind: 'hex', optional: true, help: 'Only needed when the header has its own background.' },
  ];

  /* Not colours, but part of the theme all the same. These are the dimensions
     that separate two storefronts whose palettes match: how big the type reads,
     how sharp the corners are, how much air the sections have. */
  var SHAPE = [
    { key: 'typeScale', label: 'Type scale', min: 0.85, max: 1.25, step: 0.01, def: 1,
      help: 'Multiplies every size on the site at once. 1 is the current site; 1.15 is the big-display look; 0.9 reads tighter and more technical.',
      fmt: function (v) { return Math.round(v * 100) + '%'; } },
    { key: 'radius', label: 'Corner radius', min: 0, max: 24, step: 1, def: 0, unit: 'px',
      help: 'Cards, inputs and images. 0 is square and editorial; 12 and up reads friendlier and more consumer.',
      fmt: function (v) { return v + 'px'; } },
    { key: 'density', label: 'Density', min: 0.7, max: 1.4, step: 0.05, def: 1,
      help: 'How much air the sections have. Below 1 packs more onto a screen; above 1 gives it room to breathe.',
      fmt: function (v) { return v < 0.95 ? 'Tight' : v > 1.1 ? 'Airy' : 'Standard'; } },
  ];

  var state = { modes: DEFAULT_MODES.slice(), default: 'dark', pages: {} };
  var openId = null;

  // ── Colour conversion ────────────────────────────────────────────────────
  function tripletToHex(t) {
    var p = String(t || '').trim().split(/[\s,]+/).map(Number);
    if (p.length < 3 || p.some(function (n) { return !isFinite(n); })) return '#000000';
    return '#' + p.slice(0, 3).map(function (n) {
      return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    }).join('');
  }
  function hexToTriplet(hex) {
    var h = String(hex || '').replace('#', '').trim();
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return '0 0 0';
    return [0, 2, 4].map(function (i) { return parseInt(h.slice(i, i + 2), 16); }).join(' ');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function status(msg, bad) {
    var el = document.getElementById('theme-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = bad ? 'var(--error)' : 'var(--success, #4ade80)';
  }

  // ── Load / save ──────────────────────────────────────────────────────────
  async function load() {
    if (!window.sb) return;
    try {
      var res = await sb.from('site_settings').select('value').eq('key', 'theme_modes').maybeSingle();
      var v = res.data && res.data.value;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
      if (v && Array.isArray(v.modes) && v.modes.length) {
        state = { modes: v.modes, default: v.default || v.modes[0].id, pages: v.pages || {} };
      }
    } catch (_) {}
    render();
  }

  async function save() {
    try {
      var res = await sb.from('site_settings')
        .upsert({ key: 'theme_modes', value: state }, { onConflict: 'key' });
      if (res.error) throw res.error;
      if (typeof logAdminAudit === 'function') {
        void logAdminAudit('settings.update', 'site_settings', 'theme_modes', { count: state.modes.length, default: state.default });
      }
      status('Saved — live on the storefront within a minute.');
    } catch (err) {
      status('Could not save: ' + ((err && err.message) || 'unknown error'), true);
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  function swatchRow(m) {
    return ['bg', 'fg', 'accent', 'surface'].map(function (k) {
      var val = k === 'bg' || k === 'fg' ? tripletToHex(m.tokens[k]) : m.tokens[k];
      return '<span title="' + esc(k) + '" style="width:18px;height:18px;border-radius:4px;border:1px solid var(--border);background:' + esc(val) + ';display:inline-block;"></span>';
    }).join('');
  }

  function editor(m, i) {
    var fields = FIELDS.map(function (f) {
      var raw = m.tokens[f.key] || '';
      var on = !f.optional || !!raw;
      var hex = f.kind === 'rgb' ? tripletToHex(raw) : (raw || '#09090b');

      /* An optional token is off when it is absent, not when it is some
         sentinel colour — every nav rule reads var(--zw-nav-bg, <old value>),
         so "absent" is what makes the header follow the page again. Hence a
         checkbox that deletes the key rather than a colour meaning "none". */
      var toggle = f.optional
        ? '<label style="display:flex;align-items:center;gap:7px;font-size:.73rem;color:var(--text-secondary);cursor:pointer;margin:0 0 8px;">' +
            '<input type="checkbox"' + (on ? ' checked' : '') +
              ' onchange="themeToggleOptional(' + i + ',&quot;' + esc(f.key) + '&quot;,this.checked)"' +
              ' style="width:13px;height:13px;accent-color:var(--accent);cursor:pointer;">' +
            '<span>' + (on ? 'Using its own colour' : 'Off — follows the page') + '</span>' +
          '</label>'
        : '';

      /* Two ways in, because they are different jobs. The swatch is for
         browsing to a colour; the hex box is for entering one you already
         have — a brand colour arrives as #F891A5, not as a point on a
         gradient. They write the same value and mirror each other. */
      var picker = on
        ? '<div style="display:flex;gap:8px;align-items:center;">' +
            '<input type="color" value="' + esc(hex) + '" oninput="themeSetColor(' + i + ',&quot;' + esc(f.key) + '&quot;,this.value,true)" style="width:44px;height:32px;padding:2px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;cursor:pointer;">' +
            '<input type="text" value="' + esc(hex) + '" spellcheck="false" maxlength="7"' +
              ' oninput="themeSetHex(' + i + ',&quot;' + esc(f.key) + '&quot;,this.value)"' +
              ' style="width:100px;padding:7px 9px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-family:monospace;font-size:.76rem;">' +
            (f.kind === 'rgb'
              ? '<code style="font-size:.7rem;color:var(--text-secondary);">rgb ' + esc(raw || '—') + '</code>'
              : '') +
          '</div>'
        : '';

      return '<div style="margin-bottom:12px;">' +
        '<label style="display:block;font-size:.76rem;font-weight:600;color:var(--text-primary);margin-bottom:3px;">' + esc(f.label) + '</label>' +
        '<div style="font-size:.73rem;color:var(--text-secondary);line-height:1.5;margin-bottom:6px;">' + esc(f.help) + '</div>' +
        toggle + picker +
      '</div>';
    }).join('');

    var shape = SHAPE.map(function (f) {
      var raw = m.tokens[f.key];
      var v = (raw === undefined || raw === '' || !isFinite(parseFloat(raw))) ? f.def : parseFloat(raw);
      return '<div style="margin-bottom:14px;">' +
        '<label style="display:flex;justify-content:space-between;font-size:.78rem;font-weight:600;color:var(--text-primary);margin-bottom:3px;">' +
          '<span>' + esc(f.label) + '</span>' +
          '<span id="shape-val-' + esc(f.key) + '-' + i + '" style="font-weight:400;color:var(--text-secondary);">' + esc(f.fmt(v)) + '</span>' +
        '</label>' +
        '<div style="font-size:.73rem;color:var(--text-secondary);line-height:1.5;margin-bottom:6px;">' + esc(f.help) + '</div>' +
        '<input type="range" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" value="' + v + '"' +
          ' oninput="themeSetShape(' + i + ',&quot;' + esc(f.key) + '&quot;,this.value)"' +
          ' style="width:100%;accent-color:var(--accent);cursor:pointer;">' +
      '</div>';
    }).join('');

    var isBuiltin = BUILTIN_IDS.indexOf(m.id) !== -1;
    return '<div style="border-top:1px solid var(--border);margin-top:14px;padding-top:16px;">' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:18px;">' +
        '<div>' +
          '<div style="margin-bottom:12px;"><label style="display:block;font-size:.76rem;font-weight:600;margin-bottom:5px;">Name</label>' +
          '<input value="' + esc(m.label) + '" oninput="themeSetField(' + i + ',\'label\',this.value)" style="width:100%;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:.82rem;"></div>' +
          '<div style="margin-bottom:12px;"><label style="display:block;font-size:.76rem;font-weight:600;margin-bottom:5px;">Icon</label>' +
          '<input value="' + esc(m.icon) + '" maxlength="4" oninput="themeSetField(' + i + ',\'icon\',this.value)" style="width:72px;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:.9rem;text-align:center;"></div>' +
          '<div><label style="display:block;font-size:.76rem;font-weight:600;margin-bottom:5px;">Built on</label>' +
          '<div style="font-size:.73rem;color:var(--text-secondary);line-height:1.5;margin-bottom:6px;">Which set of layout rules this theme sits on. Pick Dark for a dark theme and Light for a light one — a purple theme is a Light theme with purple colours. Get this wrong and the colours will be right but some panels will fight them.</div>' +
          '<select onchange="themeSetField(' + i + ',\'base\',this.value)" style="width:100%;padding:8px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:.82rem;">' +
            ['dark', 'light', 'super-light'].map(function (b) {
              return '<option value="' + b + '"' + (m.base === b ? ' selected' : '') + '>' + (b === 'super-light' ? 'Light (white)' : b === 'light' ? 'Light' : 'Dark') + '</option>';
            }).join('') +
          '</select></div>' +
        '</div>' +
        '<div>' + fields +
          '<div style="border-top:1px solid var(--border);margin-top:14px;padding-top:14px;">' + shape + '</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;">' +
        '<button class="btn btn-primary" onclick="themeSave()">Save</button>' +
        '<button class="btn btn-secondary" onclick="themeDuplicate(' + i + ')">Duplicate</button>' +
        (state.default === m.id ? '' : '<button class="btn btn-secondary" onclick="themeMakeDefault(' + i + ')">Make default</button>') +
        (isBuiltin ? '' : '<button class="btn btn-secondary" style="color:var(--error);" onclick="themeDelete(' + i + ')">Delete</button>') +
      '</div>' +
      (isBuiltin ? '<p style="font-size:.73rem;color:var(--text-secondary);margin-top:10px;">One of the three built-in themes. You can recolour it, but it cannot be deleted — something has to be there if every custom theme is removed.</p>' : '') +
    '</div>';
  }

  /* The pages a theme can be pinned to. Paths, not names, because that is what
     the engine matches on — and a prefix like /product.html covers every
     product without listing them. */
  var PAGE_TARGETS = [
    ['/', 'Home'],
    ['/drop001.html', 'Collection'],
    ['/product.html', 'Product pages'],
    ['/bag.html', 'Bag'],
    ['/checkout.html', 'Checkout'],
    ['/account.html', 'Account'],
    ['/about.html', 'About'],
    ['/journal.html', 'Journal'],
    ['/returns.html', 'Returns'],
    ['/policies.html', 'Policies'],
  ];

  function renderPages() {
    var host = document.getElementById('theme-pages');
    if (!host) return;
    host.innerHTML = PAGE_TARGETS.map(function (t) {
      var path = t[0], label = t[1];
      var chosen = state.pages[path] || '';
      var opts = '<option value="">Use the default</option>' + state.modes.map(function (m) {
        return '<option value="' + esc(m.id) + '"' + (chosen === m.id ? ' selected' : '') + '>' + esc(m.label) + '</option>';
      }).join('');
      return '<div style="display:flex;align-items:center;gap:10px;">' +
        '<span style="font-size:.8rem;min-width:104px;">' + esc(label) + '</span>' +
        '<select onchange="themeSetPage(&quot;' + esc(path) + '&quot;,this.value)" style="flex:1;padding:7px 9px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:.78rem;">' + opts + '</select>' +
      '</div>';
    }).join('');
  }

  window.themeSetPage = function (path, id) {
    if (id) state.pages[path] = id; else delete state.pages[path];
    save();
  };

  function render() {
    var host = document.getElementById('theme-list');
    if (!host) return;
    host.innerHTML = state.modes.map(function (m, i) {
      var isDefault = state.default === m.id;
      return '<div style="border:1px solid var(--border);border-radius:8px;padding:16px;background:var(--bg-primary);">' +
        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;cursor:pointer;" onclick="themeToggle(\'' + esc(m.id) + '\')">' +
          '<span style="font-size:1.2rem;">' + esc(m.icon) + '</span>' +
          '<strong style="font-size:.95rem;">' + esc(m.label) + '</strong>' +
          (isDefault ? '<span style="font-size:.66rem;letter-spacing:.08em;text-transform:uppercase;background:var(--accent);color:#000;padding:2px 8px;border-radius:20px;">Default</span>' : '') +
          '<span style="display:flex;gap:5px;margin-left:auto;">' + swatchRow(m) + '</span>' +
          '<span style="color:var(--text-secondary);font-size:.8rem;">' + (openId === m.id ? '▲' : '▼') + '</span>' +
        '</div>' +
        (openId === m.id ? editor(m, i) : '') +
      '</div>';
    }).join('');
    renderPages();
  }

  // ── Actions, on window because the markup calls them inline ──────────────
  window.themeToggle = function (id) { openId = openId === id ? null : id; render(); visPaint(); };

  window.themeSetField = function (i, key, value) {
    if (!state.modes[i]) return;
    state.modes[i][key] = value;
    if (key !== 'label' && key !== 'icon') render();   // typing should not steal focus
    visPaint();
  };

  window.themeSetColor = function (i, key, hex, redraw) {
    var m = state.modes[i];
    if (!m) return;
    var field = FIELDS.filter(function (f) { return f.key === key; })[0];
    m.tokens[key] = field && field.kind === 'rgb' ? hexToTriplet(hex) : hex;
    if (redraw !== false) render();
    visPaint();
  };

  /* Typed hex. Only accepted once it is a complete colour, and the grid is NOT
     re-rendered while typing — doing that blurs the field halfway through
     "#F891A5" and you end up entering it three times. */
  window.themeSetHex = function (i, key, value) {
    var v = String(value || '').trim();
    if (v && v.charAt(0) !== '#') v = '#' + v;
    if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) return;
    if (v.length === 4) v = '#' + v.slice(1).split('').map(function (c) { return c + c; }).join('');
    var m = state.modes[i];
    if (!m) return;
    var field = FIELDS.filter(function (f) { return f.key === key; })[0];
    m.tokens[key] = field && field.kind === 'rgb' ? hexToTriplet(v) : v;
    // Keep the swatch in step without touching the text field being typed in.
    var card = document.querySelectorAll('#theme-list > div')[i];
    if (card) {
      var swatch = card.querySelector('input[type="color"][oninput*="' + key + '"]');
      if (swatch) swatch.value = v;
    }
    visPaint();
  };

  /* Turning an optional token off clears it, which is what makes the header
     follow the page again — every nav rule falls back to its original value
     when the custom property is absent. */
  window.themeToggleOptional = function (i, key, on) {
    var m = state.modes[i];
    if (!m) return;
    if (on) m.tokens[key] = key === 'navFg' ? '#f4f1eb' : '#09090b';
    else delete m.tokens[key];
    render();
    visPaint();
  };

  /* A slider fires on every pixel of drag, so this must not re-render — doing
     that would rebuild the input mid-drag and drop the pointer. Only the
     readout and the preview move. */
  window.themeSetShape = function (i, key, value) {
    var m = state.modes[i];
    if (!m) return;
    m.tokens[key] = parseFloat(value);
    var f = SHAPE.filter(function (x) { return x.key === key; })[0];
    var out = document.getElementById('shape-val-' + key + '-' + i);
    if (out && f) out.textContent = f.fmt(parseFloat(value));
    visPaint();
  };

  window.themeAdd = function () {
    var base = JSON.parse(JSON.stringify(state.modes[0] || DEFAULT_MODES[0]));
    var id = 'theme-' + Date.now().toString(36);
    state.modes.push({ id: id, label: 'New theme', icon: '🎨', base: base.base, tokens: base.tokens });
    openId = id;
    render();
    status('Unsaved — press Save inside the theme when you are happy with it.');
  };

  window.themeDuplicate = function (i) {
    var src = state.modes[i];
    if (!src) return;
    var copy = JSON.parse(JSON.stringify(src));
    copy.id = 'theme-' + Date.now().toString(36);
    copy.label = src.label + ' copy';
    state.modes.splice(i + 1, 0, copy);
    openId = copy.id;
    render();
  };

  window.themeDelete = function (i) {
    var m = state.modes[i];
    if (!m || BUILTIN_IDS.indexOf(m.id) !== -1) return;
    if (!confirm('Delete “' + m.label + '”?\n\nAnyone currently viewing the site in this theme falls back to the default.')) return;
    state.modes.splice(i, 1);
    if (state.default === m.id) state.default = state.modes[0].id;
    openId = null;
    render();
    save();
  };

  window.themeMakeDefault = function (i) {
    var m = state.modes[i];
    if (!m) return;
    state.default = m.id;
    render();
    save();
  };

  /* ── Visualiser ─────────────────────────────────────────────────────────
     A real storefront page in an iframe, repainted through the real engine on
     every change. Two things follow from using the engine rather than drawing
     a mock-up: what you see is exactly what a shopper gets, and there is no
     second renderer to keep in step with the first — which is the failure mode
     every "theme preview" eventually has.

     ?zwvis=1 tells the page it is being previewed, so it can skip anything
     that has no business running here. Same-origin, so reaching into
     contentWindow is allowed. */
  var visReady = false;

  function visFrame() { return document.getElementById('theme-vis'); }

  function visPaint() {
    var f = visFrame();
    var m = state.modes.filter(function (x) { return x.id === (openId || state.default); })[0]
         || state.modes[0];
    if (!f || !m) return;
    try {
      var w = f.contentWindow;
      if (w && w.ZWTheme) w.ZWTheme.preview(JSON.parse(JSON.stringify(m)));
    } catch (_) {
      // Cross-origin or not loaded yet; the load handler repaints.
    }
  }

  window.themeVisReload = function () {
    var f = visFrame();
    var sel = document.getElementById('theme-vis-page');
    if (!f || !sel) return;
    visReady = false;
    var note = document.getElementById('theme-vis-note');
    if (note) note.textContent = 'Loading…';
    f.src = sel.value + '?zwvis=1';
  };

  window.themeVisSize = function (w) {
    var f = visFrame();
    if (!f) return;
    f.style.width = w;
    f.style.maxWidth = '100%';
    // A phone-width frame in a desktop-width stage should sit centred with the
    // page colour either side, not pinned left looking broken.
    f.style.margin = w === '100%' ? '0' : '0 auto';
  };

  function visInit() {
    var f = visFrame();
    if (!f) return;
    f.addEventListener('load', function () {
      visReady = true;
      var note = document.getElementById('theme-vis-note');
      if (note) note.textContent = 'Showing the theme you are editing';
      visPaint();
    });
    window.themeVisReload();
  }

  window.themeSave = save;
  window.themeLoad = load;

  function boot() { load(); visInit(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
