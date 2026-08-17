/* Does every import in functions/ point at something that exists?
 *
 * This suite reads source text. It can tell you a function is present, that two
 * lists agree, that a message reaches the right branch — and it cannot tell you
 * the code BUILDS, because nothing here resolves a module.
 *
 * That gap shipped: fulfilment was lifted out of stripe-webhook.js into
 * _fulfil.js, and email-preview.js was still importing buildOrderConfirmation
 * from the route it had left. 1381 checks passed. Cloudflare failed the deploy
 * in sixteen seconds with the one error that mattered.
 *
 * So: every relative import in functions/ is resolved against the file it names
 * and the export it asks for. It is the cheapest possible stand-in for a build,
 * and it catches the one thing moving code between modules can break.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..') + '/';
const DIR = ROOT + 'functions/';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/* Comments go first. This codebase writes them INSIDE import braces —
   create-payment-intent.js explains there why it imports json() — and a parser
   that cannot tell prose from code reads the explanation as an identifier. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Named exports a file provides. */
function exportsOf(src) {
  const names = new Set();
  const add = (n) => n && names.add(n.trim());

  // export function foo / export async function foo / export class foo
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]);
  for (const m of src.matchAll(/^\s*export\s+class\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]);
  // export const foo = / export let / export var
  for (const m of src.matchAll(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]);
  // export { a, b as c }
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const bits = part.split(/\s+as\s+/);
      add((bits[1] || bits[0]).replace(/[\s\n]/g, ''));
    }
  }
  if (/^\s*export\s+default/m.test(src)) add('default');
  /* A CommonJS file supplies a default when imported from ESM — `module.exports`
     IS the default binding. return-reasons.js is UMD on purpose: the storefront
     loads it as a classic script to reach window.ZWReturnReasons, and a Worker
     imports the same file so there is one vocabulary rather than two. Without
     this, the checker reported a working import as broken. */
  if (/\bmodule\.exports\s*=/.test(src)) add('default');
  return names;
}

/** Relative imports a file makes: [{ from, names }] */
function importsOf(src) {
  const out = [];
  for (const m of src.matchAll(/import\s+([^'"]*?)\s+from\s+['"](\.[^'"]+)['"]/g)) {
    const clause = m[1].trim();
    const names = [];
    const braced = clause.match(/\{([^}]*)\}/);
    if (braced) {
      for (const part of braced[1].split(',')) {
        const bits = part.split(/\s+as\s+/);
        const n = (bits[0] || '').replace(/[\s\n]/g, '');
        if (n) names.push(n);
      }
    }
    const def = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim();
    if (def && !def.startsWith('*')) names.push('default');
    out.push({ from: m[2], names });
  }
  return out;
}

console.log('\n  every import points at something that is there');

const files = walk(DIR);
ok('there are functions to check', files.length > 0);

const cache = new Map();
const readExports = (p) => {
  if (!cache.has(p)) cache.set(p, exportsOf(strip(fs.readFileSync(p, 'utf8'))));
  return cache.get(p);
};

const missingFiles = [];
const missingNames = [];

for (const file of files) {
  const src = strip(fs.readFileSync(file, 'utf8'));
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  for (const imp of importsOf(src)) {
    const target = path.resolve(path.dirname(file), imp.from);
    if (!fs.existsSync(target)) { missingFiles.push(rel + ' → ' + imp.from); continue; }
    const has = readExports(target);
    for (const name of imp.names) {
      if (!has.has(name)) {
        missingNames.push(rel + ' imports ' + name + ' from ' + imp.from + ', which does not export it');
      }
    }
  }
}

ok('no import names a file that is not there', missingFiles.length === 0, missingFiles.join('; '));

/* THE one that shipped. Moving a function between modules and leaving an
   importer behind is invisible to every other check here, and fatal at build
   time — the whole site fails to deploy, not just the page that imported it. */
ok('no import asks for an export that does not exist', missingNames.length === 0,
  missingNames.join('; '));

console.log('\n  the split that caused it stays wired up');
{
  const preview = fs.readFileSync(DIR + 'api/email-preview.js', 'utf8');
  ok('the email preview reads its template from where fulfilment lives now',
    /from '\.\/_fulfil\.js'/.test(preview));
  ok('…and not from the route it was lifted out of',
    !/from '\.\/stripe-webhook\.js'/.test(preview));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
