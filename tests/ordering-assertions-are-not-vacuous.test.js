/* An ordering assertion that passes because it found nothing.
 *
 * Dozens of suites check that one thing happens before another by comparing two
 * positions in a source file:
 *
 *     ok('…after the response is assembled',
 *        API.indexOf('const built = {') < API.indexOf('recordRun(env, built)'));
 *
 * indexOf returns -1 when the needle is absent, and **-1 is less than every real
 * index**. So the assertion above passed for exactly one reason: the string it
 * was looking for did not exist. The file says `const built = await runChecks(…)`.
 * It had never once checked the ordering it describes, and it never would have
 * failed — not if the recording moved before the response, not if recordRun were
 * deleted outright.
 *
 * That is worse than a missing test. A missing test is a known gap; this is a
 * green tick standing where a check is supposed to be, and it stands there
 * exactly as long as the code has drifted away from what the test names.
 *
 * ── What is checked ─────────────────────────────────────────────────────────
 *
 * Every needle used in an `indexOf(…) <` or `indexOf(…) >` comparison has to
 * appear SOMEWHERE in the repo's source. That is a deliberately weak question —
 * it does not check the needle is in the file the test actually read, because
 * variables get reassigned between scopes and concatenated from two files, and
 * a stricter check produced false alarms on suites that were perfectly correct.
 *
 * Weak, but it has no false positives, and it catches the only case that
 * matters: a landmark that has been renamed or deleted out from under an
 * assertion still claiming to measure its position.
 *
 * `indexOf(x) < 0` is a different shape — that is asserting ABSENCE, where -1
 * is the answer being looked for — so comparisons against a plain 0 are left
 * alone.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

/* Every file a suite could plausibly be reading. */
const SRC = [];
(function walk(d, depth) {
  if (depth > 3) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (/^(node_modules|\.git|dist|tests|\.wrangler)$/.test(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (/\.(js|css|html|sql)$/.test(e.name) && !/\.min\./.test(e.name)) SRC.push(p);
  }
}(ROOT, 0));
/* Line endings normalised, or every needle containing a newline reads as
   MISSING against a CRLF file and the scan is noise. The question here is
   whether the landmark exists in the SOURCE; whether a given suite reads it in
   a way that can find it is asked separately below. */
const HAY = SRC.map((p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')).join('\n \n');

/* The test file's own escapes are literal characters once it runs. */
const unescape = (s) => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
  .replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, '`').replace(/\\\\/g, '\\');

console.log('\n  ordering assertions are not vacuous\n');

console.log('  the scan has something to scan');
{
  ok('source files were collected', SRC.length > 50, String(SRC.length));
  ok('…and concatenated into a haystack', HAY.length > 100000, String(HAY.length));
}

console.log('\n  every ordering landmark still exists');
{
  let checked = 0;
  const dead = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'tests')).filter((x) => x.endsWith('.test.js'))) {
    /* Comments out first. This file's own header quotes the broken assertion in
       order to EXPLAIN it, and the CSS scanner written an hour earlier tripped
       over exactly the same thing: a scanner that reads its own prose reports
       the description as the fault. Line comments go too, since a commented-out
       assertion is not one anybody is relying on. */
    const s = fs.readFileSync(path.join(ROOT, 'tests', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const line of s.split('\n')) {
      /* Only a comparison BETWEEN positions. `< 0` is an absence check. */
      /* The lookahead binds directly to the operator: written as
         `[<>]\s*(?!0\b)` the \s* backtracks to zero width, the lookahead then
         inspects the SPACE rather than the 0, and every `< 0` absence check
         matched anyway. Keeping the whitespace inside the lookahead is what
         makes it mean "not compared against zero". */
      /* TWO SHAPES, ONE ROOT CAUSE — indexOf returning -1 and nobody checking.
         A comparison between positions, and a needle whose position feeds a
         SLICE. `slice(-1, …)` never throws; it quietly lifts one character, so
         the suite either asserts against an empty string or dies far from the
         cause. Not hypothetical: renaming applyThemeMode's signature made
         `SRC.indexOf('function applyThemeMode(mode)')` return -1 and
         theme-missing.test.js crashed with "applyThemeMode is not defined".
         Unlike a comparison there is nothing to exempt here — -1 is never a
         slice bound anybody wanted. */
      const isOrdering = /\.indexOf\([^)]*\)\s*[<>](?!\s*0\b)/.test(line);
      const isSlice = /\.slice\(/.test(line) && /\.indexOf\(/.test(line);
      if (!isOrdering && !isSlice) continue;
      const re = /\.indexOf\((['"`])((?:[^'"`\\]|\\.)+)\1\)/g;
      let m;
      while ((m = re.exec(line))) {
        const needle = unescape(m[2]);
        if (needle.length < 4) continue;
        checked++;
        if (HAY.indexOf(needle) < 0) dead.push(f + '  →  ' + JSON.stringify(needle.slice(0, 60)));
      }
    }
  }
  ok('ordering comparisons were actually found',
    checked > 20, 'only ' + checked + ' — the pattern match has probably drifted');
  ok('no ordering assertion names a landmark that no longer exists',
    dead.length === 0, '\n      ' + dead.join('\n      '));
}

console.log('\n  the one that was found this way');
{
  /* Comments stripped here too — the fix in that file explains itself by
     QUOTING the broken line, so reading it raw finds the very string the
     assertion is checking has gone. Third time this exact slip has appeared
     today; it is what a scanner does when it cannot tell code from prose. */
  const api = fs.readFileSync(path.join(ROOT, 'tests', 'api-history.test.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  ok('it no longer compares against a string that is not there',
    !api.includes("indexOf('const built = {')"),
    'the file says `const built = await runChecks(...)`');
  ok('…and it proves both landmarks exist before comparing them',
    /both landmarks are still in the file/.test(api),
    'a comparison of two indexOf results means nothing until both are >= 0');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
