/* Accessibility, checked by something rather than by nobody.
 *
 * The audit finding was not "this site is inaccessible" — it was that no target
 * was claimed and nothing verified any of it. Measured before this file existed:
 *
 *     skip links   4 of 21 pages   (index, drop001, landing, product)
 *     aria-live    checkout.html only — 2 occurrences
 *     CI           no axe, no pa11y, no assertion of any kind
 *
 * The aria-live number is the one that mattered. The storefront announces
 * everything through one toast — "Added to bag", a promo code accepted, a size
 * that turned out to be sold out — and #toast was an inert div on every page.
 * A screen reader user pressed Add to Bag and heard nothing at all. One
 * attribute set on an element that already existed fixed every one of those
 * messages at once, which is why it comes first here.
 *
 * ── WHAT THIS IS AND IS NOT ─────────────────────────────────────────────────
 *
 * Static checks on shipped markup. That catches the structural failures — a
 * missing landmark, an unlabelled control, an image with no alt — and it cannot
 * catch contrast, focus order, or whether a custom widget behaves. A real audit
 * needs a browser and a person. This is the floor, and having a floor is the
 * change: the previous floor was zero.
 *
 * ── PAGES DELIBERATELY NOT HELD TO THE SKIP-LINK RULE ───────────────────────
 *
 * checkout.html, confirm.html and mobile-checkout.html have no <main> landmark
 * AND do not load storefront-cohesion.css, which is where .skip-link is styled.
 * Adding the markup without the style puts a stray visible link at the top of
 * the checkout page — worse than not having one. They need a landmark first,
 * which is a structural change to the most sensitive page on the site and
 * belongs on its own. Listed by name below so the gap is a recorded decision
 * rather than an oversight nobody wrote down.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
/* Markup only. These pages carry large inline scripts whose COMMENTS discuss
   the markup — drop001 explains at two points why "no second <img> is needed" —
   and a scan that reads those reports prose as a missing alt attribute. */
const markup = (f) => read(f)
  .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ');

/* Customer-facing pages. admin/builder/analytics/diagnostic are staff tools on
   a different footing — worth doing and not what a shopper is blocked by. */
const SHOPPER = ['index.html', 'product.html', 'drop001.html', 'landing.html',
  'about.html', 'account.html', 'bag.html', 'journal.html', 'policies.html',
  'returns.html', 'sizeguide.html'];

const NO_LANDMARK_YET = ['checkout.html', 'confirm.html', 'mobile-checkout.html'];

console.log('\n  the storefront can be used without a mouse\n');

console.log('  what happens is announced');
{
  /* The highest-leverage line in this file. Every toast on the storefront goes
     through one element per page. */
  for (const f of ['index.html', 'product.html', 'drop001.html', 'bag.html', 'account.html', 'checkout.html']) {
    const s = read(f);
    ok('  ' + f + ' announces its toasts',
      /<div id="toast"[^>]*aria-live="polite"/.test(s) && /<div id="toast"[^>]*role="status"/.test(s),
      'showToast() sets textContent on this div — with no live region nobody hears it');
  }
  ok('…and reads the whole message, not the changed part',
    read('index.html').includes('aria-atomic="true"'),
    'without aria-atomic a changed toast can be announced as a fragment');
}

console.log('\n  the navigation can be skipped');
{
  for (const f of SHOPPER) {
    const s = read(f);
    ok('  ' + f + ' has a skip link',
      /class="skip-link"\s+href="#([^"]+)"/.test(s));
    const target = (s.match(/class="skip-link"\s+href="#([^"]+)"/) || [])[1];
    if (target) {
      ok('    …pointing at something on the page',
        new RegExp('id="' + target + '"').test(s),
        'a skip link to a missing id moves focus nowhere');
    }
  }
  /* Recorded, not hidden. */
  for (const f of NO_LANDMARK_YET) {
    ok('  ' + f + ' is a known gap, for a stated reason',
      !/<main\b/i.test(read(f)) || !/storefront-cohesion\.css/.test(read(f)),
      'if this page now has a landmark and the stylesheet, it belongs in SHOPPER');
  }
}

console.log('\n  the page says what its parts are');
{
  /* index, drop001 and landing hang their sections directly off <body> and mark
     the first one with id="main-content". The skip link therefore works — it is
     asserted above — and there is no <main> element for landmark navigation.

     Wrapping those sections in <main> is the right fix and it is a DOM nesting
     change on the three highest-traffic pages, where `body > section` selectors
     and the header's absolutely-positioned layout both live. Marking the hero
     alone with role="main" is not the fix: it would tell a screen reader the
     main content of the home page is the hero and nothing else, which is a
     worse answer than none.

     So they are named here rather than quietly excluded. */
  const SECTION_NOT_MAIN = ['index.html', 'drop001.html', 'landing.html'];
  for (const f of SHOPPER) {
    const s = read(f);
    if (SECTION_NOT_MAIN.includes(f)) {
      ok('  ' + f + ' at least marks where the content starts',
        /id="main-content"/.test(s),
        'no <main> here yet — the sections are direct children of body');
      continue;
    }
    ok('  ' + f + ' has a main landmark',
      /<main\b/i.test(s) || /role="main"/.test(s));
  }
  ok('the document declares its language',
    SHOPPER.every((f) => /<html[^>]+lang="/i.test(read(f))),
    'a screen reader picks its voice from this');
}

console.log('\n  controls that are only an icon still have a name');
{
  /* The header actions are the ones a shopper meets first and the ones most
     likely to be icon-only — bag, search, account. An unlabelled button is
     announced as "button". */
  const missing = [];
  let scanned = 0;
  for (const f of SHOPPER) {
    const s = markup(f);
    for (const m of s.matchAll(/<(button|a)\b([^>]*)>([\s\S]{0,200}?)<\/\1>/g)) {
      const attrs = m[2];
      const inner = m[3];
      if (!/<svg/i.test(inner)) continue;                       // not an icon control
      scanned++;
      if (/aria-label=|aria-labelledby=|title=/.test(attrs)) continue;
      const text = inner.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').trim();
      if (text) continue;                                       // has a visible label
      missing.push(f + ': ' + m[0].slice(0, 70).replace(/\s+/g, ' '));
    }
  }
  ok('every icon-only button or link is labelled',
    missing.length === 0,
    missing.slice(0, 6).join('  |  ') + (missing.length > 6 ? '  (+' + (missing.length - 6) + ' more)' : ''));
  /* A guard, because the interesting failure mode of this check is not a
     regression in the markup — it is the check quietly matching nothing after
     somebody changes how controls are written. It examines 7 controls today;
     zero would pass just as green.

     And the honest limit: most of this storefront's controls are built by
     JavaScript, and stripping <script> to avoid reading prose as markup also
     removes those from view. What this covers is the hand-written HTML. The
     generated controls need a browser to check, which is the axe run this
     is explicitly not. */
  ok('…and the scan is looking at controls at all', scanned >= 5,
    'found ' + scanned + ' icon controls in the shipped HTML — near zero means the pattern stopped matching');
}

console.log('\n  images carry alt text');
{
  const bare = [];
  for (const f of SHOPPER) {
    for (const m of markup(f).matchAll(/<img\b([^>]*)>/g)) {
      if (!/\balt=/.test(m[1])) bare.push(f + ': ' + m[0].slice(0, 70));
    }
  }
  /* alt="" is correct for decoration and is deliberately accepted; a MISSING
     alt attribute is the failure, because it makes a screen reader read the
     filename. */
  ok('no <img> ships without an alt attribute', bare.length === 0,
    bare.slice(0, 5).join('  |  ') + (bare.length > 5 ? '  (+' + (bare.length - 5) + ' more)' : ''));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
