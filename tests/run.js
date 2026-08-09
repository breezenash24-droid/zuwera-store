#!/usr/bin/env node
/**
 * Test runner — `npm test`.
 *
 * Runs every *.test.js in this directory and reports the total. No framework,
 * no dependency: each suite is a plain Node script that prints its own results
 * and exits non-zero on failure, which is all a runner actually needs. That
 * keeps `npm test` working on a clean checkout with nothing installed — the
 * same reasoning behind the vanilla-JS storefront.
 *
 * WHAT THESE COVER, AND WHAT THEY DON'T.
 *
 * They are unit and contract tests over pure logic and over the wiring between
 * files: config normalising, discount arithmetic, token signing, cascade
 * specificity, cache headers, and the many "these two lists must stay
 * identical" invariants this codebase depends on. Several exist because the
 * exact bug they describe shipped once already.
 *
 * They do NOT drive a browser and they do not talk to Supabase or Stripe. An
 * end-to-end run of a real checkout against Stripe test cards is the obvious
 * next layer, and its absence is the honest gap.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

if (!files.length) {
  console.error('No test suites found in tests/.');
  process.exit(1);
}

let failed = 0;
let totalPass = 0;
let totalFail = 0;
const started = Date.now();

for (const file of files) {
  let out = '';
  let ok = true;
  try {
    out = execFileSync(process.execPath, [path.join(dir, file)], { encoding: 'utf8' });
  } catch (err) {
    ok = false;
    out = (err.stdout || '') + (err.stderr || '');
  }
  // Each suite prints "N passed, M failed" as its last meaningful line.
  const m = out.match(/(\d+) passed, (\d+) failed/);
  if (m) { totalPass += Number(m[1]); totalFail += Number(m[2]); }

  if (ok) {
    console.log(`  ✓ ${file.padEnd(30)} ${m ? m[1] + ' checks' : ''}`);
  } else {
    failed++;
    console.log(`  ✗ ${file}`);
    // Only the failures, so a red run is readable rather than a wall of ticks.
    out.split('\n').filter((l) => /✗|Error|error:/.test(l)).slice(0, 12)
      .forEach((l) => console.log('      ' + l.trim()));
  }
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log('');
if (failed) {
  console.log(`  ${totalPass} checks passed, ${totalFail} failed across ${files.length} suites (${secs}s)`);
  console.log(`  ${failed} suite${failed === 1 ? '' : 's'} failing.\n`);
  process.exit(1);
}
console.log(`  ${totalPass} checks passed across ${files.length} suites (${secs}s)\n`);
