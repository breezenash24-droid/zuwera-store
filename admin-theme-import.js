/* ────────────────────────────────────────────────────────────────────────────
   admin-theme-import.js — read a Shopify theme export and take what ports.

   THE IDEA, AND ITS LIMIT. A Shopify theme .zip cannot be "installed" here,
   and no tool can make that true: the layout is Liquid, and Liquid is a
   templating language this site does not run. Anyone promising a one-click
   conversion is promising to rewrite templates, which is a person's afternoon,
   not a function.

   But a theme's zip is not only Liquid. Two files in it are plain JSON and hold
   most of what makes the theme recognisable:

     config/settings_schema.json   every setting the theme declares, with its
                                   default — so you get the theme's own palette
                                   and type even from a fresh, unconfigured copy
     config/settings_data.json     what the merchant actually chose, which beats
                                   the defaults where both exist
     templates/index.json          the homepage's sections, in order

   So the honest feature is: extract the values that have somewhere to land
   here, map them, and say plainly what did not come across. A report that
   admits "17 settings had no equivalent" is worth more than a silent 40%
   import that leaves you wondering why it does not look right.

   NO DEPENDENCY. The zip is read here rather than by a library: walk the
   central directory, inflate with DecompressionStream('deflate-raw'). About
   sixty lines, no CDN — which matters because the site's CSP does not allow
   one, and because a build step for one screen is a poor trade.

   ── On copyright ────────────────────────────────────────────────────────
   This reads settings values — colours, a font name, a corner radius. Those
   are configuration, and on a theme you are licensed to use they are yours.
   It deliberately does not copy the theme's Liquid, its CSS or its images,
   which are the parts that are actually authored and actually licensed. A
   paid Shopify theme's licence covers one store; recreating its design
   elsewhere is a question for whoever wrote it, not something this screen
   can answer for you.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── A minimal zip reader ─────────────────────────────────────────────────
  function u16(v, o) { return v.getUint16(o, true); }
  function u32(v, o) { return v.getUint32(o, true); }

  /* Find the End Of Central Directory record. It sits at the end, but a zip
     comment can follow it, so scan backwards for the signature rather than
     assuming a fixed offset. */
  function findEOCD(view) {
    for (var i = view.byteLength - 22; i >= 0 && i > view.byteLength - 66000; i--) {
      if (u32(view, i) === 0x06054b50) return i;
    }
    return -1;
  }

  async function inflate(bytes, method) {
    if (method === 0) return bytes;                       // stored
    if (method !== 8) throw new Error('unsupported compression');
    if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot inflate');
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* Returns { path: Uint8Array } for the entries we ask for. Selective on
     purpose — a theme zip is megabytes of images and Liquid, and inflating all
     of it to read three JSON files would be wasteful and slow. */
  async function readZip(buffer, wanted) {
    var view = new DataView(buffer);
    var eocd = findEOCD(view);
    if (eocd < 0) throw new Error('not a zip file');
    var count = u16(view, eocd + 10);
    var dirOffset = u32(view, eocd + 16);
    var out = {};
    var p = dirOffset;
    var dec = new TextDecoder();

    for (var i = 0; i < count; i++) {
      if (u32(view, p) !== 0x02014b50) break;
      var method = u16(view, p + 10);
      var compSize = u32(view, p + 20);
      var nameLen = u16(view, p + 28);
      var extraLen = u16(view, p + 30);
      var commentLen = u16(view, p + 32);
      var localOffset = u32(view, p + 42);
      var name = dec.decode(new Uint8Array(buffer, p + 46, nameLen));
      p += 46 + nameLen + extraLen + commentLen;

      if (!wanted(name)) continue;

      // The local header repeats the name and extra field, at its own lengths.
      var lNameLen = u16(view, localOffset + 26);
      var lExtraLen = u16(view, localOffset + 28);
      var dataStart = localOffset + 30 + lNameLen + lExtraLen;
      var raw = new Uint8Array(buffer, dataStart, compSize);
      try { out[name] = await inflate(raw, method); } catch (_) {}
    }
    return out;
  }

  function json(bytes) {
    if (!bytes) return null;
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { return null; }
  }

  // ── Shopify's names for things ───────────────────────────────────────────
  /* Colour settings, newest naming first. Online Store 2.0 themes group colours
     into schemes; older ones use flat colors_* ids. Both are read, because a
     store's zip can be either and the merchant does not know which. */
  function pickColours(current) {
    var c = {};
    var schemes = current.color_schemes;
    if (schemes && typeof schemes === 'object') {
      var first = schemes['scheme-1'] || schemes[Object.keys(schemes)[0]];
      var st = first && (first.settings || first);
      if (st) {
        c.bg = st.background;
        c.fg = st.text;
        c.ink = st.button;
        c.paper = st.button_label;
        c.accent = st.secondary_button_label || st.button;
      }
    }
    // Flat ids win only where the scheme gave nothing — a configured scheme is
    // the more recent intent.
    c.bg = c.bg || current.colors_background_1;
    c.fg = c.fg || current.colors_text;
    c.accent = c.accent || current.colors_accent_1;
    c.ink = c.ink || current.colors_accent_1;
    c.paper = c.paper || current.colors_solid_button_labels;
    return c;
  }

  /* Shopify font handles look like "assistant_n4" — family, then weight/style.
     The family is all this site needs; weight is a typography setting here. */
  function fontFamily(handle) {
    var h = String(handle || '').split('_')[0];
    if (!h) return '';
    return h.replace(/-/g, ' ').replace(/\b\w/g, function (m) { return m.toUpperCase(); });
  }

  function hex(v) {
    var s = String(v || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
    if (/^#[0-9a-fA-F]{3}$/.test(s)) return '#' + s.slice(1).split('').map(function (c) { return c + c; }).join('');
    return '';
  }
  function toTriplet(h) {
    var x = hex(h);
    if (!x) return '';
    return [1, 3, 5].map(function (i) { return parseInt(x.substr(i, 2), 16); }).join(' ');
  }

  // ── The mapping ──────────────────────────────────────────────────────────
  function build(schema, data, indexTpl, name) {
    var current = (data && data.current) || {};
    if (typeof current === 'string') current = {};   // a named preset, not values

    /* Schema defaults fill the gaps. A freshly downloaded theme that nobody
       configured has an empty settings_data but a schema full of the designer's
       intended palette — which is exactly the look someone browsing the theme
       store is trying to copy. */
    var defaults = {};
    (Array.isArray(schema) ? schema : []).forEach(function (group) {
      (group.settings || []).forEach(function (s) {
        if (s && s.id && s.default !== undefined) defaults[s.id] = s.default;
      });
    });
    var merged = Object.assign({}, defaults, current);

    var col = pickColours(merged);
    var tokens = {};
    var got = [], missed = [];

    function take(key, value, label) {
      if (value) { tokens[key] = value; got.push(label); }
      else missed.push(label);
    }
    take('fg', toTriplet(col.fg), 'Text colour');
    take('bg', toTriplet(col.bg), 'Page background');
    take('accent', hex(col.accent), 'Accent');
    take('ink', hex(col.ink), 'Button background');
    take('paper', hex(col.paper), 'Button text');
    tokens.surface = hex(col.bg) || '#F0EEE9';

    // Corner radius: themes name it several ways; any of them answers the
    // question "how round is this theme".
    var r = [merged.buttons_radius, merged.card_corner_radius, merged.inputs_radius, merged.media_radius]
      .map(parseFloat).filter(function (n) { return isFinite(n); });
    if (r.length) { tokens.radius = Math.round(r.reduce(function (a, b) { return a + b; }, 0) / r.length); got.push('Corner radius'); }
    else missed.push('Corner radius');

    // Dawn-style type scales are percentages of a base.
    var hs = parseFloat(merged.heading_scale);
    if (isFinite(hs) && hs > 0) { tokens.typeScale = Math.max(0.85, Math.min(1.25, hs / 100)); got.push('Type scale'); }
    else missed.push('Type scale');

    var sp = parseFloat(merged.spacing_sections);
    if (isFinite(sp)) { tokens.density = Math.max(0.7, Math.min(1.4, 0.7 + (sp / 100) * 0.7)); got.push('Section density'); }
    else missed.push('Section density');

    var fonts = {
      head: fontFamily(merged.type_header_font),
      body: fontFamily(merged.type_body_font),
    };
    if (fonts.head || fonts.body) got.push('Fonts (' + [fonts.head, fonts.body].filter(Boolean).join(', ') + ')');
    else missed.push('Fonts');

    /* Sections are read to be REPORTED, not imported. Their types are the
       theme's own — image-banner, multicolumn, collapsible-content — and each
       would need a matching section built here. Listing them tells you how much
       of the layout is missing, which is the honest thing to hand back. */
    var sections = [];
    try {
      var order = indexTpl && indexTpl.order;
      var byId = indexTpl && indexTpl.sections;
      if (order && byId) sections = order.map(function (id) { return (byId[id] || {}).type || id; });
    } catch (_) {}

    // Things a Shopify theme carries that have nowhere to land here yet.
    ['Header layout', 'Animations and hover effects', 'Product page layout', 'Liquid templates and custom sections']
      .forEach(function (x) { missed.push(x); });

    return {
      preset: {
        id: 'preset-' + Date.now().toString(36),
        name: name || 'Imported theme',
        scope: 'look',
        createdAt: new Date().toISOString(),
        source: 'shopify-zip',
        keys: {
          theme_modes: {
            modes: [{
              id: 'imported-' + Date.now().toString(36),
              label: name || 'Imported',
              icon: '📦',
              // A light page keeps the light structural CSS behind it. Judged
              // from the imported background rather than guessed.
              base: isDark(col.bg) ? 'dark' : 'light',
              tokens: Object.assign({ err: '#ef4444' }, tokens),
            }],
            default: 'imported-' + Date.now().toString(36),
          },
        },
      },
      report: { got: got, missed: missed, sections: sections, fonts: fonts },
    };
  }

  function isDark(h) {
    var x = hex(h);
    if (!x) return false;
    var r = parseInt(x.substr(1, 2), 16), g = parseInt(x.substr(3, 2), 16), b = parseInt(x.substr(5, 2), 16);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
  }

  // ── Entry point ──────────────────────────────────────────────────────────
  var pending = null;

  window.shopifyThemeImport = async function (input) {
    var file = input && input.files && input.files[0];
    if (!file) return;
    var out = document.getElementById('shopify-import-report');
    var say = function (html) { if (out) out.innerHTML = html; };
    say('<p style="color:var(--text-secondary);font-size:.85rem;">Reading ' + esc(file.name) + '…</p>');
    input.value = '';

    try {
      var buf = await file.arrayBuffer();
      var files = await readZip(buf, function (n) {
        return /(^|\/)config\/settings_(schema|data)\.json$/.test(n) ||
               /(^|\/)templates\/index\.json$/.test(n);
      });
      var pick = function (re) {
        var k = Object.keys(files).filter(function (n) { return re.test(n); })[0];
        return k ? json(files[k]) : null;
      };
      var schema = pick(/settings_schema\.json$/);
      var data = pick(/settings_data\.json$/);
      var idx = pick(/templates\/index\.json$/);
      if (!schema && !data) throw new Error('No config/settings_schema.json inside — is this a Shopify theme export?');

      var themeName = '';
      try { themeName = (Array.isArray(schema) ? schema[0] : {}).theme_name || ''; } catch (_) {}
      var built = build(schema, data, idx, themeName || file.name.replace(/\.zip$/i, ''));
      pending = built.preset;
      say(renderReport(built, themeName));
    } catch (err) {
      say('<p style="color:var(--error);font-size:.85rem;">' + esc((err && err.message) || 'Could not read that file') + '</p>');
    }
  };

  window.shopifyImportKeep = async function () {
    if (!pending) return;
    try {
      var res = await sb.from('site_settings').select('value').eq('key', 'theme_presets').maybeSingle();
      var v = (res.data && res.data.value) || { presets: [] };
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = { presets: [] }; } }
      if (!Array.isArray(v.presets)) v.presets = [];
      v.presets.push(pending);
      var up = await sb.from('site_settings').upsert({ key: 'theme_presets', value: v }, { onConflict: 'key' });
      if (up.error) throw up.error;
      var out = document.getElementById('shopify-import-report');
      if (out) out.innerHTML = '<p style="color:var(--success,#4ade80);font-size:.85rem;">Saved as “' + esc(pending.name) +
        '” under Saved themes. It is not applied yet — press Apply there when you want it.</p>';
      pending = null;
      if (typeof window.presetLoad === 'function') window.presetLoad();
    } catch (err) {
      var el = document.getElementById('shopify-import-report');
      if (el) el.innerHTML = '<p style="color:var(--error);font-size:.85rem;">Could not save: ' + esc((err && err.message) || 'error') + '</p>';
    }
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderReport(built, themeName) {
    var r = built.report;
    var swatches = ['bg', 'fg', 'accent', 'ink'].map(function (k) {
      var t = built.preset.keys.theme_modes.modes[0].tokens[k] || '';
      var c = /^\d/.test(t) ? 'rgb(' + t + ')' : t;
      return c ? '<span style="width:26px;height:26px;border-radius:5px;border:1px solid var(--border);background:' + esc(c) + ';display:inline-block;"></span>' : '';
    }).join('');

    return '<div style="border:1px solid var(--border);border-radius:8px;padding:16px;background:var(--bg-primary);">' +
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;">' +
        '<strong style="font-size:.95rem;">' + esc(themeName || built.preset.name) + '</strong>' +
        '<span style="display:flex;gap:5px;">' + swatches + '</span>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:16px;">' +
        '<div><div style="font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--success,#4ade80);margin-bottom:6px;">Came across (' + r.got.length + ')</div>' +
          '<ul style="margin:0;padding-left:16px;font-size:.8rem;color:var(--text-secondary);line-height:1.7;">' +
          r.got.map(function (g) { return '<li>' + esc(g) + '</li>'; }).join('') + '</ul></div>' +
        '<div><div style="font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary);margin-bottom:6px;">Did not (' + r.missed.length + ')</div>' +
          '<ul style="margin:0;padding-left:16px;font-size:.8rem;color:var(--text-secondary);line-height:1.7;">' +
          r.missed.map(function (g) { return '<li>' + esc(g) + '</li>'; }).join('') + '</ul></div>' +
      '</div>' +
      (r.sections.length
        ? '<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);font-size:.78rem;color:var(--text-secondary);line-height:1.6;">' +
          '<strong style="color:var(--text-primary);">Its homepage has ' + r.sections.length + ' sections</strong> — ' +
          esc(r.sections.slice(0, 8).join(', ')) + (r.sections.length > 8 ? '…' : '') +
          '. These are Liquid templates, so they are listed rather than imported: each would need building here. The colours and type above are what actually ported.</div>'
        : '') +
      '<button class="btn btn-primary" style="margin-top:14px;" onclick="shopifyImportKeep()">Save as a theme</button>' +
    '</div>';
  }
})();
