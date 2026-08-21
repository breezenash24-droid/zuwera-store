/* The header's auto-hide did nothing on a phone, and the source was correct.
   ═══════════════════════════════════════════════════════════════════════════

   Read off the live site, scrolling the homepage:

       390 px    .zw-nav-hidden applied   transform: none              top 0 throughout
       760 px    .zw-nav-hidden applied   transform: none              top 0 throughout
      1280 px    .zw-nav-hidden applied   matrix(1,0,0,1,0,-117.159)   top 25 -> -92.2

   So header-scroll.js was working: it added the class every time. The CSS that
   should move the header was the thing not applying.

   ── WHAT THE MINIFIER DID ───────────────────────────────────────────────────

       source     transform: translateY(calc(-110% - var(--zw-nav-lift, 0px)))
       as served  transform: translateY(calc(-110% - var(--zw-nav-lift,0)))

   clean-css rewrites a zero to a bare `0` inside calc(). EVERY unit, not just
   px — checked: 0px 0em 0% 0rem 0vh 0.0px all become `0`, while 1px survives.
   And it is not an option: level:{1:{all:false}} still does it. Only level 0
   does not, which would mean shipping unminified CSS.

   A unitless zero is a <number>. Subtracting a <number> from a <percentage> is
   invalid, so the declaration is invalid at computed-value time and is dropped
   — and `transform` then takes its INITIAL value, `none`. Not the previous
   cascade winner. None.

   ── WHY ONLY ON A PHONE ─────────────────────────────────────────────────────

   announcement-bar.js writes --zw-nav-lift inline whenever a bar sits above the
   header, so on desktop the variable was set and the fallback never ran. On a
   phone there is no lift, so the fallback ran, and the header stopped moving
   entirely. One broken calc() in the whole stylesheet, and it was this one.

   ── THE SHAPE OF THIS BUG ───────────────────────────────────────────────────

   Third time on this site that a defect existed only after the build: the CSP
   header dropped for being over Cloudflare's line limit, /sitemap.xml never
   routed to its Function, and now this. Every test read the source. So this one
   minifies the file with the REAL config and checks the output. */

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

let CleanCSS = null;
try { CleanCSS = require('clean-css'); } catch (_) {}

/* The same options minify-inplace.js ships with, taken from that file rather
   than retyped — a test that minifies differently from the build proves
   nothing about the build. */
const MIN_SRC = read('scripts/minify-inplace.js');
const LEVEL = (MIN_SRC.match(/new CleanCSS\(\{\s*level:\s*(\d+)/) || [])[1];

console.log('\n  the header hides on a phone too\n');

console.log('  the rule has nothing left for a minifier to break');
{
  const CSS = read('storefront-cohesion.css');
  const hide = (CSS.match(/nav#nav\.zw-nav-hidden[^{]*\{([^}]*)\}/) || [])[1] || '';
  ok('the hide rule is still there', /translateY/.test(hide), hide.slice(0, 80));
  ok('…and reads the lift with NO fallback',
    /var\(--zw-nav-lift\)\)/.test(hide) && !/var\(--zw-nav-lift\s*,/.test(hide),
    'every zero fallback becomes a unitless 0, whatever unit it was written in');
  /* Which is only safe because the variable is guaranteed to be declared. */
  ok('the variable is declared on the same selector list',
    /nav#nav, header\.nav, nav\.nav, nav\.zw-nav\{[\s\S]*?--zw-nav-lift:\s*0px;/.test(CSS),
    'anything that can match the hide rule must also match the declaration');
  ok('…so an inline value from the announcement bar still wins',
    /announcement-bar\.js writes this inline/.test(CSS));
}

console.log('\n  and the built file says the same thing');
{
  if (!CleanCSS) {
    ok('clean-css is available to check the built output', false,
      'install it, or this file can only check the source — which was never the problem');
  } else {
    ok('the build minifies at the level this test uses', LEVEL === '1', 'found level ' + LEVEL);
    const out = new CleanCSS({ level: Number(LEVEL || 1), returnPromise: false })
      .minify(read('storefront-cohesion.css')).styles;

    const hide = (out.match(/[^{}]*\.zw-nav-hidden[^{]*\{transform:translateY[^}]*\}/) || [])[0] || '';
    ok('the hide rule survives minification', hide.length > 0);
    ok('…with a calc() that is still valid',
      /calc\(-110% - var\(--zw-nav-lift\)\)/.test(hide),
      hide.slice(0, 120));
    ok('…and none of the four selectors was dropped',
      ['nav#nav.zw-nav-hidden', 'header.nav.zw-nav-hidden',
        'nav.nav.zw-nav-hidden', 'nav.zw-nav.zw-nav-hidden'].every((s) => out.includes(s)));
    ok('the declaration survives too', /--zw-nav-lift:0(px)?/.test(out),
      'without it the fallback-free var() resolves to nothing and the bug returns');
  }
}

console.log('\n  no OTHER calc() came out of the build invalid');
{
  /* CSS requires whitespace around a binary + or -, which is what makes this
     checkable: `calc(-1 * x)` is a signed number and fine, `calc(x - 0)` is a
     binary operator with a unitless operand and is not. */
  function calcs(css) {
    const out = [];
    let i = 0;
    while ((i = css.indexOf('calc(', i)) !== -1) {
      let depth = 0, j = i + 4;
      for (; j < css.length; j++) {
        if (css[j] === '(') depth++;
        else if (css[j] === ')') { depth--; if (!depth) break; }
      }
      out.push(css.slice(i, j + 1));
      i = j + 1;
    }
    return out;
  }
  function invalid(expr) {
    /* A unitless operand is only wrong when the expression MIXES types. A pure
       number expression is perfectly legal and there is one in motion.css:
       `scale(calc(1 + .04 * var(--zw-motion)))` is a scale factor, all numbers,
       no units anywhere. Flagging that would be a test that cries wolf, which
       is the fastest way to get a test ignored.

       So: only look at expressions that also deal in lengths or percentages. */
    /* No \b after the alternation: `%` is not a word character, so `%\b` needs
       a word character next and never matches `-110% - …`. That silently made
       every percentage expression read as untyped, which is precisely the kind
       of test that passes while the thing it guards is broken. */
    const typed = /(\d|\))\s*(%|(px|rem|em|vh|vw|vmin|vmax|ch|ex|pt|cm|mm|in)(?![\w-]))/.test(expr);
    if (!typed) return [];

    const bad = [];
    let m;
    /* a var() fallback that is a bare number, used as an operand of + or - */
    const fb = /var\(\s*--[\w-]+\s*,\s*(-?\d*\.?\d+)\s*\)/g;
    while ((m = fb.exec(expr))) {
      const before = expr.slice(0, m.index);
      const after = expr.slice(m.index + m[0].length);
      if (/[+\-]\s+$/.test(before) || /^\s+[+\-]\s/.test(after)) {
        bad.push('var() fallback "' + m[1] + '" has no unit');
      }
    }
    /* a bare number as the right operand of a spaced + or -. CSS REQUIRES the
       whitespace around a binary + or -, which is exactly what separates it
       from the sign in `calc(-1 * x)`. */
    const rhs = /\s[+\-]\s+(-?\d*\.?\d+)(?![\w%.])/g;
    while ((m = rhs.exec(expr))) bad.push('bare number "' + m[1] + '" after a binary operator');
    return bad;
  }

  const files = fs.readdirSync(ROOT).filter((f) => /\.css$/.test(f));
  let hurt = [];
  if (CleanCSS) {
    for (const f of files) {
      const out = new CleanCSS({ level: Number(LEVEL || 1), returnPromise: false })
        .minify(read(f)).styles;
      for (const c of calcs(out)) {
        const b = invalid(c);
        if (b.length) hurt.push(f + ':  ' + c.slice(0, 70) + '   (' + b.join('; ') + ')');
      }
    }
  }
  ok('every calc() in every built stylesheet still has typed operands',
    hurt.length === 0,
    hurt.slice(0, 6).join('\n      '));
  /* Said out loud so the next person writing one knows. */
  ok('and the file explains why a zero fallback cannot be used',
    /clean-css rewrites a zero to a bare `0`\s+inside calc\(\)/.test(read('storefront-cohesion.css')),
    'the next person to write one has to be able to find out why not');
}

console.log('\n  header-scroll.js was never the problem, and still is not');
{
  const HS = read('header-scroll.js');
  ok('it has no width guard that would skip a phone',
    !/innerWidth|max-width|min-width/.test(HS.replace(/\/\*[\s\S]*?\*\//g, '')),
    'the class was applied at 390px the whole time — only the transform was missing');
  ok('…and it toggles the class the stylesheet keys on',
    /HIDDEN = 'zw-nav-hidden'/.test(HS));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
