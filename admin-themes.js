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

  /* All four that ship. two-tone was missing from this list while sitting in
     DEFAULT_MODES, so it was the one built-in a click could delete — and
     "Restore built-ins" would then offer it back, which is a confusing round
     trip for something the other three simply refuse. */
  var BUILTIN_IDS = ['dark', 'light', 'super-light', 'two-tone'];

  var DEFAULT_MODES = [
    { id: 'dark', label: 'Dark', icon: '🌙', base: 'dark',
      tokens: { fg: '244 241 235', bg: '9 9 11', ink: '#09090b', paper: '#f4f1eb', surface: '#111113', accent: '#F891A5', err: '#ef4444' } },
    { id: 'light', label: 'Light', icon: '☀️', base: 'light',
      tokens: { fg: '10 10 10', bg: '240 238 233', ink: '#F0EEE9', paper: '#09090b', surface: '#FFFFFF', accent: '#F891A5', err: '#ef4444' } },
    { id: 'super-light', label: 'Super Light', icon: '⚪', base: 'super-light',
      tokens: { fg: '10 10 10', bg: '255 255 255', ink: '#FFFFFF', paper: '#09090b', surface: '#F5F5F5', accent: '#F891A5', err: '#ef4444' } },
    { id: 'two-tone', label: 'Two-tone', icon: '◐', base: 'light',
      tokens: { fg: '10 10 10', bg: '240 238 233', ink: '#F0EEE9', paper: '#09090b', surface: '#FFFFFF', accent: '#F891A5', err: '#ef4444',
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
    /* Named for what they do rather than for what they sound like. --ink is a
       surface and --paper is the text on it, and both track the page: the nav
       draws its links and the bag with color: var(--paper), so a --paper that
       does not contrast with the page is an invisible header. */
    { key: 'ink', label: 'Panel background', kind: 'hex', help: 'Nav bars, drawers and filled panels. Normally the same as the page background — set it apart only if you want those surfaces to differ.' },
    { key: 'paper', label: 'Panel text', kind: 'hex', help: 'What sits on those panels, including the nav links and the bag icon. Must contrast with Panel background or the header goes invisible.' },
    { key: 'err', label: 'Error', kind: 'hex', help: 'Failed payments, validation, anything gone wrong.' },
    /* These three were applied by the engine and settable by nobody — it writes
       --zw-cream, --zw-surface and --zw-fg-hover from them, and this table had
       no row for any of them, so an imported theme could carry them and the
       editor could neither show nor change what it had loaded. Optional, so a
       theme that names none of them is unchanged. */
    { key: 'surfaceAlt', label: 'Raised surface', kind: 'hex', optional: true, help: 'Cards, wells and anything meant to sit just off the page rather than on it. Leave off and these follow the page colour.' },
    { key: 'cream', label: 'Warm surface', kind: 'hex', optional: true, help: 'The warmer panel a few sections use behind editorial content. Off and it follows the page.' },
    { key: 'fgHover', label: 'Hover wash', kind: 'hex', optional: true, help: 'The tint that appears under a row or link on hover. Off and it is derived from the text colour, which is right for most themes.' },
    { key: 'navBg', label: 'Header background', kind: 'hex', optional: true, help: 'Leave off and the header matches the page. Set it to give the site a header in a different colour from the page below it — a black bar over a light page, say.' },
    { key: 'navFg', label: 'Header text', kind: 'hex', optional: true, help: 'Only needed when the header has its own background.' },
    { key: 'barBg', label: 'Announcement bar', kind: 'hex', optional: true, help: 'The strip above the header. Off and it follows the page; on and it can be the loud band that carries a promotion.' },
    { key: 'barFg', label: 'Announcement bar text', kind: 'hex', optional: true, help: 'Only needed when the bar has its own background.' },
    /* ── Prices ────────────────────────────────────────────────────────────
       A markdown is a claim a store makes, and stores want to make it in their
       own palette — green reads as a bargain, red as urgent, the accent as
       "us". All optional: left off, product.css keeps a quiet default where the
       struck figure recedes, the saving is the only element that earns a
       colour, and the price itself inherits the page text so it never fights
       the theme. A store that never opens this still looks considered. */
    { key: 'priceOff', label: 'Saving', kind: 'hex', optional: true, help: 'The "27% off" figure — the only part of a price that earns a colour by default. Green reads as a bargain, red as urgent.' },
    { key: 'priceWas', label: 'Was-price', kind: 'hex', optional: true, help: 'The struck-through original. Should recede: if it competes with the price being charged, shoppers read the wrong number.' },
    { key: 'priceNow', label: 'Price', kind: 'hex', optional: true, help: 'What the shopper pays. Off by default so it matches your body text — set it only if a price should stand apart from everything around it.' },
    { key: 'priceMember', label: 'Member price', kind: 'hex', optional: true, help: 'The member line under the price.' },
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
    { key: 'motion', label: 'Motion', min: 0, max: 1.8, step: 0.1, def: 1,
      help: 'How much the site moves — hovers, reveals, drifts. 0 turns movement off entirely. A visitor whose system asks for reduced motion gets none regardless of this.',
      fmt: function (v) { return v === 0 ? 'None' : v < 0.8 ? 'Restrained' : v > 1.3 ? 'Languid' : 'Standard'; } },
  ];

  /* Header arrangements. Named for the look, not the mechanism — nobody picks
     "grid-template-areas" — and each says what it is good for, because the
     difference between them is a judgement about the shop rather than a
     setting with a right answer. */
  var HEADERS = [
    ['', 'Standard — logo left, links centred, icons right'],
    ['tight', 'Editorial — links run on from the logo, left-aligned'],
    ['stacked', 'Centred — logo on its own row, links beneath'],
    ['split', 'Split — links either side of a centred logo'],
    ['minimal', 'Minimal — logo and icons only, links in the menu'],
  ];

  /* Must stay identical to HDR_PRESETS in theme-engine.js — the engine expands
     a saved preset name, this expands it for the editor, and if they disagree
     the preview shows one header and the storefront renders another. A test
     compares the two tables rather than trusting this comment. */
  var HDR_PRESETS = {
    inline:  { logo: 'left',   links: 'center', actions: 'right', linksRow: 1 },
    tight:   { logo: 'left',   links: 'left',   actions: 'right', linksRow: 1 },
    stacked: { logo: 'center', links: 'center', actions: 'right', linksRow: 2 },
    split:   { logo: 'center', links: 'left',   actions: 'right', linksRow: 1 },
    minimal: { logo: 'left',   links: 'none',   actions: 'right', linksRow: 1 },
  };
  var SPOT_LABELS = { logo: 'Logo', links: 'Categories', actions: 'Icons & bag' };

  /* '' is the shipped arrangement, which is what 'inline' describes — so the
     editor can show its three parts instead of three blanks, while the theme
     still stores nothing and the engine still clears every attribute. */
  function headerSpec(h) {
    if (!h) return Object.assign({}, HDR_PRESETS.inline);
    if (typeof h === 'string') return Object.assign({}, HDR_PRESETS[h] || HDR_PRESETS.inline);
    return {
      logo: h.logo || 'left', links: h.links || 'center',
      actions: h.actions || 'right', linksRow: String(h.linksRow) === '2' ? 2 : 1,
    };
  }
  // An object equal to a preset is shown as that preset, so tweaking a part and
  // tweaking it back does not leave the editor stuck on "Custom".
  function matchPreset(h) {
    var s = headerSpec(h);
    for (var name in HDR_PRESETS) {
      var p = HDR_PRESETS[name];
      if (p.logo === s.logo && p.links === s.links && p.actions === s.actions &&
          String(p.linksRow) === String(s.linksRow)) return name === 'inline' ? '' : name;
    }
    return null;
  }

  /* The curve carries more personality than the durations do. A spring reads
     playful, a linear ramp reads mechanical, and the default glide is what the
     site was built with. */
  var EASINGS = [
    ['cubic-bezier(.32,.72,0,1)', 'Glide (the default)'],
    ['cubic-bezier(.22,1,.36,1)', 'Soft landing'],
    ['cubic-bezier(.34,1.56,.64,1)', 'Spring — overshoots slightly'],
    ['cubic-bezier(.4,0,.2,1)', 'Material'],
    ['linear', 'Mechanical'],
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
  /* Feedback has to arrive where the person is LOOKING. #theme-status lives
     below the per-page grid, which is below the Save button on every theme
     card — so pressing Save wrote its result off-screen and the button read as
     dead whether it had worked or failed. A save with no visible outcome is
     indistinguishable from a save that does nothing, which is exactly how this
     was reported.

     Toast first, because it appears in the corner regardless of scroll. The
     status line is still written for anyone who scrolls to it, and when there
     is no toast the line is scrolled into view rather than left where it
     happens to sit. */
  function status(msg, bad) {
    var el = document.getElementById('theme-status');
    if (el) {
      el.textContent = msg || '';
      el.style.color = bad ? 'var(--error)' : 'var(--success, #4ade80)';
    }
    if (!msg) return;
    if (typeof window.showToast === 'function') {
      try { window.showToast(msg, bad ? 'error' : 'success'); return; } catch (_) {}
    }
    if (el && el.scrollIntoView) {
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { el.scrollIntoView(); }
    }
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
    /* load() guards on this and save() did not, so a page where the Supabase
       client had not initialised reported "sb is not defined" — a message that
       tells the person nothing about what to do. */
    if (!window.sb) { status('Not signed in to the database yet — reload the page and try again.', true); return; }
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

    var curEase = m.tokens.ease || EASINGS[0][0];
    shape += '<div style="margin-bottom:6px;">' +
      '<label style="display:block;font-size:.78rem;font-weight:600;color:var(--text-primary);margin-bottom:3px;">Easing</label>' +
      '<div style="font-size:.73rem;color:var(--text-secondary);line-height:1.5;margin-bottom:6px;">The curve everything moves on. This carries more of a theme’s personality than the speed does.</div>' +
      '<select onchange="themeSetEase(' + i + ',this.value)" style="width:100%;padding:7px 9px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:.78rem;">' +
        EASINGS.map(function (e) {
          return '<option value="' + esc(e[0]) + '"' + (curEase === e[0] ? ' selected' : '') + '>' + esc(e[1]) + '</option>';
        }).join('') +
      '</select></div>';

    var curHeader = m.tokens.header || '';
    var spec = headerSpec(curHeader);
    var presetName = typeof curHeader === 'string' ? curHeader : matchPreset(curHeader);
    var sel = function (part, value, opts) {
      return '<label style="display:block;font-size:.72rem;color:var(--text-secondary);margin-bottom:3px;">' + esc(SPOT_LABELS[part]) + '</label>' +
        '<select onchange="themeSetHeaderPart(' + i + ',\'' + part + '\',this.value)" style="width:100%;padding:6px 8px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:.76rem;">' +
        opts.map(function (o) {
          return '<option value="' + esc(o[0]) + '"' + (value === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
        }).join('') + '</select>';
    };
    var SPOTS = [['left', 'Left'], ['center', 'Center'], ['right', 'Right']];
    // Two parts in the same OUTER zone both take the auto margin and spread
    // apart. Left+left is fine — only the first takes it. Say so where the
    // choice is made rather than letting it look like a rendering bug.
    var clash = spec && spec.logo === spec.actions && spec.logo === 'right';

    shape += '<div style="margin-bottom:6px;">' +
      '<label style="display:block;font-size:.78rem;font-weight:600;color:var(--text-primary);margin-bottom:3px;">Header layout</label>' +
      '<div style="font-size:.73rem;color:var(--text-secondary);line-height:1.5;margin-bottom:6px;">' +
        'Where the logo, the categories and the icons sit. This is what separates two storefronts fastest — faster than colour. Start from a preset, then move any part: the preset is only a name for a combination of the three. On phones every arrangement falls back to the standard header, because a centred two-row bar spends a third of a small screen on chrome.' +
      '</div>' +
      '<select onchange="themeSetHeader(' + i + ',this.value)" style="width:100%;padding:7px 9px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:.78rem;">' +
        HEADERS.map(function (h) {
          return '<option value="' + esc(h[0]) + '"' + (presetName === h[0] ? ' selected' : '') + '>' + esc(h[1]) + '</option>';
        }).join('') +
        (presetName ? '' : '<option value="" selected>Custom — set below</option>') +
      '</select>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,130px),1fr));gap:8px;margin-top:8px;">' +
        '<div>' + sel('logo', spec ? spec.logo : 'left', SPOTS) + '</div>' +
        '<div>' + sel('links', spec ? spec.links : 'center', SPOTS.concat([['none', 'In the menu']])) + '</div>' +
        '<div>' + sel('actions', spec ? spec.actions : 'right', SPOTS) + '</div>' +
      '</div>' +
      '<label style="display:flex;align-items:center;gap:7px;margin-top:8px;font-size:.75rem;color:var(--text-secondary);cursor:pointer;">' +
        '<input type="checkbox"' + (spec && String(spec.linksRow) === '2' ? ' checked' : '') +
        ' onchange="themeSetHeaderPart(' + i + ',\'linksRow\',this.checked?2:1)">' +
        'Categories on a row of their own' +
      '</label>' +
      (clash
        ? '<div style="font-size:.72rem;color:var(--warn,#f59e0b);margin-top:6px;line-height:1.5;">The logo and the icons are both on the right, so they will sit at opposite ends of that side rather than together. Move one to Left or Center if you wanted them adjacent.</div>'
        : '') +
      '</div>';

    /* Which controls appear, and in what order. Roles, not elements — the two
       button systems spell them differently and the stylesheet owns that. */
    var ICONS = [['search', 'Search'], ['account', 'Account'], ['login', 'Login'],
                 ['logout', 'Sign out'], ['shop', 'Shop'], ['bag', 'Bag'], ['menu', 'Menu']];
    var ics = (m.tokens.icons && typeof m.tokens.icons === 'object') ? m.tokens.icons : {};
    var icOrder = ics.order || {}, icHidden = Array.isArray(ics.hidden) ? ics.hidden : [];
    shape += '<div style="margin-bottom:6px;">' +
      '<label style="display:block;font-size:.78rem;font-weight:600;color:var(--text-primary);margin-bottom:3px;">Header controls</label>' +
      '<div style="font-size:.73rem;color:var(--text-secondary);line-height:1.5;margin-bottom:6px;">' +
        'Which controls sit in the bar and in what order. Lower numbers come first; leave a number blank to keep a control where the page already puts it. Menu has no hide box on purpose — on a phone it is the only way into the categories.' +
      '</div>' +
      /* Column headings, and the checkbox reads SHOWN rather than Hide. Checked
         meaning "gone" is the inversion that made a screen of ticks look like a
         configured header when it was an empty one. Positive controls read as
         what you get; negative controls read as what you lose. */
      '<div style="display:flex;align-items:center;gap:8px;font-size:.68rem;color:var(--text-secondary);opacity:.75;letter-spacing:.06em;text-transform:uppercase;margin-bottom:2px;">' +
        '<span style="flex:1;">Control</span><span style="width:64px;">Order</span><span style="width:66px;">Shown</span>' +
      '</div>' +
      '<div style="display:grid;gap:5px;">' +
      ICONS.map(function (ic) {
        var k = ic[0], hidden = icHidden.indexOf(k) !== -1;
        return '<div style="display:flex;align-items:center;gap:8px;font-size:.75rem;color:var(--text-secondary);' +
            (hidden ? 'opacity:.45;' : '') + '">' +
          '<span style="flex:1;">' + esc(ic[1]) + '</span>' +
          '<input type="number" min="1" max="9" value="' + esc(icOrder[k] == null ? '' : icOrder[k]) + '" placeholder="auto" ' +
            'title="Lower numbers sit first. Leave blank to keep this control where the page already puts it." ' +
            'onchange="themeSetIcon(' + i + ',\'' + k + '\',\'order\',this.value)" ' +
            'style="width:64px;padding:4px 6px;background:var(--bg-primary);border:1px solid var(--border);border-radius:5px;color:var(--text-primary);font-size:.74rem;">' +
          (k === 'menu'
            ? '<span style="width:66px;font-size:.68rem;opacity:.6;">always</span>'
            : '<label style="display:flex;align-items:center;gap:4px;width:66px;cursor:pointer;">' +
              '<input type="checkbox"' + (hidden ? '' : ' checked') +
              ' onchange="themeSetIcon(' + i + ',\'' + k + '\',\'hidden\',!this.checked)"></label>') +
        '</div>';
      }).join('') +
      '</div>' +
      /* Hiding everything is a legitimate choice and also almost never the one
         someone meant. Said here, where the choice is made, rather than
         discovered on the storefront. */
      (icHidden.length >= ICONS.length - 1
        ? '<div style="font-size:.72rem;color:var(--warn,#f59e0b);margin-top:8px;line-height:1.5;">Every control is switched off, so the bar will carry the logo and the menu button and nothing else. Shoppers would have no visible route to search, their account or their bag.</div>'
        : '') +
      '</div>';

    /* Only bites when the bag panel feature is on — that is the thing that
       moves account into the panel and quiets the header button. */
    // '' for the default, so choosing it DELETES the key rather than storing a
    // value that means "what would have happened anyway" in every export.
    var curAcct = m.tokens.accountIn === 'header' ? 'header' : '';
    shape += '<div style="margin-bottom:6px;">' +
      '<label style="display:block;font-size:.78rem;font-weight:600;color:var(--text-primary);margin-bottom:3px;">Account link</label>' +
      '<div style="font-size:.73rem;color:var(--text-secondary);line-height:1.5;margin-bottom:6px;">' +
        'With the slide-down bag panel switched on, the account link moves into that panel and the header button goes quiet. Keep it in the header if you would rather it stayed put — the panel keeps its own copy either way, so nobody loses the route to their account.' +
      '</div>' +
      '<select onchange="themeSetToken(' + i + ',\'accountIn\',this.value)" style="width:100%;padding:7px 9px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:.78rem;">' +
        [['', 'In the bag panel — the header button hides'],
         ['header', 'Always in the header']].map(function (o) {
          return '<option value="' + esc(o[0]) + '"' + (curAcct === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
        }).join('') +
      '</select></div>';

    /* Icons as words. Reads aria-label, which these controls already carry, so
       it needs no markup and cannot miss a nav dialect. */
    var curLabels = m.tokens.iconLabels || 'off';
    shape += '<div style="margin-bottom:6px;">' +
      '<label style="display:block;font-size:.78rem;font-weight:600;color:var(--text-primary);margin-bottom:3px;">Icons or words</label>' +
      '<div style="font-size:.73rem;color:var(--text-secondary);line-height:1.5;margin-bottom:6px;">' +
        'Show the search, bag and menu controls as words instead of glyphs. The wording comes from the label each control already carries for screen readers, so it stays in step with them. The bag keeps its count — it reads “Bag 2”.' +
      '</div>' +
      '<select onchange="themeSetToken(' + i + ',\'iconLabels\',this.value)" style="width:100%;padding:7px 9px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:.78rem;">' +
        [['off', 'Icons everywhere'],
         ['mobile', 'Words on phone and tablet, icons above'],
         ['always', 'Words at every width']].map(function (o) {
          return '<option value="' + esc(o[0]) + '"' + (curLabels === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
        }).join('') +
      '</select>' +
      (curLabels === 'off' ? '' :
        '<label style="display:block;font-size:.72rem;color:var(--text-secondary);margin:8px 0 3px;">Label font</label>' +
        '<input type="text" value="' + esc(m.tokens.labelFont || '') + '" placeholder="Match the body font" ' +
          'onchange="themeSetToken(' + i + ',\'labelFont\',this.value)" ' +
          'style="width:100%;padding:6px 8px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:.76rem;">' +
        '<div style="font-size:.72rem;color:var(--text-secondary);margin-top:4px;line-height:1.5;">Left empty these match the body font and follow it whenever it changes. Name a family to break them out — any CSS font stack, or one of the fonts you loaded under Typography.</div>') +
      '</div>';

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

    /* Say when the built-ins are gone. An import applied before that was fixed
       could overwrite this list, and the result is silent: the themes are
       simply not there, with nothing to explain where they went or that a
       button exists to bring them back. Someone hunting for Dark and Light has
       no reason to read a button called "Restore built-ins" as the answer —
       they are looking for a list, not a repair.

       Rendered above the list rather than as a toast, because the state
       persists and a toast does not. */
    var absent = DEFAULT_MODES.filter(function (d) {
      return !state.modes.some(function (m) { return m.id === d.id; });
    });
    var notice = absent.length
      ? '<div style="border:1px solid var(--accent,#F891A5);border-radius:8px;padding:14px 16px;background:var(--bg-primary);">' +
          '<strong style="font-size:.9rem;">' + absent.length + ' built-in theme' + (absent.length > 1 ? 's are' : ' is') + ' missing</strong>' +
          '<div style="font-size:.8rem;color:var(--text-secondary);margin:6px 0 10px;line-height:1.6;">' +
            esc(absent.map(function (m) { return m.label; }).join(', ')) +
            ' — most likely overwritten by a theme import. Bringing them back leaves everything currently in the list alone, ' +
            'including a built-in you have recoloured on purpose.' +
          '</div>' +
          '<button class="btn btn-secondary" onclick="themeRestoreBuiltins()">Bring them back</button>' +
        '</div>'
      : '';

    host.innerHTML = notice + state.modes.map(function (m, i) {
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
    if (on) m.tokens[key] = (key === 'navFg' || key === 'barFg') ? '#f4f1eb' : '#09090b';
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

  window.themeSetEase = function (i, v) {
    var m = state.modes[i];
    if (!m) return;
    m.tokens.ease = v;
    visPaint();
  };

  window.themeSetHeader = function (i, v) {
    var m = state.modes[i];
    if (!m) return;
    // Absent, not empty-string: the engine removes the attribute when there is
    // no value, and an empty string is a value that matches no preset.
    if (v) m.tokens.header = v; else delete m.tokens.header;
    render();
    visPaint();
  };

  /* Moving one part expands whatever is stored into the full object first, so a
     theme on a preset does not lose the other two parts the moment you nudge
     one. Stored back as a preset NAME when it still matches one — a saved theme
     that reads "stacked" survives a round trip through this editor instead of
     silently becoming four coordinates that mean the same thing. */
  /* Generic setter for the plain-value tokens. An empty value DELETES the key
     rather than storing '', because the engine treats absent as "inherit the
     default" and an empty string as a value — a font of '' would beat the CSS
     fallback and land the label on the browser's default serif. */
  window.themeSetToken = function (i, key, value) {
    var m = state.modes[i];
    if (!m) return;
    var v = String(value == null ? '' : value).trim();
    if (v && v !== 'off') m.tokens[key] = v; else delete m.tokens[key];
    render();
    visPaint();
  };

  /* Prunes itself back to absent when nothing is set, so a theme that was
     fiddled with and put back does not carry an empty icons object around —
     and so exported presets stay readable. */
  window.themeSetIcon = function (i, key, field, value) {
    var m = state.modes[i];
    if (!m) return;
    var ics = (m.tokens.icons && typeof m.tokens.icons === 'object') ? m.tokens.icons : {};
    var order = Object.assign({}, ics.order || {});
    var hidden = (Array.isArray(ics.hidden) ? ics.hidden : []).slice();
    if (field === 'order') {
      var n = parseInt(value, 10);
      if (isFinite(n)) order[key] = n; else delete order[key];
    } else {
      var at = hidden.indexOf(key);
      if (value && at === -1) hidden.push(key);
      if (!value && at !== -1) hidden.splice(at, 1);
    }
    var next = {};
    if (Object.keys(order).length) next.order = order;
    if (hidden.length) next.hidden = hidden;
    if (Object.keys(next).length) m.tokens.icons = next; else delete m.tokens.icons;
    render();
    visPaint();
  };

  window.themeSetHeaderPart = function (i, part, value) {
    var m = state.modes[i];
    if (!m) return;
    var spec = headerSpec(m.tokens.header);
    spec[part] = part === 'linksRow' ? (String(value) === '2' ? 2 : 1) : String(value);
    var name = matchPreset(spec);
    if (name === '') delete m.tokens.header;
    else if (name) m.tokens.header = name;
    else m.tokens.header = spec;
    render();
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

  /* Bring back any built-in that is missing.

     Merging protects future applies; it cannot resurrect what an earlier one
     already deleted. A store whose theme list was overwritten by an import has
     no way back — the engine only falls back to the built-ins when the row is
     EMPTY, and a list with one imported theme in it is not empty. So this adds
     back whichever of the four are gone and leaves everything else alone,
     including a built-in that has been recoloured on purpose. */
  window.themeRestoreBuiltins = async function () {
    var missing = DEFAULT_MODES.filter(function (d) {
      return !state.modes.some(function (m) { return m.id === d.id; });
    });
    if (!missing.length) { status('All four built-in themes are already here.'); return; }
    if (!confirm('Add back ' + missing.length + ' missing built-in theme' + (missing.length > 1 ? 's' : '') +
                 ' (' + missing.map(function (m) { return m.label; }).join(', ') + ')?\n\n' +
                 'Nothing already in the list is touched — including a built-in you have recoloured.')) return;
    state.modes = state.modes.concat(JSON.parse(JSON.stringify(missing)));
    render();
    await save();
    status('Restored: ' + missing.map(function (m) { return m.label; }).join(', ') + '.');
  };

  window.themeSave = save;
  window.themeLoad = load;

  function boot() { load(); visInit(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
