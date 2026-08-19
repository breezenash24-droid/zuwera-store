/* ────────────────────────────────────────────────────────────────────────────
   zw-copy.js — every word on the storefront, editable from the page builder.

   The builder could only ever edit text a page SECTION owned, because a section
   has settings to write into. Three kinds of text had no such home:

     • the nav labels          owned by site_settings.nav_menu
     • the announcement bar    owned by site_settings.announcement_bar
     • copy baked into a page template, owned by nobody at all

   The first two already have owners, so inline editing writes to THOSE keys.
   It does not shadow them with a second store — a value you can set in two
   places that disagree is the exact fault this codebase has already had to
   remove from the announcement bar once.

   The third had no owner. text_overrides is it: a page path, a stable element
   path, and { was, now }.

   ── WHY `was` DECIDES WHETHER AN OVERRIDE APPLIES ───────────────────────────

   An override is anchored to a POSITION in the markup, and markup changes on
   deploy. Without a check, an override would keep rewriting whatever text moved
   into that position — silently, on the live site, forever. So an override only
   applies while the element's own text still equals the original it replaced. A
   stale override does nothing, which is the only safe way for it to fail.

   ── WHAT THIS FILE DOES ON A NORMAL PAGE LOAD ───────────────────────────────

   Applies published overrides. That is all. The editor below it initialises
   only under window.__ZW_BUILDER_PREVIEW__, so a shopper never loads a line of
   it beyond the guard.

   It lives here rather than in storefront.js because storefront.js is the
   HOMEPAGE's script: the editor used to be in it, and so inline editing only
   worked on the homepage preview — while the nav and the bar, the two things
   most in need of it, appear on every page.
   ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFmZ25yc2lmY3dkdWJrb2xzZ3NxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMDgzMTUsImV4cCI6MjA4ODU4NDMxNX0.wthoTJEdQhLKnrTwq7nuzAB3Q3FV5rOGVcyi5v1jyLY';
  var REST = 'https://qfgnrsifcwdubkolsgsq.supabase.co/rest/v1/site_settings?select=value&key=eq.text_overrides';
  var CACHE = 'zw_text_overrides';

  var overrides = null;     // { "<page>": { "<path>": {was, now} } }
  var applying = false;     // re-entry guard: we mutate text, the observer sees it

  function norm(s) {
    return String(s == null ? '' : s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  }

  /* The page half of a key. Clean URLs mean /about and /about.html are the same
     page (Cloudflare 308s one to the other), so an override saved from one must
     apply to the other. */
  function pageKey() {
    var p = '/';
    try { p = location.pathname || '/'; } catch (_) {}
    p = p.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
    return p || '/';
  }

  /* A leaf is an element with no ELEMENT child that itself holds text. Asking
     about text rather than about tag names is what lets this agree with the
     editor's own idea of what is editable. */
  function isTextLeaf(el) {
    if (!el || !el.children) return false;
    for (var i = 0; i < el.children.length; i++) {
      if ((el.children[i].textContent || '').trim()) return false;
    }
    return true;
  }

  /* The element's OWN text nodes, ignoring any that belong to its children.
     applyOverrides needs this on a shopper's page, not just in the editor, so
     it lives out here beside isTextLeaf rather than inside initEditor. */
  function directTextNodes(el) {
    var out = [];
    if (!el) return out;
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) out.push(n);
    }
    return out;
  }

  /* CLASSES THAT ARE NOT PART OF AN ELEMENT'S IDENTITY.

     A class in the path has to mean the same thing every time the page is
     rendered, and these do not — they are added and removed while you are
     looking at the page.

     scroll-reveal.js is the one that actually broke this: it puts zw-reveal on
     everything it watches and zw-revealed on each element as it scrolls into
     view. So the same paragraph is `p.notify-hint` above the fold and
     `p.notify-hint.zw-revealed` once you have scrolled to it. An override saved
     while it was revealed then failed to match the un-revealed page, and the
     text silently did not update — which is exactly how this was reported. */
  var VOLATILE_CLASS = /^(zw-(ite|sel|hover|reveal|revealed)|active|open|show|shown|visible|hidden|selected|current|in-view|is-[\w-]+|has-[\w-]+)$/;

  /* Two identities per element, and both are stored.

     `path` keeps the class names, because they make a key legible and keep two
     sibling paragraphs apart. `loose` is tag and position only, and is what
     rescues an override when a class changes anyway — a redesign, a new state
     class, anything I have not thought of.

     Matching loosely is safe here ONLY because applying an override also
     requires the element's text to equal `was`. The text check is the real
     guard; the path just finds candidates. */
  function elPath(el, noClasses) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + el.id;
    var parts = [], node = el, guard = 0;
    while (node && node.nodeType === 1 && node !== document.body && guard++ < 12) {
      if (node.id) { parts.unshift('#' + node.id); break; }
      var cls = '';
      if (!noClasses) {
        cls = (node.getAttribute('class') || '').trim().split(/\s+/)
          .filter(function (c) { return c && !VOLATILE_CLASS.test(c); })
          /* Sorted, not in attribute order: a renderer that emits the same
             classes in a different order must not produce a different key. */
          .sort().slice(0, 2).join('.');
      }
      var idx = 0, sibs = 0;
      if (node.parentElement) {
        var kids = node.parentElement.children;
        for (var i = 0; i < kids.length; i++) {
          if (kids[i].tagName === node.tagName) { if (kids[i] === node) idx = sibs; sibs++; }
        }
      }
      /* The index is ALWAYS written, never only when there are siblings.
         Conditional on sibs > 1, an element is `div` while it is an only child
         and `div:0` the moment a sibling appears -- and the builder preview
         injects elements the live page does not have, so the same element
         genuinely had two different identities in the two places an override
         is written and read. That alone stopped saved overrides matching. */
      parts.unshift(node.tagName.toLowerCase() + (cls ? '.' + cls : '') + ':' + idx);
      node = node.parentElement;
    }
    return parts.join('>');
  }
  function loosePath(el) { return elPath(el, true); }

  /* Strip volatile classes out of a path that was ALREADY STORED.

     Overrides saved before those classes were excluded have them baked into the
     key — live data looks like

         #about>div.zw-reveal.zw-revealed:0>h2.about-h2

     and no element ever computes that again, so the override is inert. Fixing
     elPath only helps edits made from now on; every override saved before it is
     silently dead until the key is read the same way it is now written. So the
     stored side gets normalised too, and the two are compared normalised. */
  function normStoredPath(p) {
    var str = String(p || ''), slot = '';
    var cut = str.indexOf('|t');
    if (cut > -1) { slot = str.slice(cut); str = str.slice(0, cut); }
    return slot === '' ? _normSegs(str) : _normSegs(str) + slot;
  }
  function _normSegs(p) {
    return String(p || '').split('>').map(function (seg) {
      if (seg.charAt(0) === '#') return seg;
      var idx = '', m = /:(\d+)$/.exec(seg);
      if (m) { idx = ':' + m[1]; seg = seg.slice(0, m.index); }
      var bits = seg.split('.');
      var tag = bits.shift();
      var cls = bits.filter(function (c) { return c && !VOLATILE_CLASS.test(c); }).sort().slice(0, 2);
      /* A stored segment with no index was written when the element had no
         siblings, which means index 0. Spelling it out is what lets an old key
         line up with a path that now always carries one. */
      return tag + (cls.length ? '.' + cls.join('.') : '') + (idx || ':0');
    }).join('>');
  }

  /* One pass over the leaves, matching each against the stored paths.

     Two indexes, tried in order: the exact path, then the class-free one. The
     loose index is what keeps an override working when a class changes under it
     — and it is safe to be that permissive because an override is applied only
     when the element's text still equals `was`. Finding the wrong element gets
     you nothing; the text check refuses it. */
  function applyOverrides() {
    if (!overrides || applying || !document.body) return;
    var map = overrides[pageKey()];
    if (!map) return;
    var keys = Object.keys(map);
    if (!keys.length) return;

    /* Three indexes, widest last. The normalised one is what rescues overrides
       stored before volatile classes were excluded from the key; the loose one
       rescues anything else that changes class later. Both are safe to be this
       permissive because the text check below still has to pass. */
    var byNorm = {}, byLoose = {};
    for (var k = 0; k < keys.length; k++) {
      var e = map[keys[k]];
      if (!e) continue;
      var n = normStoredPath(keys[k]);
      if (!byNorm[n]) byNorm[n] = e;
      if (e.loose && !byLoose[e.loose]) byLoose[e.loose] = e;
    }

    applying = true;
    try {
      var els = document.body.querySelectorAll('*');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var p = elPath(el);

        /* Text nodes that share their element with another element -- the
           `Release<br><span>002</span>` shape. Each is keyed `<path>|t<n>` and
           only its own nodeValue is touched, so the <br> and the span survive
           (assigning textContent to the parent would flatten all three). */
        var tns = directTextNodes(el);
        for (var t = 0; t < tns.length; t++) {
          var key = p + '|t' + t;
          var te = map[key] || byNorm[key] || byLoose[loosePath(el) + '|t' + t];
          if (!te || typeof te.now !== 'string') continue;
          var cur = norm(tns[t].nodeValue);
          if (cur === norm(te.now)) { el.setAttribute('data-zw-was-t' + t, te.was); continue; }
          if (cur !== norm(te.was)) continue;
          el.setAttribute('data-zw-was-t' + t, te.was);
          tns[t].nodeValue = te.now;
        }

        if (!isTextLeaf(el)) continue;
        var entry = map[p] || byNorm[p] || byLoose[loosePath(el)];
        if (!entry || typeof entry.now !== 'string') continue;
        if (norm(el.textContent) === norm(entry.now)) {
          /* Already showing the override. Keep the anchor so a second edit knows
             what the ORIGINAL was and does not save the override as the thing it
             replaces. */
          el.setAttribute('data-zw-was', entry.was);
          continue;
        }
        if (norm(el.textContent) !== norm(entry.was)) continue;   // stale: do nothing
        el.setAttribute('data-zw-was', entry.was);
        el.textContent = entry.now;
      }
    } catch (_) {} finally { applying = false; }
  }

  /* Once the builder has handed us a draft, the PUBLISHED copy from the server
     is stale by definition and must never replace it.

     Without this the fetch below races the builder's push: the preview iframe
     starts its request, the builder posts the draft on iframe load, and if the
     response lands second it silently reinstates the published words. Which
     reads exactly like "my edit did not take" — intermittently, depending on
     how fast the network was. */
  var draftPushed = false;
  function setOverrides(next, fromDraft) {
    if (draftPushed && !fromDraft) return;
    if (fromDraft) draftPushed = true;
    overrides = next && typeof next === 'object' ? next : null;
    applyOverrides();
  }

  /* Sections, the nav and the bar all render after this file runs, so applying
     once is never enough. Debounced, and guarded against the mutations this file
     causes itself. */
  var _t = 0;
  function schedule() { clearTimeout(_t); _t = setTimeout(applyOverrides, 60); }

  function watch() {
    if (!document.body || typeof MutationObserver !== 'function') return;
    try {
      new MutationObserver(function () { if (!applying) schedule(); })
        .observe(document.body, { childList: true, subtree: true, characterData: true });
    } catch (_) {}
  }

  /* Cache first so an override does not flash the original text on every load,
     then refresh from the server. Same shape as nav-menu.js's cache. */
  try {
    var c = localStorage.getItem(CACHE);
    if (c) overrides = JSON.parse(c);
  } catch (_) {}

  function boot() {
    watch();
    applyOverrides();
    /* A ?zwpreview= link resolves to draft settings; take the draft copy from
       there so an unpublished preview shows unpublished words. */
    if (window.__zwPreviewReady && window.__zwPreviewReady.then) {
      window.__zwPreviewReady.then(function (p) {
        if (p && p.text_overrides) setOverrides(p.text_overrides, true);
      }).catch(function () {});
    }
    if (window.__ZW_BUILDER_PREVIEW__) initEditor();
  }

  fetch(REST, { headers: { apikey: ANON, Authorization: 'Bearer ' + ANON }, cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (rows) {
      if (!rows || !rows.length) return;
      var v = rows[0] && rows[0].value;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
      if (!v) return;
      try { localStorage.setItem(CACHE, JSON.stringify(v)); } catch (_) {}
      setOverrides(v);
    })
    .catch(function () {});

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.ZWCopy = { apply: applyOverrides, set: setOverrides, path: elPath, pageKey: pageKey };

  /* ══════════════════════════════════════════════════════════════════════════
     THE EDITOR — builder preview only, never on a shopper's page.
     ══════════════════════════════════════════════════════════════════════════ */
  function initEditor() {
    /* Everything that carries copy. The decision that actually matters is made
       by isTextLeaf(); this list only keeps the walk off images and inputs. */
    var EDITABLE = /^(H[1-6]|P|SPAN|A|LI|BLOCKQUOTE|SUMMARY|STRONG|EM|DIV|BUTTON|LABEL|SMALL|FIGCAPTION|CAPTION|LEGEND|DT|DD|TD|TH|B|I|U|S|MARK|ABBR|CITE|TIME|CODE|Q|SUB|SUP|ADDRESS|PRE|OUTPUT|DATA)$/;
    var FONTS_HEAD = [['','Default font'],['barlow-condensed','Barlow Condensed'],['oswald','Oswald'],['bebas-neue','Bebas Neue'],['anton','Anton'],['league-gothic','League Gothic'],['michroma','Michroma'],['montserrat','Montserrat'],['syne','Syne'],['archivo-black','Archivo Black'],['teko','Teko'],['righteous','Righteous'],['playfair-display','Playfair Display'],['cinzel','Cinzel'],['futura','Futura'],['futura-100-demibold','Futura 100 Demibold']];
    var FONTS_BODY = [['','Default font'],['barlow','Barlow'],['inter','Inter'],['dm-sans','DM Sans'],['outfit','Outfit'],['manrope','Manrope'],['poppins','Poppins'],['lato','Lato'],['roboto','Roboto'],['work-sans','Work Sans'],['mulish','Mulish'],['futura','Futura']];
    var _FONT_STACKS = window._ZW_FONT_STACKS || {};

    var st = document.createElement('style');
    st.textContent =
      'body.zw-text-edit :is(h1,h2,h3,h4,h5,h6,p,span,a,li,blockquote,summary,label,small,figcaption,dt,dd,td,th,b,i,time,button,div){cursor:text}'
    + 'body.zw-text-edit .zw-ite-hi{outline:2px dashed rgba(248,145,165,.7);outline-offset:2px;border-radius:2px}'
    + 'body.zw-text-edit .zw-ite-chrome{outline-color:rgba(120,190,255,.85)}'
    + 'body.zw-text-edit [contenteditable="true"]{outline:2px solid rgba(248,145,165,.95);outline-offset:2px;border-radius:2px;cursor:text}'
    + '#zw-ite-bar{position:fixed;z-index:2147483000;background:#141416;border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:.4rem .5rem;display:flex;gap:.45rem;align-items:center;box-shadow:0 8px 26px rgba(0,0,0,.55);font-family:system-ui,-apple-system,sans-serif}'
    + '#zw-ite-bar label{color:#9a9a9a;font-size:.56rem;letter-spacing:.1em;text-transform:uppercase}'
    + '#zw-ite-bar .zw-ite-what{color:#7fd07f;font-size:.6rem;letter-spacing:.06em;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '#zw-ite-bar select{background:#000;color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:5px;font-size:.72rem;padding:.28rem .4rem;max-width:160px}'
    + '#zw-ite-bar button{background:#f4f1eb;color:#111;border:none;border-radius:5px;font-size:.7rem;font-weight:600;padding:.32rem .62rem;cursor:pointer}'
    + '.zw-ite-rej{position:fixed;z-index:2147483001;max-width:280px;background:#2a1113;border:1px solid #e07060;color:#f4b8a0;border-radius:7px;padding:.45rem .6rem;font-family:system-ui,-apple-system,sans-serif;font-size:.72rem;line-height:1.45;box-shadow:0 8px 26px rgba(0,0,0,.55)}'
    + '@keyframes zw-ite-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}'
    + '.zw-ite-shake{animation:zw-ite-shake .22s ease 2}';
    document.head.appendChild(st);

    var editing = null, origText = '', ownerSec = '', ownerField = '', bar = null, hovered = null;
    /* editingTi >= 0 means one text node of `editing` is being edited rather
       than the whole element; editWrap is the temporary span around it. */
    var editingTi = -1, editWrap = null;
    function wrapSlot(node) {
      editWrap = document.createElement('span');
      editWrap.setAttribute('data-zw-tmp', '1');
      node.parentNode.insertBefore(editWrap, node);
      editWrap.appendChild(node);
      editWrap.contentEditable = 'true';
      return editWrap;
    }
    function unwrapSlot() {
      if (!editWrap) return;
      var t = document.createTextNode(editWrap.textContent || '');
      if (editWrap.parentNode) editWrap.parentNode.replaceChild(t, editWrap);
      editWrap = null;
    }

    function isHeading(el) { return /^H[1-6]$/.test(el.tagName); }

    /* textContent, NOT innerText. innerText returns the RENDERED text and Chrome
       applies text-transform to it, so an uppercase-styled label read back in
       caps while its stored value was mixed case — and every lookup that tried
       to match it failed. */
    function txt(el) { return (el.textContent || '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\s+$/, ''); }

    function editableFrom(node, root) {
      var el = (node && node.nodeType === 3) ? node.parentElement : node;
      while (el && el.nodeType === 1 && el !== document.body && el !== root) {
        if (EDITABLE.test(el.tagName) && (el.textContent || '').trim() && isTextLeaf(el)) return el;
        el = el.parentElement;
      }
      return null;
    }


    /* ── A WORD THAT SHARES ITS ELEMENT WITH ANOTHER ELEMENT ──────────────────

       The release title renders as

           <div class="drop-title">Release<br><span>002</span></div>

       so "002" is a leaf and was editable, while "Release" is a bare text node
       in a parent that is NOT a leaf — and nothing could select it. Reported
       exactly that way: the numbers after it are editable, the word itself is
       not. It is a common shape, not a quirk; any heading built as
       `Word<br><span>other</span>` has it.

       A text slot is that text node: its parent, plus which of the parent's own
       text nodes it is. Stored as `<path>|t<n>` so the parent's other children
       are untouched, and so the <br> survives — assigning textContent to the
       parent would flatten all three into one string. */

    /* Which text node is under the pointer. A click's target is the ELEMENT, so
       the text node has to come from the caret position. */
    function caretTextNode(e) {
      try {
        var r = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
        if (r && r.startContainer && r.startContainer.nodeType === 3) return r.startContainer;
      } catch (_) {}
      return null;
    }

    /* Prefer a whole element when it is a leaf — that keeps every existing edit
       behaving as it did. Only reach for a text slot when the element holds more
       than text, which is the case that had no answer at all. */
    function targetAt(e) {
      var leaf = editableFrom(e.target, null);
      if (leaf) return { el: leaf, ti: -1 };
      var tn = caretTextNode(e);
      var parent = tn && tn.parentElement;
      if (!parent || !EDITABLE.test(parent.tagName)) return null;
      var tns = directTextNodes(parent);
      var i = tns.indexOf(tn);
      if (i < 0) return null;
      return { el: parent, ti: i, node: tn };
    }

    /* WHO OWNS THIS TEXT — the whole design, in one function.

       A named field wins over a section, because the nav and the bar sit inside
       page chrome that no section owns and their fields are exact: no text
       matching, nothing to mis-map. A section is next, because its settings are
       the right home for its own copy. An override is the last resort, and only
       for text nothing else claims. */
    function ownerOf(el) {
      var f = el.closest && el.closest('[data-zw-field]');
      if (f) return { kind: 'field', field: f.getAttribute('data-zw-field'), label: f.getAttribute('data-zw-field-label') || 'site setting' };
      var s = el.closest && el.closest('[data-zw-sec]');
      if (s) return { kind: 'section', sec: s.getAttribute('data-zw-sec'), label: 'this section' };
      return { kind: 'override', label: 'page copy' };
    }

    function opts(list, cur) {
      return list.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('');
    }
    function currentFontKey(el, head) {
      var secEl = el.closest && el.closest('[data-zw-sec]');
      var v = secEl ? (secEl.style.getPropertyValue(head ? '--zw-font-head' : '--zw-font-body') || '').trim() : '';
      if (v) { for (var k in _FONT_STACKS) { if (_FONT_STACKS[k] === v) return k; } }
      return '';
    }
    function placeBar(el) {
      if (!bar) return;
      var r = el.getBoundingClientRect();
      var top = r.top - bar.offsetHeight - 8; if (top < 6) top = r.bottom + 8;
      var left = r.left; if (left + bar.offsetWidth > window.innerWidth - 6) left = window.innerWidth - 6 - bar.offsetWidth;
      bar.style.top = Math.max(6, top) + 'px'; bar.style.left = Math.max(6, left) + 'px';
    }
    function showBar(el, owner) {
      hideBar();
      var head = isHeading(el);
      bar = document.createElement('div'); bar.id = 'zw-ite-bar';
      /* Say where the words are going. A nav label and a heading look identical
         on the canvas and are stored in completely different places; the one
         thing you cannot tell by looking is which. */
      var what = '<span class="zw-ite-what">saves to ' + owner.label + '</span>';
      /* The font control is section-only: it writes a section setting, and there
         is no such setting behind a nav label or a line of template copy. */
      var font = owner.kind === 'section'
        ? '<label>Font</label><select data-role="font">' + opts(head ? FONTS_HEAD : FONTS_BODY, currentFontKey(el, head)) + '</select>'
        : '';
      bar.innerHTML = what + font + '<button data-role="done">Done</button>';
      document.body.appendChild(bar);
      placeBar(el);
      bar.addEventListener('mousedown', function (ev) { if (!ev.target.closest('select,button,option,input')) ev.preventDefault(); });
      var sel = bar.querySelector('[data-role="font"]');
      if (sel) sel.addEventListener('change', function (ev) {
        try { window.parent.postMessage({ type: 'ZW_INLINE_FONT', sectionId: owner.sec, which: head ? 'head' : 'body', value: ev.target.value }, location.origin); } catch (_) {}
      });
      bar.querySelector('[data-role="done"]').addEventListener('mousedown', function (ev) { ev.preventDefault(); commit(); });
    }
    function hideBar() { if (bar) { bar.remove(); bar = null; } }

    /* An edit is not saved until the builder says it is. Committing used to fire
       the message and move on, so when the builder could not store it the
       preview went on showing words that were never kept — and the loss only
       surfaced later, at publish. */
    var pending = {}, pendSeq = 0;
    function commit() {
      if (!editing) return;
      var el = editing, was = origText;
      var sec = ownerSec, field = ownerField, ti = editingTi;
      var nt;
      if (ti >= 0) {
        /* Only the wrapped text node changed; read it, then put the node back so
           the element is exactly as it was apart from the words. */
        nt = txt(editWrap);
        unwrapSlot();
      } else {
        nt = txt(el);
        el.contentEditable = 'false';
      }
      editing = null; editingTi = -1; hideBar();
      if (nt === was) return;
      var id = 'ite' + (++pendSeq);
      pending[id] = { el: el, was: was, ti: ti };
      var anchorAttr = el.getAttribute(ti >= 0 ? 'data-zw-was-t' + ti : 'data-zw-was');
      var slot = ti >= 0 ? '|t' + ti : '';
      var msg;
      if (field) {
        msg = { type: 'ZW_CHROME_TEXT', id: id, field: field, newText: nt };
      } else if (sec) {
        /* BEING IN A SECTION IS A PREFERENCE, NOT AN EXCLUSION.

           A section owns only the strings it has settings for. The release
           section, for instance, has four — eyebrow, title, notify_label and the
           launch date — while "LAUNCHING IN", "DAYS", "No spam, ever." and the
           button are plain markup with no field behind them. That is the normal
           case, not the exception: most words inside a section are template copy.

           Sending the section id alone meant the builder could only answer "no
           field holds that" and reject, which visibly snapped the words back and
           put the majority of the page out of reach. The page and path travel
           with it so the builder can fall through to an override in the same
           round trip: a real section field still wins, and everything else lands
           somewhere instead of nowhere. */
        msg = {
          type: 'ZW_INLINE_TEXT', id: id, sectionId: sec, oldText: was, newText: nt,
          page: pageKey(), path: elPath(el) + slot, loose: loosePath(el) + slot,
          was: anchorAttr != null ? anchorAttr : was
        };
      } else {
        /* data-zw-was is the ORIGINAL, kept by applyOverrides when it painted an
           earlier override. Editing twice must not record the first edit as the
           text being replaced, or the override stops matching the template and
           silently stops applying. */
        msg = {
          type: 'ZW_TEXT_OVERRIDE', id: id, page: pageKey(), path: elPath(el) + slot,
          loose: loosePath(el) + slot, was: anchorAttr != null ? anchorAttr : was, newText: nt
        };
      }
      try { window.parent.postMessage(msg, location.origin); } catch (_) {}
    }
    function cancel() {
      if (!editing) return;
      if (editingTi >= 0) { if (editWrap) editWrap.textContent = origText; unwrapSlot(); }
      else { editing.textContent = origText; editing.contentEditable = 'false'; }
      editing = null; editingTi = -1; hideBar();
    }
    function flashRejected(el, reason) {
      var n = document.createElement('div');
      n.className = 'zw-ite-rej';
      n.textContent = reason || 'That text could not be saved.';
      document.body.appendChild(n);
      var r = el.getBoundingClientRect();
      n.style.top = Math.max(6, r.bottom + 8) + 'px';
      n.style.left = Math.max(6, Math.min(r.left, window.innerWidth - 6 - n.offsetWidth)) + 'px';
      el.classList.add('zw-ite-shake');
      setTimeout(function () { el.classList.remove('zw-ite-shake'); }, 700);
      setTimeout(function () { n.remove(); }, 4200);
    }

    window.addEventListener('message', function (e) {
      if (e.origin !== location.origin) return;
      var d = e.data; if (!d) return;
      if (d.type === 'ZW_TEXT_EDIT_MODE') {
        window.__zwTextEditMode = !!d.on;
        document.body.classList.toggle('zw-text-edit', window.__zwTextEditMode);
        if (!window.__zwTextEditMode) cancel();
        return;
      }
      /* Draft copy pushed from the builder. It never comes from the database:
         the draft keys are not publicly readable, on purpose. */
      if (d.type === 'ZW_TEXT_OVERRIDES' && d.value) { setOverrides(d.value, true); return; }
      if (d.type === 'ZW_INLINE_TEXT_RESULT' && pending[d.id]) {
        var p = pending[d.id]; delete pending[d.id];
        if (d.ok) {
          if (d.was != null) p.el.setAttribute(p.ti >= 0 ? 'data-zw-was-t' + p.ti : 'data-zw-was', d.was);
          return;
        }
        /* Stop showing what was not kept — putting back only the one text node
           when that is all that was edited. */
        if (p.ti >= 0) { var tn = directTextNodes(p.el)[p.ti]; if (tn) tn.nodeValue = p.was; }
        else p.el.textContent = p.was;
        flashRejected(p.el, d.reason);
      }
    });

    document.addEventListener('mousemove', function (e) {
      if (!window.__zwTextEditMode || editing) {
        if (hovered) { hovered.classList.remove('zw-ite-hi', 'zw-ite-chrome'); hovered = null; }
        return;
      }
      var got = targetAt(e);
      var t = got ? got.el : null;
      if (t === hovered) return;
      if (hovered) hovered.classList.remove('zw-ite-hi', 'zw-ite-chrome');
      hovered = t;
      if (hovered) {
        hovered.classList.add('zw-ite-hi');
        /* A different outline for text that is NOT part of a page section, so it
           is obvious before you click that this one is site-wide. */
        if (ownerOf(hovered).kind !== 'section') hovered.classList.add('zw-ite-chrome');
      }
    });

    document.addEventListener('click', function (e) {
      if (!window.__zwTextEditMode) return;
      var t = targetAt(e);
      if (!t) return;
      var el = t.el;
      e.preventDefault(); e.stopPropagation();
      if (editing === el && editingTi === t.ti) return;
      if (editing) commit();
      if (hovered) { hovered.classList.remove('zw-ite-hi', 'zw-ite-chrome'); hovered = null; }
      var owner = ownerOf(el);
      editing = el; editingTi = t.ti;
      ownerSec = owner.kind === 'section' ? owner.sec : '';
      ownerField = owner.kind === 'field' ? owner.field : '';
      if (t.ti >= 0) {
        var node = directTextNodes(el)[t.ti];
        if (!node) { editing = null; editingTi = -1; return; }
        origText = txt(wrapSlot(node));
        editWrap.focus();
      } else {
        origText = txt(el);
        el.contentEditable = 'true'; el.focus();
      }
      showBar(el, owner);
    }, true);

    document.addEventListener('keydown', function (e) {
      if (!editing) return;
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
    }, true);

    document.addEventListener('blur', function (e) {
      if (editing && e.target === editing) {
        setTimeout(function () {
          if (editing && document.activeElement !== editing && (!bar || !bar.contains(document.activeElement))) commit();
        }, 60);
      }
    }, true);

    window.addEventListener('scroll', function () { if (editing) placeBar(editing); }, { passive: true });
    window.addEventListener('resize', function () { if (editing) placeBar(editing); });
  }
})();
