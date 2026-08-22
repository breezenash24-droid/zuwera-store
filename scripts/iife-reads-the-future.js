#!/usr/bin/env node
/**
 * iife-reads-the-future.js — catch a value used before it exists, in the one
 * shape TypeScript is unable to catch it.
 *
 * ── THE BUG THIS EXISTS FOR ─────────────────────────────────────────────────
 *
 * While adding gift cards, a `const taxableCents` ended up declared BELOW the
 * immediately-invoked function that read it:
 *
 *     const taxLineItems = (() => {
 *       …
 *       const remainder = taxableCents - allocated;   // reads it here
 *     })();                                            // …and runs here
 *
 *     const taxableCents = Math.max(0, …);             // declared here
 *
 * That is a ReferenceError on every single checkout — "Cannot access
 * 'taxableCents' before initialization" — in the function that takes money.
 *
 * ── WHY tsc CANNOT SEE IT ───────────────────────────────────────────────────
 *
 * TS2448 catches a plain reference above a `const`. It does not fire here, and
 * it is right not to: the reference is inside a FUNCTION BODY, and a function
 * body may legitimately run at any time — after the declaration, most of the
 * time. TypeScript has no way to know this particular function is called
 * immediately, so flagging it would be a false positive on every callback in
 * the codebase.
 *
 * An IIFE is the exception, and the only one: the call is right there in the
 * source, so it provably runs at its own position. That makes this decidable
 * where the general case is not, and it is the whole reason this file is
 * narrow. It looks at nothing else.
 *
 * ── NOT IN CI YET, AND THAT IS THE POINT ────────────────────────────────────
 *
 * This gated CI for two commits and failed on Linux while passing on Windows,
 * against a file set that was verified identical — 154 files, same counts, same
 * commit. The run's log is unreadable without repository admin (403), so the
 * cause is not yet known, and a gate that fails where nobody can see it is
 * worse than no gate: it teaches people the red is meaningless.
 *
 * So it is `npm run iife-check` until somebody has read that log. It stays here
 * because the bug it caught was real and would have taken checkout down; it
 * stays OUT of the blocking chain because it has not earned that back.
 *
 * ── HOW ─────────────────────────────────────────────────────────────────────
 *
 * TypeScript's own parser, which is already a dependency, rather than regexes
 * over source text. A regex that tried to answer "is this identifier declared
 * later in an enclosing scope" would be wrong about shadowing, about property
 * names, and about strings — and being wrong in the direction of a false alarm
 * on a check that gates CI is how a check gets deleted.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
/* Resolved by name, not by path. A hardcoded node_modules path assumes this
   repository's install layout is the only one that will ever exist — it breaks
   under workspaces, under a hoisted monorepo, and anywhere the dependency lives
   somewhere Node would still find it perfectly well on its own. */
const ts = require('typescript');

const DIRS = ['functions/api', 'scripts'];

function sourceFiles() {
  const out = [];
  for (const dir of DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (f.endsWith('.js') || f.endsWith('.ts')) out.push(path.join(dir, f));
    }
  }
  return out;
}

/* The callee of an IIFE, or null. Covers `(() => {})()`, `(function(){})()` and
   `(function(){}())` — the last is the same call with the parentheses moved,
   which is a style choice this codebase makes in places. */
function iifeBody(node) {
  if (!ts.isCallExpression(node)) return null;
  let callee = node.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) return callee;
  return null;
}

/* Every `const`/`let` name declared directly in a block, with where it starts.
   `var` is deliberately excluded: it hoists and initialises to undefined, so
   reading one early is a different bug with a different symptom, and this file
   is about the one that throws. */
function lexicalDeclarations(block) {
  const found = [];
  for (const stmt of block.statements || []) {
    if (!ts.isVariableStatement(stmt)) continue;
    const flags = ts.getCombinedNodeFlags(stmt.declarationList);
    const isLexical = (flags & ts.NodeFlags.Let) || (flags & ts.NodeFlags.Const);
    if (!isLexical) continue;
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name)) found.push({ name: d.name.text, pos: stmt.getStart() });
    }
  }
  return found;
}

/* Names bound anywhere INSIDE the IIFE — its own declarations, its parameters,
   its nested functions. A name it declares itself is its own, and a later
   declaration outside is then irrelevant: that is shadowing, not a bug. */
function boundInside(fn) {
  const names = new Set();
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) names.add(n.name.text);
    if (ts.isParameter(n) && ts.isIdentifier(n.name)) names.add(n.name.text);
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) names.add(n.name.text);
    if (ts.isBindingElement(n) && ts.isIdentifier(n.name)) names.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);
  return names;
}

/* Identifiers the IIFE reads AS IT RUNS.
 *
 * The distinction that makes this check correct rather than merely suspicious:
 * a nested function is NOT descended into. An IIFE provably runs where it is
 * written, but a function it merely CREATES does not — this is fine, and
 * extremely common:
 *
 *     const make = (() => () => LATER)();     // returns a closure
 *     const LATER = 1;                        // read only when called
 *
 * Descending into that closure would report a bug that cannot happen, and a
 * check that cries wolf on ordinary code is a check somebody removes. The one
 * exception is a nested IIFE, which runs immediately too and so is followed.
 *
 * Property accesses (`a.b`), property names in object literals, and the names
 * being declared are all skipped: none of them is a reference to a binding in
 * an enclosing scope. */
function readsInside(fn) {
  const names = new Map();
  const visit = (n) => {
    if (ts.isPropertyAccessExpression(n)) { visit(n.expression); return; }
    if (ts.isPropertyAssignment(n) && !ts.isComputedPropertyName(n.name)) { visit(n.initializer); return; }
    if (ts.isVariableDeclaration(n)) { if (n.initializer) visit(n.initializer); return; }
    /* A function that is not immediately invoked runs later, by definition. */
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)
      || ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n))
      && !iifeBody(n.parent)) return;
    if (ts.isIdentifier(n) && !names.has(n.text)) names.set(n.text, n.getStart());
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);
  return names;
}

const findings = [];
let scanned = 0;

for (const rel of sourceFiles()) {
  scanned += 1;
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true);

  /* Every block that can hold declarations, paired with the IIFEs inside it. */
  const walk = (node) => {
    const fn = iifeBody(node);
    if (fn) {
      const inside = boundInside(fn);
      const reads = readsInside(fn);
      const start = node.getStart();

      /* Walk outwards: any enclosing block whose own const/let is declared
         after this IIFE starts is a value that does not exist yet when the
         IIFE runs. */
      for (let scope = node.parent; scope; scope = scope.parent) {
        const isBlock = ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope);
        if (!isBlock) continue;
        for (const decl of lexicalDeclarations(scope)) {
          if (decl.pos <= start) continue;
          if (inside.has(decl.name)) continue;
          if (!reads.has(decl.name)) continue;
          const { line } = sf.getLineAndCharacterOfPosition(reads.get(decl.name));
          const { line: dLine } = sf.getLineAndCharacterOfPosition(decl.pos);
          findings.push({
            file: rel, line: line + 1, name: decl.name, declaredOn: dLine + 1,
          });
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
}

console.log('\n  values used before they exist  (immediately-invoked only)\n');
/* Printed on every run, pass or fail. This check reads the filesystem, and a
   disagreement between one machine and another is otherwise invisible: a green
   local run and a red CI run look identical in the output, and the first thing
   anybody needs to know is whether the two even looked at the same files. */
console.log(`  scanned ${scanned} files under ${DIRS.join(', ')}  ·  node ${process.version}  ·  typescript ${ts.version}`);

if (findings.length) {
  for (const f of findings) {
    console.log(`  ✗ ${f.file}:${f.line} — reads '${f.name}', which is declared on line ${f.declaredOn}`);
  }
  console.log(
    '\n  An IIFE runs where it is written. Reading a const declared below it is a\n'
    + '  ReferenceError at that moment, every time — move the declaration above.\n'
  );
  process.exit(1);
}

console.log('  ✓ no immediately-invoked function reads a value declared below it\n');
