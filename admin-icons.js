/* ────────────────────────────────────────────────────────────────────────────
   admin-icons.js — Appearance → Icons.

   Built to the same shape as Typography, because it is the same decision made
   twice: pick one thing for the whole site, then disagree with it where you
   need to. Fonts have a global role and per-section overrides; icons have a
   global set and per-icon overrides. Anyone who has used one screen already
   knows this one.

   Writes site_settings.icons, which icon-sets.js reads on the storefront:

     { set, overrides: { <name>: <setId> }, custom: { <name>: '<svg …>' } }

   Every icon previews as itself, live, in the grid — an icon picker that makes
   you save and go and look is a picker you use once and then avoid.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var state = { set: 'outline', overrides: {}, custom: {}, frame: 'box' };
  var openName = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function status(msg, bad) {
    var el = document.getElementById('icons-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = bad ? 'var(--error)' : 'var(--success, #4ade80)';
  }

  // The registry is the source of truth for what exists; this screen renders it
  // rather than keeping its own copy that would drift.
  function reg() { return window.ZWIcons || null; }

  async function load() {
    if (!window.sb) return;
    try {
      var res = await sb.from('site_settings').select('value').eq('key', 'icons').maybeSingle();
      var v = res.data && res.data.value;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
      if (v && typeof v === 'object') {
        state = {
          set: v.set || 'outline',
          overrides: v.overrides || {},
          custom: v.custom || {},
          frame: v.frame || 'box',
        };
      }
    } catch (_) {}
    render();
  }

  async function save() {
    try {
      var res = await sb.from('site_settings')
        .upsert({ key: 'icons', value: state }, { onConflict: 'key' });
      if (res.error) throw res.error;
      if (typeof logAdminAudit === 'function') {
        void logAdminAudit('settings.update', 'site_settings', 'icons',
          { set: state.set, frame: state.frame, overrides: Object.keys(state.overrides).length });
      }
      status('Saved — live on the storefront within a minute.');
    } catch (err) {
      status('Could not save: ' + ((err && err.message) || 'unknown error'), true);
    }
  }

  /* Preview through the real registry, so what the grid shows is literally what
     the storefront will draw — not a second renderer that can disagree with it. */
  function svgFor(name, setId) {
    var r = reg();
    if (!r) return '';
    if (state.custom[name] && String(state.custom[name]).trim()) {
      return String(state.custom[name]).replace(/<script[\s\S]*?<\/script>/gi, '');
    }
    return r.get(name, setId || state.overrides[name] || state.set);
  }

  function render() {
    var host = document.getElementById('icons-grid');
    var r = reg();
    if (!host) return;
    if (!r) { host.innerHTML = '<p style="color:var(--text-secondary);font-size:.85rem;">Icon registry not loaded.</p>'; return; }

    var setPicker = document.getElementById('icons-set');
    if (setPicker && !setPicker.options.length) {
      setPicker.innerHTML = r.sets().map(function (s) {
        return '<option value="' + esc(s.id) + '">' + esc(s.label) + '</option>';
      }).join('');
    }
    if (setPicker) setPicker.value = state.set;

    var framePicker = document.getElementById('icons-frame');
    if (framePicker && !framePicker.options.length) {
      framePicker.innerHTML = r.frames().map(function (f) {
        return '<option value="' + esc(f.id) + '">' + esc(f.label) + '</option>';
      }).join('');
    }
    if (framePicker) framePicker.value = state.frame;

    /* The frame preview is a real button drawn with the chosen values, not a
       picture of one — the same reason the icons preview through the registry. */
    var fv = (r.frames().filter(function (f) { return f.id === state.frame; })[0] || {});
    var host2 = document.getElementById('icons-frame-preview');
    if (host2) {
      var vars = r.frameVars(state.frame);
      host2.innerHTML = '<span style="display:inline-flex;align-items:center;gap:.5rem;min-width:44px;min-height:36px;' +
        'padding:.45rem .72rem;justify-content:center;color:var(--text-primary);' +
        'border:' + esc(vars.frame).replace(/var\(--c20\)/, 'currentColor').replace(/var\(--c40\)/, 'currentColor') + ';' +
        'border-radius:' + esc(vars.radius) + ';' +
        'background:' + (vars.fill === 'transparent' ? 'transparent' : 'rgba(127,127,127,.12)') + ';">' +
        '<span style="width:16px;height:16px;display:inline-flex;">' + svgFor('bag') + '</span>' +
        '<span style="font-size:.7rem;">2</span></span>';
    }

    host.innerHTML = r.names().map(function (name) {
      var overridden = !!state.overrides[name] || !!state.custom[name];
      var svg = svgFor(name);
      var choices = '<option value="">Use the set above</option>' +
        r.sets().map(function (s) {
          return '<option value="' + esc(s.id) + '"' + (state.overrides[name] === s.id ? ' selected' : '') + '>' + esc(s.label) + '</option>';
        }).join('');

      return '<div style="border:1px solid var(--border);border-radius:8px;padding:14px;background:var(--bg-primary);' +
             (overridden ? 'border-color:var(--accent);' : '') + '">' +
        '<div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">' +
          '<span style="width:26px;height:26px;display:inline-flex;color:var(--text-primary);">' + svg + '</span>' +
          '<strong style="font-size:.86rem;">' + esc(r.label(name)) + '</strong>' +
          (overridden ? '<span style="font-size:.62rem;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin-left:auto;">Overridden</span>' : '') +
        '</div>' +
        '<select onchange="iconSetOverride(&quot;' + esc(name) + '&quot;,this.value)" style="width:100%;padding:7px 9px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:.78rem;">' + choices + '</select>' +
        '<button class="btn btn-secondary" style="margin-top:8px;width:100%;font-size:.74rem;" onclick="iconToggleCustom(&quot;' + esc(name) + '&quot;)">' +
          (openName === name ? 'Close' : (state.custom[name] ? 'Edit your SVG' : 'Paste your own SVG')) + '</button>' +
        (openName === name
          ? '<textarea oninput="iconSetCustom(&quot;' + esc(name) + '&quot;,this.value)" placeholder="&lt;svg viewBox=&quot;0 0 24 24&quot;&gt;…&lt;/svg&gt;" ' +
            'style="width:100%;margin-top:8px;min-height:88px;padding:8px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-family:monospace;font-size:.72rem;">' + esc(state.custom[name] || '') + '</textarea>' +
            '<div style="font-size:.7rem;color:var(--text-secondary);line-height:1.5;margin-top:6px;">Use <code>currentColor</code> for strokes and fills so it follows the theme. A 24×24 viewBox matches the rest. Leave blank to go back to the set.</div>'
          : '') +
      '</div>';
    }).join('');
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  window.iconSetGlobal = function (v) { state.set = v; render(); };
  window.iconSetFrame = function (v) { state.frame = v; render(); };

  window.iconSetOverride = function (name, v) {
    if (v) state.overrides[name] = v; else delete state.overrides[name];
    render();
  };

  window.iconToggleCustom = function (name) { openName = openName === name ? null : name; render(); };

  window.iconSetCustom = function (name, v) {
    var t = String(v || '').trim();
    if (t) state.custom[name] = t; else delete state.custom[name];
    // Redraw only the preview, not the grid — re-rendering would blur the
    // textarea on every keystroke.
    var host = document.getElementById('icons-grid');
    if (!host) return;
    var cards = host.children;
    var names = reg() ? reg().names() : [];
    var i = names.indexOf(name);
    if (i >= 0 && cards[i]) {
      var slot = cards[i].querySelector('span');
      if (slot) slot.innerHTML = svgFor(name);
    }
  };

  window.iconsSave = save;
  window.iconsReset = function () {
    if (!confirm('Put every icon back to the set default?\n\nYour pasted SVGs are removed too.')) return;
    state.overrides = {}; state.custom = {}; openName = null;
    render(); save();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load, { once: true });
  else load();
})();
