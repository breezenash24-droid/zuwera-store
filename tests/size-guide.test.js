/* The size guide's "See my size" button, and the checkout totals it was
   confused with. */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
const R = ROOT + '/';
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + (e ? '  \u2014 ' + e : '')); } };

const guide = fs.readFileSync(R + 'sizeguide.html', 'utf8');

console.log('\n  size guide — See my size\n');

/* ── the class the CSS actually reveals with ─────────────────────────────── */
{
  // .calc-result is display:none and one class turns it on. The handler was
  // adding a different one, so it computed the size and wrote it into a box
  // that stayed hidden — the button looked completely dead.
  const revealClass = (guide.match(/\.calc-result\.([a-z-]+)\s*\{\s*display:\s*block/) || [])[1];
  ok('the CSS reveals .calc-result with a single known class', !!revealClass, revealClass);

  const adds = [...guide.matchAll(/result\.classList\.add\('([a-z-]+)'\)/g)].map(m => m[1]);
  ok(adds.length + ' reveal calls, all using that class',
    adds.length > 0 && adds.every(c => c === revealClass),
    [...new Set(adds)].join(','));
  ok('no stale .show reveal left behind', !/classList\.add\('show'\)/.test(guide));
}

/* ── the handler is wired and reads the right fields ─────────────────────── */
{
  ok('the button exists in the shared form', /zwf-fit-go/.test(fs.readFileSync(R + 'fit-finder.js', 'utf8')));
  ok('the size guide binds a click to it', /querySelector\('\.zwf-fit-go'\)\.addEventListener\('click'/.test(guide));
  ok('it reads height and weight from the shared form', /\.zwf-h'\)\.value/.test(guide) && /\.zwf-w'\)\.value/.test(guide));
  ok('it recommends through the shared function, not a second copy',
    /ZWFitFinder\.recommend\(/.test(guide));
  ok('a missing weight explains itself instead of doing nothing',
    /Enter a weight to get a starting size/.test(guide));

  // The result targets have to exist, or the handler silently no-ops again.
  ['calcResult', 'calcResultSize', 'calcResultText'].forEach(id => {
    ok('#' + id + ' exists in the markup', new RegExp('id="' + id + '"').test(guide));
  });
}

/* ── checkout: totals were correct, the form just looked filled ──────────── */
console.log('\n  checkout totals');
{
  const co = fs.readFileSync(R + 'checkout.html', 'utf8');
  const js = fs.readFileSync(R + 'checkout.js', 'utf8');

  // The values in the screenshot were placeholders, not entries.
  const ph = ['Jane Smith', 'jane@example.com', '123 Main St', 'New York', '10001'];
  ok('the address example values are placeholders, not values',
    ph.every(p => co.includes('placeholder="' + p + '"')) &&
    !ph.some(p => co.includes('value="' + p + '"')));

  ok('shipping is not fetched until there is an address to ship to',
    /zip\.length < 5 \|\| state\.length < 2\) return;/.test(js));
  ok('tax shows a dash until a state is entered, then a real figure',
    /tax > 0 \? `\$\$\{tax\.toFixed\(2\)\}` : \(state \? '\$0\.00' : '—'\)/.test(js));
  ok('both recompute as the address is typed',
    /zipInput\?\.addEventListener\('input'/.test(js) && /stateInput\?\.addEventListener\('input'/.test(js));

  ok('placeholders are now visually distinct from typed text',
    /\.pfield input::placeholder\s*\{[^}]*font-style:\s*italic/.test(co) &&
    /body\.light-mode \.pfield input::placeholder/.test(co));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
