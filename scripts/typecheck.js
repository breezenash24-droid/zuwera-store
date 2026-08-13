#!/usr/bin/env node
/**
 * typecheck.js — tsc as a linter that understands scope.
 *
 * There is no TypeScript here and there must not be one: nothing is renamed,
 * nothing is compiled, and Cloudflare Pages goes on serving the same .js files.
 * tsc runs with --noEmit purely to answer one question that `node --check`
 * cannot: does this name exist?
 *
 * That question has cost this repo two outages.
 *
 *   buildOrderConfirmation referenced an undeclared `meta` and threw on every
 *   order for weeks. No confirmation email was ever sent.
 *
 *   create-payment-intent called json() five times and never imported it, so
 *   every return path threw — including the catch block, which meant the
 *   handler could not even report its own failure. Checkout was down and the
 *   browser reported "Unexpected token '<'", because what came back was
 *   Cloudflare's error page.
 *
 * Both are one identifier that does not exist. Both parse perfectly: an unbound
 * name is only an error when its line RUNS, which is why every static check
 * this repo had went green.
 *
 * ── WHY NOT ENFORCE EVERYTHING ──────────────────────────────────────────────
 *
 * checkJs on untyped JavaScript reports ~89 findings here, and essentially all
 * of them are the same shape: tsc inferred a narrow type for an object literal
 * and is now objecting that a property is missing from it. They are not bugs,
 * they are the absence of type annotations — and a gate that reports 89 things
 * nobody will fix is a gate that gets switched off, taking the two that matter
 * with it.
 *
 * So the codes below are enforced and the rest are printed as a count. The list
 * is deliberately about EXISTENCE and ARITY — things that are wrong regardless
 * of whether anyone ever writes a type — rather than about assignability.
 *
 * Adding a code here is cheap. The bar is: would this finding be a bug even in
 * a codebase that had no types at all?
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* Wrong regardless of whether anyone ever writes a type. */
const ENFORCED = new Set([
  'TS2304', // Cannot find name 'x'                        ← both outages above
  'TS2552', // Cannot find name 'x'. Did you mean 'y'?
  'TS2551', // Property 'x' does not exist. Did you mean 'y'?   ← a typo'd property
  'TS2554', // Expected N arguments, but got M
  'TS2555', // Expected at least N arguments, but got M
  'TS2448', // Block-scoped variable 'x' used before its declaration
  'TS2451', // Cannot redeclare block-scoped variable 'x'
  'TS2588', // Cannot assign to 'x' because it is a constant
]);
/* Every TS1xxx is a parse/syntax problem and is always enforced. */
const isSyntax = (code) => /^TS1\d{3}$/.test(code);

const tscBin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
if (!fs.existsSync(tscBin)) {
  /* Deliberately not a failure. This is a dev-time gate; a missing devDependency
     must not be the reason a deploy is blocked. It is loud enough to notice. */
  console.log('\n  typecheck SKIPPED — typescript is not installed.');
  console.log('  Run `npm install` to enable it (devDependency).\n');
  process.exit(0);
}

const res = spawnSync(tscBin, ['-p', path.join(ROOT, 'jsconfig.json')], {
  cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32',
});

const lines = String(res.stdout || '').split(/\r?\n/).filter(Boolean);
const parsed = [];
for (const line of lines) {
  const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
  if (m) parsed.push({ file: m[1], line: m[2], col: m[3], code: m[4], msg: m[5], raw: line });
}

/* tsc failed for a reason that is not a type error — a bad config, a missing
   file. That is a real failure and must not be read as "nothing to report". */
if (!parsed.length && res.status !== 0) {
  console.log('\n  typecheck could not run:\n');
  console.log(String(res.stdout || res.stderr || '(no output)').trim() + '\n');
  process.exit(1);
}

const enforced = parsed.filter((e) => ENFORCED.has(e.code) || isSyntax(e.code));
const informational = parsed.filter((e) => !ENFORCED.has(e.code) && !isSyntax(e.code));

console.log('\n  typecheck  (functions/, checkJs, tsc ' + tscVersion() + ')\n');

if (enforced.length) {
  console.log('  ' + enforced.length + ' error' + (enforced.length === 1 ? '' : 's') + ' that would be wrong in any codebase:\n');
  for (const e of enforced) {
    console.log('  ✗ ' + e.file.replace(ROOT + path.sep, '').replace(/\\/g, '/') + ':' + e.line);
    console.log('      ' + e.code + ' — ' + e.msg);
  }
  console.log('');
} else {
  console.log('  ✓ no undeclared names, no arity mistakes, no syntax errors\n');
}

if (informational.length) {
  const byCode = {};
  for (const e of informational) byCode[e.code] = (byCode[e.code] || 0) + 1;
  const summary = Object.keys(byCode).sort((a, b) => byCode[b] - byCode[a])
    .map((c) => byCode[c] + '×' + c).join(', ');
  console.log('  ' + informational.length + ' not enforced (absence of type annotations, not bugs): ' + summary);
  console.log('  Run `npx tsc -p jsconfig.json` to see them.\n');
}

process.exit(enforced.length ? 1 : 0);

function tscVersion() {
  try {
    return require(path.join(ROOT, 'node_modules', 'typescript', 'package.json')).version;
  } catch (_) { return '?'; }
}
