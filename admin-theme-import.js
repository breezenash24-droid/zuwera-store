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

  /* ── The mapping, shown and editable ──────────────────────────────────────
     Everything above this point is a guess. `colors_accent_1` becomes the
     accent AND the button background because on most themes it is both;
     `scheme-1` is chosen because it is usually the one the homepage uses;
     radius is averaged across four settings because themes disagree about
     which one means "the theme's roundness". Those guesses are right often
     enough to be useful and wrong often enough that hiding them is unfair.

     So the mapping is data rather than control flow: a table of
     target-token → source-setting-id that is derived automatically, then
     shown, then editable. Change a row and the preset is rebuilt from the
     table — the import has no second opinion. */

  /* Every setting in the theme that could plausibly land somewhere here,
     with its value. Typed by shape rather than by the schema's declared type,
     because settings_data carries values without their schema and a theme
     can define a colour with type "text". */
  /* Newer themes do not put colours in their colour settings. Fabric declares
     one `color_palette` object and then makes every other colour setting point
     at it:

       color_palette        { background: "#ffffff", foreground: "#030302", … }
       page_background_color "{{ settings.color_palette.background }}"

     Thirty settings of type "color" whose values are Liquid expressions. A
     reader looking for hex found none of them, which is how a real theme
     imported with every colour row blank.

     Resolving the reference does two things: the palette entries become
     sources, and so do all thirty of the settings pointing at them — which
     matters for the table, because "page background" is a more meaningful
     thing to choose than "color_palette.background". */
  function resolveRef(value, merged) {
    var m = String(value || '').match(/\{\{\s*settings\.([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\s*\}\}/);
    if (!m) return null;
    var obj = merged[m[1]];
    return (obj && typeof obj === 'object') ? obj[m[2]] : null;
  }

  function collect(merged, meta) {
    var colours = [], numbers = [], fonts = [];

    /* The palette itself, flattened so each role is selectable by name. */
    Object.keys(merged).forEach(function (id) {
      var v = merged[id];
      if (!v || typeof v !== 'object' || Array.isArray(v)) return;
      Object.keys(v).forEach(function (role) {
        if (typeof v[role] === 'string' && hex(v[role])) {
          colours.push({ id: id + '.' + role, value: hex(v[role]) });
        }
      });
    });

    Object.keys(merged).forEach(function (id) {
      var v = merged[id];
      var ref = typeof v === 'string' ? resolveRef(v, merged) : null;
      if (ref && hex(ref)) { colours.push({ id: id, value: hex(ref) }); return; }
      if (typeof v === 'string' && hex(v)) colours.push({ id: id, value: hex(v) });
      else if (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v))) {
        numbers.push({ id: id, value: parseFloat(v) });
      } else if (typeof v === 'string' && /_[ni][1-9]/.test(v)) {
        /* Shopify font handles are family_weightstyle: archivo_n7, assistant_n4,
           playfair_i4 for italic. The weight digit is single, not 700 — an
           earlier pattern demanded the three-digit form and matched nothing, so
           fonts silently found no source at all and the mapping table showed
           two empty rows with no explanation. */
        fonts.push({ id: id, value: v });
      }
    });
    /* Colour schemes are nested one level deeper than a palette — scheme-1 holds
       a `settings` object — so they need their own walk. The generic one above
       reaches the scheme names, not the colours inside them. */
    var schemes = merged.color_schemes;
    if (schemes && typeof schemes === 'object') {
      Object.keys(schemes).forEach(function (name) {
        var st = (schemes[name] && (schemes[name].settings || schemes[name])) || {};
        Object.keys(st).forEach(function (k) {
          if (typeof st[k] === 'string' && hex(st[k])) {
            colours.push({ id: name + '.' + k, value: hex(st[k]) });
          }
        });
      });
    }
    var seen = {};
    colours = colours.filter(function (c) { if (seen[c.id]) return false; seen[c.id] = 1; return true; });
    return { colours: colours, numbers: numbers, fonts: fonts };
  }

  /* What each of this site's tokens can be fed from, and how to read a source
     value into it. Order matters: the first id present wins, which is what
     encodes "prefer the scheme over the flat setting". */
  var TARGETS = [
    /* Three generations of Shopify naming, newest first. A palette (Fabric), a
       colour scheme (Dawn 7+), then the flat colors_* ids. Whichever the theme
       has is the one that answers. */
    { key: 'bg', label: 'Page background', kind: 'colour',
      prefer: ['color_palette.background', 'page_background_color', 'scheme-1.background',
               'colors_background_1', 'background', 'colors_background_2'] },
    { key: 'fg', label: 'Text', kind: 'colour',
      prefer: ['color_palette.foreground', 'page_text_color', 'scheme-1.text',
               'colors_text', 'text', 'colors_text_body'] },
    { key: 'accent', label: 'Accent', kind: 'colour',
      prefer: ['color_palette.color1', 'colors_accent_1',
               'scheme-1.secondary_button_label', 'scheme-1.button'] },
    { key: 'surface', label: 'Surface', kind: 'colour',
      prefer: ['color_palette.color2', 'colors_background_2', 'scheme-2.background',
               'scheme-1.background', 'color_palette.background'] },
    /* These two are NOT a button pair, whatever their names suggest. In this
       codebase --ink is used as a surface background and --paper as the text on
       it, and both track the PAGE: light mode has ink #F0EEE9 with paper
       #09090b, dark mode the reverse. The nav draws its links and the bag with
       color: var(--paper).

       Mapping them from Shopify's button colours put Dawn's white button label
       into --paper, so the nav rendered white text on a white header and the
       bag icon vanished. They follow the page instead, which is what the site
       actually means by them; a theme wanting different button colours sets
       accent, which is what accent is for. */
    { key: 'ink', label: 'Panel background (follows the page)', kind: 'colour',
      prefer: ['color_palette.background', 'page_background_color', 'scheme-1.background',
               'colors_background_1', 'background'] },
    { key: 'paper', label: 'Panel text (follows the page)', kind: 'colour',
      prefer: ['color_palette.foreground', 'page_text_color', 'scheme-1.text',
               'colors_text', 'text'] },
    { key: 'radius', label: 'Corner radius', kind: 'number',
      prefer: ['buttons_radius', 'button_border_radius_primary', 'card_corner_radius',
               'product_corner_radius', 'inputs_radius', 'inputs_border_radius', 'media_radius'] },
    /* Dawn gives a percentage; Fabric gives h1 in pixels and no scale at all.
       Both are read, and compose() tells them apart by magnitude — a value in
       the tens is a font size, a value near 100 is a percentage. */
    { key: 'typeScale', label: 'Type scale', kind: 'number',
      prefer: ['heading_scale', 'body_scale', 'type_size_h1'] },
    { key: 'density', label: 'Section density', kind: 'number',
      prefer: ['spacing_sections', 'spacing_grid_vertical', 'spacing_sections_vertical'] },
    /* Themes disagree on the heading font's id — Dawn says type_header_font,
       others say type_heading_font or type_accent_font. Body was matching and
       heading was not, which is what a one-entry preference list buys you. */
    { key: '_fontHead', label: 'Heading font', kind: 'font',
      prefer: ['type_header_font', 'type_heading_font', 'type_accent_font', 'type_display_font'] },
    { key: '_fontBody', label: 'Body font', kind: 'font',
      prefer: ['type_body_font', 'type_base_font', 'type_paragraph_font'] },
  ];

  function autoAssign(merged, pool) {
    var have = {};
    pool.colours.concat(pool.numbers, pool.fonts).forEach(function (x) { have[x.id] = x.value; });
    var out = {};
    TARGETS.forEach(function (t) {
      for (var i = 0; i < t.prefer.length; i++) {
        if (have[t.prefer[i]] !== undefined) { out[t.key] = t.prefer[i]; return; }
      }
      out[t.key] = '';       // nothing matched — shown as "not mapped"
    });
    return out;
  }

  function valueOf(pool, id) {
    var all = pool.colours.concat(pool.numbers, pool.fonts);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i].value;
    return undefined;
  }

  function metaOf(pool, id) {
    for (var i = 0; i < pool.numbers.length; i++) if (pool.numbers[i].id === id) return pool.numbers[i].meta;
    return null;
  }

  /* Turn the table into tokens. The ONLY place tokens are produced, so what
     the table says is always what gets saved — there is no path where an
     edited row is ignored because some earlier heuristic already decided. */
  function compose(pool, assign) {
    var tokens = { err: '#ef4444' };
    var fonts = {};
    TARGETS.forEach(function (t) {
      var id = assign[t.key];
      if (!id) return;
      var v = valueOf(pool, id);
      if (v === undefined) return;
      if (t.kind === 'colour') {
        tokens[t.key] = (t.key === 'fg' || t.key === 'bg') ? toTriplet(v) : hex(v);
      } else if (t.kind === 'number') {
        var mt = metaOf(pool, id);
        if (t.key === 'radius') tokens.radius = Math.round(v);

        if (t.key === 'typeScale') {
          /* Relative to what the theme calls normal, not to an absolute I
             invented. Dawn's heading_scale is a percentage with default 100, so
             100 means unchanged; Fabric gives an h1 size in pixels with no
             default, so it is measured against a ~56px baseline.

             Guessing by magnitude read Dawn's 100 as a pixel size and produced
             1.79, clamped to the 1.25 maximum — every imported Dawn theme
             arrived with its type as large as the slider allows. */
          var scale;
          if (mt && isFinite(mt.def) && mt.def > 0) scale = v / mt.def;
          else if (mt && mt.unit === '%') scale = v / 100;
          else if (v > 40) scale = v / 56;
          else if (v > 3) scale = v / 100;
          else scale = v;
          tokens.typeScale = Math.max(0.85, Math.min(1.25, scale));
        }

        if (t.key === 'density') {
          /* Dawn's spacing_sections is EXTRA spacing in pixels, 0 to 100,
             default 0 — so 0 is this theme's normal, not the tightest it can
             be. Treating the raw value as a position in my own range mapped
             every unmodified Dawn theme to minimum density, which is what made
             an accurate import look cramped.

             Measured from the setting's own default, so "the designer changed
             nothing" lands on 1. */
          var d = 1;
          if (mt && isFinite(mt.max) && mt.max > mt.min) {
            var from = isFinite(mt.def) ? mt.def : mt.min;
            d = 1 + ((v - from) / (mt.max - mt.min)) * 0.4;
          } else if (v > 0) {
            d = 1 + Math.min(v, 100) / 100 * 0.4;
          }
          tokens.density = Math.max(0.7, Math.min(1.4, d));
        }
      } else if (t.kind === 'font') {
        if (t.key === '_fontHead') fonts.head = fontFamily(v);
        if (t.key === '_fontBody') fonts.body = fontFamily(v);
      }
    });
    return { tokens: tokens, fonts: fonts };
  }

  // ── The mapping ──────────────────────────────────────────────────────────
  function build(schema, data, indexTpl, name, icons) {
    /* settings_data.json has two shapes and a freshly downloaded theme uses the
       one that looks empty:

         { "current": { …values… } }                a store that has been edited
         { "current": "Default",
           "presets": { "Default": { …values… } } } straight from the download

       In the second, `current` names which preset is live and the values sit in
       presets[name]. Discarding a string `current` therefore threw away every
       setting in the file — which is why a real theme imported with almost
       everything unmapped, while the two settings that happened to have schema
       defaults came through fine and made it look like the reader worked. */
    var current = (data && data.current) || {};
    if (typeof current === 'string') {
      var presets = (data && data.presets) || {};
      current = presets[current] || presets[Object.keys(presets)[0]] || {};
    }

    /* Schema defaults fill the gaps. A theme nobody has configured still has a
       schema full of the designer's intended palette, which is exactly the look
       someone copying from the theme store is after. */
    var defaults = {};
    /* What each setting declares about itself: its unit, its range, and the
       value the theme's designer considers normal. This is the difference
       between reading a file and guessing at it — heading_scale of 100 is
       "100%", meaning unchanged, and spacing_sections of 0 is "no extra
       spacing", meaning normal. Guessed by magnitude, the first looked like a
       pixel size and the second like the minimum of a range. */
    var meta = {};
    (Array.isArray(schema) ? schema : []).forEach(function (group) {
      (group.settings || []).forEach(function (s) {
        if (!s || !s.id) return;
        if (s.type === 'range' || s.unit !== undefined) {
          meta[s.id] = { unit: s.unit || '', min: Number(s.min), max: Number(s.max), def: Number(s.default) };
        }
        if (s.default !== undefined) { defaults[s.id] = s.default; return; }

        /* Online Store 2.0 declares colours as a group rather than as flat
           settings: no `default` on the setting itself, a `definition` array of
           the roles inside a scheme, and `role` naming which scheme does what.
           Nothing about it matches the flat shape, so every colour in a modern
           theme was invisible to a reader looking only for `default`.

           Flattened into the same scheme shape settings_data uses, so one
           mapping table reads both. */
        if (s.type === 'color_scheme_group' && Array.isArray(s.definition)) {
          var scheme = {};
          s.definition.forEach(function (d) {
            if (d && d.id && d.default !== undefined) scheme[d.id] = d.default;
          });
          if (Object.keys(scheme).length) {
            defaults[s.id] = defaults[s.id] || {};
            defaults[s.id]['scheme-1'] = { settings: scheme };
          }
        }
      });
    });
    var merged = Object.assign({}, defaults, current);

    var pool = collect(merged, meta);
    var assign = autoAssign(merged, pool);
    var composed = compose(pool, assign);
    var tokens = composed.tokens;
    var fonts = composed.fonts;

    var got = [], missed = [];
    TARGETS.forEach(function (t) {
      if (assign[t.key]) got.push(t.label);
      else missed.push(t.label);
    });

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
    ['Header layout', 'Product page layout', 'Liquid templates and custom sections', 'Images and photography (licensed to the theme)']
      .forEach(function (x) { missed.push(x); });

    /* One id, computed once. Generating it twice - once for the theme and once
       for the `default` that points at it - is two Date.now() calls that can
       land in different milliseconds, and then the default names a theme that
       does not exist and the storefront silently falls back to a built-in. */
    var themeId = 'imported-' + Date.now().toString(36);

    var keys = {
      theme_modes: {
        modes: [{
          id: themeId,
          label: name || 'Imported',
          icon: '\u{1F4E6}',
          // A light page keeps the light structural CSS behind it. Read from the
          // composed background, so it follows the mapping table: remap the
          // background to something dark and the base flips with it.
          base: baseFor(tokens.bg),
          tokens: Object.assign({ err: '#ef4444' }, tokens),
        }],
        default: themeId,
      },
    };

    /* Fonts actually apply now - before this they were reported and thrown
       away. A role here is { stack, url }, so an arbitrary family works: build
       the Google Fonts URL and keep a sensible fallback in the stack.

       The limit worth stating plainly: Shopify's font library is not only
       Google Fonts. It also serves licensed foundry faces from its own CDN
       under its own licence, and those cannot load here at all - not a bug to
       fix, a licence that does not travel. When that happens the stylesheet
       does not resolve, the fallback takes over, and the report names the
       family so you can choose a replacement rather than wonder why the type
       looks wrong. */
    if (fonts.head || fonts.body) {
      var roles = {};
      if (fonts.head) roles.head = googleRole(fonts.head, 'sans-serif');
      if (fonts.body) roles.body = googleRole(fonts.body, 'sans-serif');
      keys.fonts = { roles: roles };
    }

    /* Icons. Shopify keeps them as snippets/icon-*.liquid, which are inline SVG
       with the occasional Liquid tag in an attribute - strip those and the
       markup is portable. This is the one part of a theme's actual DRAWING that
       ports, because an icon is self-contained in a way a template is not. */
    var iconCustom = icons || {};
    if (Object.keys(iconCustom).length) {
      keys.icons = { set: 'outline', overrides: {}, custom: iconCustom };
      got.push('Icons (' + Object.keys(iconCustom).length + ' matched)');
    } else {
      missed.push('Icons');
    }

    return {
      preset: {
        id: 'preset-' + Date.now().toString(36),
        name: name || 'Imported theme',
        scope: 'look',
        createdAt: new Date().toISOString(),
        source: 'shopify-zip',
        keys: keys,
      },
      report: { got: got, missed: missed, sections: sections, fonts: fonts, pool: pool, assign: assign },
    };
  }

  /* A Google Fonts role. Optimistic by design: if the family is not on Google
     the stylesheet does not resolve and the fallback in the stack takes over,
     which is a better outcome than refusing to import a name we could not
     verify ahead of time. */
  function googleRole(family, fallback) {
    var q = String(family).trim().replace(/\s+/g, '+');
    return {
      stack: '"' + family + '", ' + fallback,
      url: 'https://fonts.googleapis.com/css2?family=' + q + ':wght@300;400;500;600;700&display=swap',
    };
  }

  /* Shopify's icon snippet names, mapped to the names used here. Only the ones
     with a real equivalent - an icon with nowhere to go is not worth importing,
     and a half-matched set looks worse than the one you had. */
  var ICON_MAP = {
    'icon-cart': 'bag', 'icon-bag': 'bag', 'icon-cart-empty': 'bag',
    'icon-search': 'search',
    'icon-account': 'account', 'icon-customer': 'account',
    'icon-close': 'close', 'icon-close-small': 'close',
    'icon-hamburger': 'menu', 'icon-menu': 'menu',
    'icon-caret': 'chevron', 'icon-chevron-down': 'chevron', 'icon-arrow-down': 'chevron',
    'icon-heart': 'heart',
    'icon-question': 'support', 'icon-info': 'support',
  };

  function extractIcons(files) {
    var out = {};
    var dec = new TextDecoder();
    Object.keys(files).forEach(function (path) {
      var base = path.split('/').pop().replace(/\.liquid$/i, '');
      var target = ICON_MAP[base];
      if (!target || out[target]) return;          // first match wins
      var text = dec.decode(files[path]);
      var m = text.match(/<svg[\s\S]*?<\/svg>/i);
      if (!m) return;
      var svg = m[0]
        .replace(/\{\{[\s\S]*?\}\}/g, '')          // {{ liquid output }}
        .replace(/\{%[\s\S]*?%\}/g, '')            // {% liquid tags %}
        .replace(/<script[\s\S]*?<\/script>/gi, '');
      /* Follow the theme's text colour. A hardcoded fill would make an imported
         icon invisible on half the palettes it could land on - the whole point
         of currentColor, and the one edit worth making to someone else's SVG. */
      svg = svg.replace(/fill="(?!none)[^"]*"/gi, 'fill="currentColor"')
               .replace(/stroke="(?!none)[^"]*"/gi, 'stroke="currentColor"');
      if (svg.length < 8000) out[target] = svg.trim();
    });
    return out;
  }

  /* Which structural CSS a theme should sit on, from its page colour. Takes the
     bare "r g b" triplet the tokens store rather than a hex, because that is
     the shape the mapping table produces — converting at the call site is how
     the previous version ended up reading a variable that no longer existed.

     Relative luminance, not an average: 128 128 128 and 0 255 0 have the same
     mean and nothing else in common, and green reads far lighter than grey. */
  function baseFor(triplet) {
    var p = String(triplet || '').trim().split(/[\s,]+/).map(Number);
    if (p.length < 3 || p.some(function (n) { return !isFinite(n); })) return 'light';
    return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) < 128 ? 'dark' : 'light';
  }

  // ── Entry point ──────────────────────────────────────────────────────────
  var pending = null;
  var lastBuild = null;

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
               /(^|\/)templates\/index\.json$/.test(n) ||
               /(^|\/)snippets\/icon-[a-z0-9-]+\.liquid$/i.test(n);
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
      var built = build(schema, data, idx, themeName || file.name.replace(/\.zip$/i, ''), extractIcons(files));
      pending = built.preset;
      /* Held so a changed row can rebuild the preset without re-reading the
         zip — the file input is already cleared by then, and asking for the
         file again to change one dropdown would be absurd. */
      lastBuild = built;
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


  /* ── The mapping table ────────────────────────────────────────────────────
     Every row is a guess this import made, shown with the value it read and a
     dropdown of everything else it could have chosen. Change one and the
     preset is rebuilt from the table, because compose() is the only thing that
     produces tokens — there is no path where an edited row is quietly ignored
     by a heuristic that already made up its mind. */
  function renderMapping(built) {
    var pool = built.report.pool;
    var assign = built.report.assign;

    var rows = TARGETS.map(function (t) {
      var options = (t.kind === 'colour' ? pool.colours : t.kind === 'number' ? pool.numbers : pool.fonts);
      var chosen = assign[t.key] || '';
      var val = chosen ? valueOf(pool, chosen) : undefined;

      var preview = '';
      if (t.kind === 'colour' && val) {
        preview = '<span style="width:22px;height:22px;border-radius:4px;border:1px solid var(--border);background:' + esc(val) + ';display:inline-block;flex:0 0 auto;"></span>';
      } else if (val !== undefined) {
        preview = '<code style="font-size:.72rem;color:var(--text-secondary);">' + esc(String(val)) + '</code>';
      } else {
        preview = '<span style="font-size:.72rem;color:var(--text-secondary);">—</span>';
      }

      var opts = '<option value="">Not mapped</option>' + options.map(function (o) {
        return '<option value="' + esc(o.id) + '"' + (chosen === o.id ? ' selected' : '') + '>' +
          esc(o.id) + (t.kind === 'colour' ? '  ' + esc(o.value) : '  (' + esc(String(o.value)) + ')') +
        '</option>';
      }).join('');

      return '<tr>' +
        '<td style="padding:7px 10px 7px 0;font-size:.8rem;white-space:nowrap;">' + esc(t.label) + '</td>' +
        '<td style="padding:7px 10px 7px 0;width:26px;">' + preview + '</td>' +
        '<td style="padding:7px 0;">' +
          '<select onchange="shopifyRemap(&quot;' + esc(t.key) + '&quot;,this.value)" style="width:100%;padding:6px 8px;background:var(--bg-secondary);border:1px solid ' +
            (chosen ? 'var(--border)' : 'var(--error)') + ';border-radius:5px;color:var(--text-primary);font-size:.75rem;font-family:monospace;">' +
            opts +
          '</select>' +
        '</td>' +
      '</tr>';
    }).join('');

    return '<details style="margin-top:14px;" open>' +
      '<summary style="cursor:pointer;font-size:.8rem;color:var(--text-primary);padding:4px 0;">' +
        'How each setting was mapped — change any row that is wrong' +
      '</summary>' +
      '<p style="font-size:.76rem;color:var(--text-secondary);line-height:1.6;margin:8px 0 10px;max-width:74ch;">' +
        'Every row below is a guess. Themes disagree about which setting means what — one calls the button colour <code>colors_accent_1</code>, another puts it in a scheme — so these are picked by preference order and are sometimes wrong. The dropdown lists every setting of the right kind that the theme actually contained.' +
      '</p>' +
      '<table style="width:100%;border-collapse:collapse;">' + rows + '</table>' +
    '</details>';
  }

  /* Change a row: re-compose from the table, replace the pending preset, and
     redraw. The icons and the section list are untouched — they did not come
     from this table and re-deriving them would throw away a correct answer. */
  window.shopifyRemap = function (target, sourceId) {
    if (!lastBuild) return;
    lastBuild.report.assign[target] = sourceId;
    var composed = compose(lastBuild.report.pool, lastBuild.report.assign);

    var modes = lastBuild.preset.keys.theme_modes.modes;
    modes[0].tokens = Object.assign({}, modes[0].tokens, composed.tokens);
    // The page colour decides which structural CSS sits behind the theme, so
    // remapping the background has to move the base with it.
    modes[0].base = baseFor(composed.tokens.bg);
    // A row set to "Not mapped" must actually clear the token, or the value
    // from the previous guess would survive as a ghost.
    TARGETS.forEach(function (t) {
      if (t.kind !== 'font' && !lastBuild.report.assign[t.key]) delete modes[0].tokens[t.key];
    });

    if (composed.fonts.head || composed.fonts.body) {
      var roles = {};
      if (composed.fonts.head) roles.head = googleRole(composed.fonts.head, 'sans-serif');
      if (composed.fonts.body) roles.body = googleRole(composed.fonts.body, 'sans-serif');
      lastBuild.preset.keys.fonts = { roles: roles };
    } else {
      delete lastBuild.preset.keys.fonts;
    }

    lastBuild.report.fonts = composed.fonts;
    lastBuild.report.got = [];
    lastBuild.report.missed = [];
    TARGETS.forEach(function (t) {
      (lastBuild.report.assign[t.key] ? lastBuild.report.got : lastBuild.report.missed).push(t.label);
    });

    pending = lastBuild.preset;
    var out = document.getElementById('shopify-import-report');
    if (out) out.innerHTML = renderReport(lastBuild, lastBuild.preset.name);
  };

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
      renderMapping(built) +
      '<button class="btn btn-primary" style="margin-top:14px;" onclick="shopifyImportKeep()">Save as a theme</button>' +
    '</div>';
  }
})();
