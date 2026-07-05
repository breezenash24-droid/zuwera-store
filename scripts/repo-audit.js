#!/usr/bin/env node
/**
 * repo-audit.js — static safety checks for the Zuwera repo.
 *
 * Complements scripts/deployment-checklist.js (which verifies semantic wiring).
 * This one catches the "silently broken" class: JS/HTML syntax errors, broken
 * local asset references, and frontend calls to /api endpoints that have no
 * Cloudflare Function. Zero network, zero secrets — safe to run in CI on every PR.
 *
 * Exit code 0 = clean, 1 = one or more failures.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const problems = [];
const note = (m) => problems.push(m);

function listFiles(dir, filterFn, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', '.wrangler'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, filterFn, acc);
    else if (filterFn(full)) acc.push(full);
  }
  return acc;
}

// ── 1. JS syntax (root *.js + functions/**/*.js), via `node --check` ──────────
function checkJsSyntax() {
  const rootJs = fs.readdirSync(root).filter((f) => f.endsWith('.js')).map((f) => path.join(root, f));
  const fnJs = listFiles(path.join(root, 'functions'), (f) => f.endsWith('.js'));
  let n = 0;
  for (const file of [...rootJs, ...fnJs]) {
    n++;
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (res.status !== 0) note(`JS syntax error: ${path.relative(root, file)}\n    ${(res.stderr || '').split('\n')[0]}`);
  }
  return n;
}

// ── 2. Inline <script> syntax in HTML pages, via vm ───────────────────────────
function checkInlineScripts() {
  const vm = require('vm');
  const htmls = fs.readdirSync(root).filter((f) => f.endsWith('.html'));
  let n = 0;
  for (const f of htmls) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(s))) {
      const attrs = m[1] || '';
      if (/\bsrc\s*=/.test(attrs)) continue;
      if (/type\s*=\s*["'](application\/(ld\+json|json)|text\/template)["']/i.test(attrs)) continue;
      n++;
      const line = s.slice(0, m.index).split('\n').length;
      try { new vm.Script(m[2], { filename: `${f}:${line}` }); }
      catch (e) { note(`Inline script syntax error in ${f}:${line} — ${e.message.split('\n')[0]}`); }
    }
  }
  return n;
}

// ── 3. Broken local asset references in HTML ──────────────────────────────────
function checkAssetRefs() {
  const htmls = fs.readdirSync(root).filter((f) => f.endsWith('.html'));
  const strip = (u) => u.split('?')[0].split('#')[0];
  let n = 0;
  for (const f of htmls) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    const re = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(s))) {
      const u = m[1].trim();
      if (/^(https?:|data:|mailto:|tel:|javascript:|\/\/|#)/i.test(u)) continue;
      if (!/\.(js|css|png|jpe?g|webp|svg|gif|ico|woff2?|mp4|webm|json)$/i.test(strip(u))) continue;
      const rel = strip(u).replace(/^\//, '');
      n++;
      if (!fs.existsSync(path.join(root, rel))) note(`Broken asset reference: ${rel}  (in ${f})`);
    }
  }
  return n;
}

// ── 4. Frontend /api calls must resolve to a functions/api/*.js file ──────────
function checkApiEndpoints() {
  const dir = path.join(root, 'functions', 'api');
  if (!fs.existsSync(dir)) return 0;
  const have = new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, '')));
  const files = fs.readdirSync(root).filter((f) => /\.(js|html)$/.test(f));
  const called = {};
  for (const f of files) {
    if (f === 'supabase.min.js') continue; // vendored SDK has its own /api/* paths
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    const re = /["'`]\/api\/([a-zA-Z0-9_-]+)/g;
    let m;
    while ((m = re.exec(s))) (called[m[1]] = called[m[1]] || new Set()).add(f);
  }
  let n = 0;
  for (const ep of Object.keys(called)) {
    n++;
    if (!have.has(ep)) note(`Missing Function for called endpoint: /api/${ep}  (in ${[...called[ep]].join(', ')})`);
  }
  return n;
}

console.log('Running repo audit…\n');
const counts = {
  'JS files syntax-checked': checkJsSyntax(),
  'Inline HTML scripts checked': checkInlineScripts(),
  'Asset references checked': checkAssetRefs(),
  '/api endpoints checked': checkApiEndpoints(),
};
for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);

if (problems.length) {
  console.error(`\n❌ repo audit found ${problems.length} problem(s):\n`);
  problems.forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
console.log('\n✅ repo audit clean.');
