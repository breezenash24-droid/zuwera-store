/* A limit that reaches no endpoint is worse than no limit.
 *
 * The limits catalogue (ABAC_LIMITS in admin-main.js) and the endpoints that
 * ask the engine are two lists that have to agree, and nothing made them. Both
 * halves had already drifted:
 *
 *   admin-relabel.js passed `action: 'relabel'`. No catalogue entry uses that
 *   name, and checkRule compares action names exactly — so no rule could ever
 *   match it. The call read in the source like a guard on the one operation in
 *   that file that spends money, and it opened every time.
 *
 *   generate-return-label.js buys a label from the same carrier account and
 *   asked nothing at all. So a store could cap a $600 refund and not a $600
 *   label, and there was no way to tell from the panel, because the panel only
 *   lists limits — it cannot list the ones nobody wrote.
 *
 * Both directions matter and they fail differently:
 *
 *   catalogue → endpoint   an owner sets a limit, the UI says it is on, and
 *                          nothing checks it. A limit believed in is worse
 *                          than one absent, because it stops people looking.
 *   endpoint → catalogue   a gate that no rule can name. Always allows, reads
 *                          as protection, survives review because the call is
 *                          right there.
 *
 * And one that is worse than either: an endpoint that passes an action but not
 * the ATTRIBUTE its rule reads. `attr()` returning undefined is a DENY — the
 * limit would refuse every attempt and look exactly like the limit working.
 * That is asserted here too, per rule, against the endpoint's own resource.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*$/gm, ' ');
const API = path.join(ROOT, 'functions', 'api');

/* ── The catalogue, read out of the admin ──────────────────────────────────
   Not JSON — the entries carry `say:` functions — so it is sliced and picked
   apart by field. Comments are stripped first; several entries are explained
   in prose that names other actions, and this codebase has repeatedly paid for
   a scanner that read prose as code. */
function catalogue() {
  const src = decomment(fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8'));
  const start = src.indexOf('const ABAC_LIMITS = [');
  if (start < 0) throw new Error('ABAC_LIMITS not found in admin-main.js');
  const end = src.indexOf('\n        ];', start);
  const block = src.slice(start, end);
  const out = [];
  for (const chunk of block.split(/\{\s*id:\s*'/).slice(1)) {
    const id = chunk.slice(0, chunk.indexOf("'"));
    const get = (k) => (new RegExp(k + ":\\s*'([^']*)'").exec(chunk) || [])[1];
    out.push({
      id,
      action: get('action'),
      attr: get('attr'),
      op: get('op'),
      ready: /ready:\s*true/.test(chunk),
      sealed: /sealed:\s*true/.test(chunk),
      needs: /needs:\s*'/.test(chunk),
      label: get('label'),
    });
  }
  return out;
}

/* ── Every decide() call in the Workers, with the resource it hands over ────
   Scoped to the decide() CALL, not to any `action:` string in the file. The
   loose version of this reported ten gates that do not exist — paypal-capture's
   'capture', shippo-webhook's 'delivered_notification', admin-prices' 'proposed'
   — all ordinary fields on unrelated objects that happen to be called `action`.
   A scanner that reports things which are not there is worse than none: the
   next real finding arrives in a list nobody reads any more. */
function gates() {
  const out = [];
  for (const f of fs.readdirSync(API).filter((x) => x.endsWith('.js'))) {
    const src = decomment(fs.readFileSync(path.join(API, f), 'utf8'));
    let i = src.indexOf('decide(');
    while (i >= 0) {
      const win = src.slice(i, i + 700);
      const a = /action:\s*'([a-z_]+)'/.exec(win);
      if (a) {
        const r = /resource:\s*\{([^{}]*)\}/.exec(win);
        /* Shorthand and `key: value` alike — `{ amount, carrier, orderId: x }`.
           Reading only `key:` pairs would miss every shorthand, and both label
           gates pass the amount that way. */
        const keys = r ? r[1].split(',').map((p) => p.split(':')[0].trim()).filter(Boolean) : [];
        out.push({ file: f, action: a[1], keys });
      }
      i = src.indexOf('decide(', i + 1);
    }
  }
  return out;
}

/** The advisory half: actions admin-guard.js will answer for. */
function guarded() {
  const src = decomment(fs.readFileSync(path.join(API, 'admin-guard.js'), 'utf8'));
  const block = src.slice(src.indexOf('const GUARDED = {'), src.indexOf('};', src.indexOf('const GUARDED = {')));
  return [...block.matchAll(/([a-z_]+):\s*'/g)].map((m) => m[1]);
}

/** …and the actions the panel actually ASKS about. Being in GUARDED only means
    the endpoint would answer; a limit is reachable when something calls it.
    The resource comes back too, so an advisory gate is held to the same
    attribute rule as a sealed one — it is the same engine either side. */
function asked() {
  const src = decomment(fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8'));
  const out = [];
  /* NOT `zwGuard\('x',\s*([^)]*)\)`. That stops at the first `)`, and the
     product_price gate computes its value with Math.round(…) — so the argument
     came back truncated before its closing brace, the object parse failed, and
     the scanner reported a correct gate as missing the one attribute it does
     supply. A checker that cries wolf about working code is how a real finding
     gets waved through. Take the argument as the text from the comma to the
     matching brace instead. */
  for (const m of src.matchAll(/zwGuard\(\s*'([a-z_]+)'\s*,/g)) {
    const arg = src.slice(m.index + m[0].length).replace(/^\s+/, '');
    let keys = [];
    const inline = /^\{([^{}]*)\}/.exec(arg);
    if (inline) {
      keys = inline[1].split(',').map((p) => p.split(':')[0].trim()).filter(Boolean);
    } else {
      /* A helper builds it — read the object the helper returns. One indirection
         only: a resource assembled across several functions is a resource
         nothing can check, and that is worth failing over rather than guessing. */
      const fn = /^([A-Za-z_$][\w$]*)\(/.exec(arg);
      if (fn) {
        const at = src.indexOf('function ' + fn[1] + '(');
        if (at >= 0) {
          const ret = /return\s*\{([^{}]*)\}/.exec(src.slice(at, at + 700));
          if (ret) keys = ret[1].split(',').map((p) => p.split(':')[0].trim()).filter(Boolean);
        }
      }
    }
    out.push({ file: 'admin-main.js', action: m[1], keys, advisory: true });
  }
  return out;
}

const LIMITS = catalogue();
const GATES = gates();
const GUARD = guarded();
const ASKED = asked();
const sealedActions = new Set(GATES.filter((g) => g.file !== 'admin-guard.js').map((g) => g.action));
const askedActions = new Set(ASKED.map((g) => g.action));
/* Reachable = a Worker asks, or the panel asks and the guard will answer. */
const reachable = (a) => sealedActions.has(a) || (askedActions.has(a) && GUARD.indexOf(a) !== -1);
/* Both kinds of gate, for the attribute check — the engine does not care which
   side of the wire a ctx came from, and neither does a missing attribute. */
const ALL_GATES = GATES.filter((g) => g.file !== 'admin-guard.js').concat(ASKED);

console.log('\n  the limits and the code that asks about them\n');
console.log('  ' + LIMITS.length + ' limits, ' + GATES.length + ' gates, ' + GUARD.length + ' advisory actions\n');

console.log('  every limit the panel says is on reaches something');
{
  const orphans = LIMITS.filter((l) => l.ready && !reachable(l.action));
  ok('no ready limit is unreachable', orphans.length === 0,
    orphans.map((l) => l.id + ' (action "' + l.action + '")').join(', ')
    + ' — the panel offers it and nothing asks');

  const unexplained = LIMITS.filter((l) => !l.ready && !l.needs);
  ok('every not-yet-built limit says what it is waiting for', unexplained.length === 0,
    unexplained.map((l) => l.id).join(', ')
    + ' — "not built yet" with no reason is indistinguishable from an oversight');

  /* The reverse: ready:false on something that IS now wired. Harmless to
     security and corrosive to trust — the panel would keep telling an owner a
     working limit does nothing, so they would not set it. */
  const understated = LIMITS.filter((l) => !l.ready && reachable(l.action));
  ok('…and none is wired while still labelled unbuilt', understated.length === 0,
    understated.map((l) => l.id).join(', '));
}

console.log('\n  every gate can actually be written about');
{
  const known = new Set(LIMITS.map((l) => l.action));
  /* admin-guard validates its own action names against GUARDED, and those are
     all catalogue actions by the check above, so it is not double-counted. */
  const nameless = GATES.filter((g) => g.file !== 'admin-guard.js' && !known.has(g.action));
  ok('no endpoint gates on an action no rule can name', nameless.length === 0,
    nameless.map((g) => g.file + ' → "' + g.action + '"').join(', ')
    + ' — checkRule matches action names exactly, so this gate always opens');
}

console.log('\n  a gate hands over what its rule reads');
{
  /* THE ONE THAT FAILS DANGEROUSLY. attr() returns undefined for an attribute
     the ctx does not carry, and checkRule turns undefined into 'fail' — a
     deny. So a gate that passes the action but not the attribute does not
     quietly do nothing; it refuses everything, and the refusal is
     indistinguishable from the limit working as intended. */
  const missing = [];
  for (const l of LIMITS) {
    if (!l.ready || !l.attr || !l.attr.startsWith('resource.')) continue;
    const field = l.attr.slice('resource.'.length);
    for (const g of ALL_GATES) {
      if (g.action !== l.action) continue;
      if (g.keys.indexOf(field) === -1) missing.push(g.file + ' → "' + g.action + '" omits ' + field + ' (' + l.id + ')');
    }
  }
  ok('no gate omits the attribute its limit reads', missing.length === 0,
    '\n      ' + missing.join('\n      ')
    + '\n      → a missing attribute DENIES, so this refuses every attempt');

  /* THE SHARED-ACTION TRAP, stated as its own rule because it is not obvious
     from either half alone. Two limits can name the same action with different
     attributes — discount_max reads resource.percent, discount_fixed_max reads
     resource.amount, and both fire on promo_create. A gate that sends only the
     relevant one therefore denies the other kind of coupon outright: cap
     percentages, and every flat-amount code is refused by a rule that was
     never about it. Send both, always, zero for the one that does not apply. */
  const byAction = {};
  for (const l of LIMITS) {
    if (!l.ready || !l.attr || !l.attr.startsWith('resource.')) continue;
    (byAction[l.action] = byAction[l.action] || []).push(l.attr.slice('resource.'.length));
  }
  const shared = Object.keys(byAction).filter((a) => new Set(byAction[a]).size > 1);
  const short = [];
  for (const a of shared) {
    for (const g of ALL_GATES.filter((x) => x.action === a)) {
      for (const field of new Set(byAction[a])) {
        if (g.keys.indexOf(field) === -1) short.push(g.file + ' → "' + a + '" omits ' + field);
      }
    }
  }
  ok('a gate for a shared action carries every limit\'s attribute',
    short.length === 0, short.join(', ')
    + ' — the sibling limit would refuse everything this gate is not about');
  console.log('    shared actions: ' + (shared.join(', ') || 'none'));
}

console.log('\n  the two ways money leaves are both capped');
{
  /* Named, because this is what the whole file was written for. Refunds were
     capped from the start; labels were not, and there are two of them. */
  const relabel = decomment(fs.readFileSync(path.join(API, 'admin-relabel.js'), 'utf8'));
  const retlabel = decomment(fs.readFileSync(path.join(API, 'generate-return-label.js'), 'utf8'));

  for (const [name, src] of [['admin-relabel.js', relabel], ['generate-return-label.js', retlabel]]) {
    ok(name + ' asks about the price before it pays', /action: 'ship_label'/.test(src));
    ok('…passing the amount, which is the thing the rule reads',
      /action: 'ship_label',\s*resource:\s*\{\s*amount/.test(src));
    ok('…and throws rather than returning a verdict',
      /if \(!verdict\.allow\) throw limitError\(verdict\)/.test(src),
      'a returned refusal that a caller forgets to check spends the money anyway');
  }

  /* Order matters more than presence. The gate has to sit after the rate is
     chosen and before the transaction is posted, or it is reading a price that
     does not exist yet — and "no label over $40" with no amount to read denies
     every label. */
  for (const [name, src, pick] of [
    ['admin-relabel.js', relabel, 'if (!chosen) chosen ='],
    ['generate-return-label.js', retlabel, 'const chosenRate = rates[0]'],
  ]) {
    const at = src.indexOf(pick);
    /* `if (gate) await gate(`, not `gate(` — the loose version passed when the
       call was mutated to `if (false) await gate(…)`, because the text was
       still in the right place. Position is only half of it; the call has to
       be one that runs. */
    const gate = src.indexOf('if (gate) await gate(', at);
    const buy = src.indexOf('/transactions/', at);
    ok(name + ' gates after the quote and before the purchase',
      at > 0 && gate > at && buy > gate,
      'quoting is free; buying is not, so the refusal has to land between them');
  }

  ok('a manual return label is deliberately not gated',
    /manual label is somebody typing in a tracking number|deliberately not gated/.test(
      fs.readFileSync(path.join(API, 'generate-return-label.js'), 'utf8')),
    'no money moves through this store on that branch, so there is nothing to cap');
}

console.log('\n  a refusal is not a breakage');
{
  /* Both endpoints already had a catch that reported failure. Falling into it
     with a limit refusal would record "label generation failed" on the return,
     show the customer-facing recovery advice, and answer 5xx — telling the
     admin to retry a decision, and telling the panel it cannot offer to
     request a waiver, because only `limited` refusals can be asked about. */
  for (const f of ['admin-relabel.js', 'generate-return-label.js']) {
    const src = decomment(fs.readFileSync(path.join(API, f), 'utf8'));
    ok(f + ' answers a refusal as a refusal, not a 500',
      /if \(e && e\.limitVerdict\) return limitResponse\(e/.test(src));
    const at = src.indexOf('e.limitVerdict');
    const failPath = src.indexOf('updateReturnRequestFailure', at) >= 0 || src.indexOf('502', at) >= 0;
    ok('…before the failure path, not after', at > 0 && failPath,
      'checked afterwards it would already have been written down as an outage');
  }

  const commerce = decomment(fs.readFileSync(path.join(API, '_commerce.js'), 'utf8'));
  ok('the refusal body names the rule', /rule: v\.rule \|\| ''/.test(commerce),
    'the panel offers to request a waiver for a specific rule; an unnamed refusal cannot be asked about');
  ok('…and both endpoints build it from one place',
    /export function limitResponse\(/.test(commerce),
    'two hand-written 403s is two shapes for the panel to handle');
}

console.log('\n  both ways to give money away ask, not just one');
{
  /* Named individually because reachability is satisfied by ANY caller. With
     only the count checked, deleting the guard on coupon creation left the
     suite green — the referral path still asked, so `promo_create` was still
     "reached", and the limit was enforceable on the rarer of the two. */
  const src = decomment(fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8'));
  for (const fn of ['bundleCreateCoupon', 'referralSyncExistingCodes']) {
    const at = src.indexOf('function ' + fn + '(');
    const body = at >= 0 ? src.slice(at, at + 1600) : '';
    ok(fn + ' asks before it writes the terms',
      /zwGuard\('promo_create'/.test(body),
      'one guarded path and one open one is an unguarded path');
  }
}

console.log('\n  the file that decides who can move money says what it does');
{
  const abac = fs.readFileSync(path.join(API, '_abac.js'), 'utf8');
  /* Asked as the OPENING CLAIM, not as a phrase anywhere in the file. The
     first version searched for "wired to nothing yet" and failed on the
     rewrite, which quotes the old line while explaining that it was wrong —
     prose read as code, in the test written to stop exactly that. */
  const opening = abac.slice(0, abac.indexOf('*/'));
  ok('_abac.js does not open by claiming to be wired to nothing',
    !/^\s*\*?\s*Deliberately wired to nothing/m.test(opening) && /WIRED AND LIVE/.test(opening),
    'it was true when written, and stayed on the page for a good while after it stopped being');
  ok('…and distinguishes sealed from advisory',
    /SEALED/.test(abac) && /ADVISORY/.test(abac),
    'the difference decides whether a limit binds or merely asks nicely');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
