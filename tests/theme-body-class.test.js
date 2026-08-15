/* The class on <body> is the theme the visitor asked for, from the first frame.
 *
 * "It's supposed to be dark mode — the header is still not behaving correctly on
 *  the first load."
 *
 * ── WHY THE HEADER, AND WHY ONLY ON THE FIRST LOAD ──────────────────────────
 *
 * Every page carries a snippet immediately after <body> whose whole job is to
 * put the theme class on before anything paints. It read:
 *
 *     var m = localStorage.getItem('zw_theme_mode') || 'super-light';
 *     if (m === 'light')            body.classList.add('light-mode');
 *     else if (m === 'super-light') body.classList.add('light-mode','super-light-mode');
 *
 * Two faults, and they only became visible together.
 *
 * 1. IT COMPARES AGAINST THE BUILT-IN IDS. zw_theme_mode holds a theme ID now,
 *    so a visitor on 'dark' — or on any theme somebody made, like
 *    'imported-msmdwxzf' — matches neither branch. The head snippet was fixed
 *    for exactly this and says so in a comment; this one was not.
 *
 * 2. IT ONLY EVER ADDS. That was harmless while <body> arrived bare: adding
 *    nothing left it dark, which was accidentally right. Then
 *    stamp-theme-default.js started baking the store's DEFAULT theme onto
 *    <body> at build time, and an additive snippet cannot undo a class it finds
 *    already there. A visitor whose theme is dark got the stamped
 *    light-mode super-light-mode, painted a white header, and waited for the
 *    deferred engine to take it off again.
 *
 * The header is where it shows first because nav#nav reads
 * `var(--zw-nav-bg, var(--ink))`, and on a super-light theme --ink is white.
 *
 * So the snippet now TOGGLES rather than adds, and resolves the base from
 * data-zw-base — which the <head> snippet sets from the cached config, so it
 * works for themes whose ids it has never heard of.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const PAGES = ['404.html', 'about.html', 'account.html', 'bag.html', 'checkout.html',
  'confirm.html', 'drop001.html', 'index.html', 'journal.html', 'landing.html',
  'policies.html', 'product.html', 'returns.html', 'sizeguide.html'];

/* Lift the post-<body> snippet out of a page and run it against a fake document
   whose <body> already carries whatever the build stamped. */
function runSnippet(page, { stamped = '', base = null, chosen = '', legacy = '' } = {}) {
  const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const head = src.toLowerCase().indexOf('</head>');
  const at = src.indexOf("data-zw-base'", head);
  if (at < 0) return null;
  const open = src.lastIndexOf('<script>', at);
  const close = src.indexOf('</script>', at);
  const code = src.slice(open + '<script>'.length, close);

  const classes = new Set(String(stamped).split(/\s+/).filter(Boolean));
  const store = {};
  if (chosen) store.zw_theme_mode = chosen;
  if (legacy) store.zw_homepage_theme_mode = legacy;

  const doc = {
    body: {
      classList: {
        add: (...c) => c.forEach((x) => classes.add(x)),
        remove: (...c) => c.forEach((x) => classes.delete(x)),
        contains: (c) => classes.has(c),
        toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      },
    },
    documentElement: { getAttribute: () => base, style: {} },
    querySelector: () => null,
  };
  new Function('document', 'localStorage', 'window', code)(
    doc,
    { getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null) },
    { __zwLM: () => chosen || legacy || '' },
  );
  return classes;
}

const STAMPED_LIGHT = 'zw-theme-stamp light-mode super-light-mode';

console.log('\n  the body class is the theme that was asked for\n');

console.log('  a dark visitor on a store whose DEFAULT is super-light');
{
  /* THE REPORTED BUG. The build stamps the store default; this visitor picked
     dark. Until the snippet could remove a class, the header painted white and
     was corrected a moment later by the deferred engine. */
  const c = runSnippet('index.html', { stamped: STAMPED_LIGHT, base: 'dark' });
  ok('the stamped light class is removed', !c.has('light-mode'),
    'an additive snippet cannot undo what the build baked in, which is what made this show up only after stamping started');
  ok('…and so is super-light', !c.has('super-light-mode'));
  ok('the stamp marker itself is left alone', c.has('zw-theme-stamp'),
    'it is how stamp-theme-default.js finds its own work later');
}

console.log('\n  …and it works for a theme whose id nobody hard-coded');
{
  /* The old snippet compared against 'light' and 'super-light' literally, so
     the moment anybody made a theme it stopped firing. data-zw-base carries the
     BASE, which is the only thing the class list depends on. */
  const light = runSnippet('index.html', { stamped: '', base: 'light' });
  ok('a custom light theme still gets light-mode', light.has('light-mode') && !light.has('super-light-mode'));

  const sl = runSnippet('index.html', { stamped: '', base: 'super-light' });
  ok('…and a custom super-light gets both', sl.has('light-mode') && sl.has('super-light-mode'),
    'super-light is a narrowing of light, not a separate branch');
}

console.log('\n  nothing known means the build\'s answer stands');
{
  const c = runSnippet('index.html', { stamped: STAMPED_LIGHT, base: null });
  ok('the stamped classes are left exactly as they are',
    c.has('light-mode') && c.has('super-light-mode'),
    'a first-EVER visitor has no cache, and the build is the only thing that knows the store default');
}

console.log('\n  the old ids still work for a visitor who has not been back since');
{
  ok('dark', !runSnippet('index.html', { stamped: STAMPED_LIGHT, base: null, chosen: 'dark' }).has('light-mode'));
  const l = runSnippet('index.html', { stamped: '', base: null, chosen: 'light' });
  ok('light', l.has('light-mode') && !l.has('super-light-mode'));
  const s = runSnippet('index.html', { stamped: '', base: null, chosen: 'super-light' });
  ok('super-light', s.has('light-mode') && s.has('super-light-mode'));
  ok('and an unrecognised id changes nothing',
    runSnippet('index.html', { stamped: STAMPED_LIGHT, base: null, chosen: 'imported-msmdwxzf' }).has('light-mode'),
    'without a cached base there is nothing to resolve it to, and guessing is what the stamp exists to avoid');
}

console.log('\n  every themed page, not most of them');
{
  /* "Some pages dark, some light" is how this class of bug has presented every
     previous time, and it is always one page left out of a list. */
  const missing = [];
  const additive = [];
  for (const page of PAGES) {
    const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const body = src.slice(src.toLowerCase().indexOf('</head>'));
    if (!body.includes("data-zw-base'")) { missing.push(page); continue; }
    /* An `add(` still present in the pre-paint snippet means that page kept the
       old behaviour and cannot remove a stamped class. */
    const at = body.indexOf("data-zw-base'");
    const open = body.lastIndexOf('<script>', at);
    const snippet = body.slice(open, body.indexOf('</script>', at));
    if (/classList\.add\(/.test(snippet)) additive.push(page);
  }
  ok('all of them resolve from the base', missing.length === 0, 'missing: ' + missing.join(', '));
  ok('…and none of them only add', additive.length === 0, 'still additive: ' + additive.join(', '));
}

console.log('\n  each page behaves the same way');
{
  const wrong = PAGES.filter((p) => {
    const c = runSnippet(p, { stamped: STAMPED_LIGHT, base: 'dark' });
    return !c || c.has('light-mode') || c.has('super-light-mode');
  });
  ok('a dark visitor gets a dark body on every page', wrong.length === 0, 'still light: ' + wrong.join(', '));

  const wrongSl = PAGES.filter((p) => {
    const c = runSnippet(p, { stamped: '', base: 'super-light' });
    return !c || !c.has('light-mode') || !c.has('super-light-mode');
  });
  ok('…and a super-light visitor gets both classes everywhere', wrongSl.length === 0, 'wrong: ' + wrongSl.join(', '));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
