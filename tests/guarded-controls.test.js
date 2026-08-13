/* Changes that are cheap to make, expensive to get wrong, and invisible after.
 *
 * Refunds already had a second factor: REFUND_SECRET must exist in Cloudflare
 * AND be typed per action, so admin access alone cannot move money. Two more
 * changes deserved the same shape and did not have it.
 *
 *   THE TAX ENGINE was a dropdown that saved on the spot. One stray click and
 *   every order from that moment is priced by something else — under-collecting
 *   tax you still owe, or charging a rate you cannot justify. Nothing looks
 *   broken either way, and afterwards there was no way to tell an accident from
 *   a decision.
 *
 *   PAUSING A SERVICE closes a specific attack rather than a vague one. Somebody
 *   with admin access pauses the Slack order alerts, and every order after that
 *   arrives in silence while the store keeps working. A pause with no second
 *   factor is a way to switch off the thing that would tell you about
 *   everything else.
 *
 * The refusals matter as much as the permissions: Stripe, Supabase, Resend and
 * Shippo have no pause at any price.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const CTRL = fs.readFileSync(path.join(ROOT, 'functions/api/admin-control.js'), 'utf8');
const GUARD = fs.readFileSync(path.join(ROOT, 'functions/api/_guarded.js'), 'utf8');
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');
const TAXJS = fs.readFileSync(path.join(ROOT, 'admin-tax.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');

(async () => {
  const G = await import(pathToFileURL(ROOT + '/functions/api/_guarded.js').href);
  const P = await import(pathToFileURL(ROOT + '/functions/api/_paused.js').href);
  const C = await import(pathToFileURL(ROOT + '/functions/api/admin-control.js').href);

  console.log('\n  guarded controls\n');

  console.log('  the code is a real gate');
  {
    const good = G.checkControlCode({ CONTROL_SECRET: 'letmein-please-1234' }, 'letmein-please-1234');
    ok('the right code passes', good.ok === true);
    ok('a wrong code is refused', G.checkControlCode({ CONTROL_SECRET: 'abc123' }, 'abc124').status === 403);
    ok('no code is refused', G.checkControlCode({ CONTROL_SECRET: 'abc123' }, '').status === 403);
    ok('whitespace is trimmed, not treated as a different code',
      G.checkControlCode({ CONTROL_SECRET: 'abc123' }, '  abc123  ').ok === true);

    /* Unset must make the action UNAVAILABLE. Falling back to "allow" would
       make the guard decorative while the panel still claims it is protected —
       worse than having no guard at all. */
    const unset = G.checkControlCode({}, 'anything');
    ok('an unset secret disables the action rather than allowing it', unset.ok === false && unset.status === 503);
    ok('…and says how to set it', /CONTROL_SECRET/.test(unset.error) && /Cloudflare/.test(unset.error));

    ok('the compare does not exit on the first wrong byte',
      /diff \|= l\.charCodeAt\(i\) \^ r\.charCodeAt\(i\)/.test(GUARD));
    /* A refund key should not become the settings key. Blast radius: money out
       of the business versus an operational change. */
    ok('it is a SEPARATE secret from the refund one', !/REFUND_SECRET/.test(GUARD.replace(/\/\*[\s\S]*?\*\//g, '')));
  }

  console.log('\n  nothing happens without admin AND code');
  {
    const req = (b) => ({ headers: { get: () => null }, json: async () => b });
    const noTok = await C.onRequestPost({ request: req({ action: 'tax-engine', engine: 'builtin' }), env: {} });
    ok('no admin token → 401', noTok.status === 401);
    const get = await C.onRequestGet({ env: {} });
    ok('GET is not a way in', get.status === 405);
    /* Order matters: the code is checked before anything is read or written. */
    ok('the code is checked before any action runs',
      CTRL.indexOf('checkControlCode(env, body.code)') < CTRL.indexOf("action === 'tax-engine'"));
    ok('…and after the admin check', CTRL.indexOf('verifyAdmin') < CTRL.indexOf('checkControlCode'));
  }

  console.log('\n  changing the tax engine');
  {
    ok('only a known engine is accepted', /TAX_ENGINES\.includes\(engine\)/.test(CTRL));
    /* tax_engine is one blob holding the endpoint, the fallback flag and the
       per-category codes. A plain write drops all of it. */
    ok('the rest of the tax config survives the change', /mutateSetting\(env, 'tax_engine'/.test(CTRL));
    ok('…by spreading the existing config', /\.\.\.cfg, engine/.test(CTRL));
    ok('the change is audited with what it was before',
      /action: 'tax\.engine_changed'/.test(CTRL) && /from: before \|\| '\(unset\)'/.test(CTRL));

    ok('the live dropdown is gone', /id="tax-engine-select"[^>]*style="display:none;"/.test(HTML));
    ok('…replaced by a picker behind a button', /onclick="openTaxEngineModal\(\)"/.test(HTML));
    ok('the modal asks for the code', /data-te-code/.test(HTML) && /id="te-code"/.test(HTML));
    ok('…and posts through the guarded endpoint', /action: 'tax-engine', engine, code: code\.trim\(\)/.test(TAXJS));
    ok('…refusing to submit without one', /Enter the authorization code to confirm/.test(TAXJS));
  }

  console.log('\n  each engine is distinguishable');
  {
    /* Sliced to the closing brace of the literal, not to the next mention of
       the name — cutting at `window.TAX_ENGINE_META` lands mid-object and the
       Function body then declares nothing. */
    const start = TAXJS.indexOf('const TAX_ENGINE_META = {');
    const end = TAXJS.indexOf('\n                    };', start) + '\n                    };'.length;
    const meta = new Function(TAXJS.slice(start, end) + ';return TAX_ENGINE_META;')();
    const { TAX_ENGINES } = await import(pathToFileURL(ROOT + '/functions/api/_tax.js').href);
    const missing = TAX_ENGINES.filter((e) => !meta[e]);
    ok('every engine the server accepts has an entry', missing.length === 0, missing.join(', '));
    const bad = Object.keys(meta).filter((k) => !meta[k].icon || !meta[k].name || !meta[k].blurb || !meta[k].cost);
    ok('…with an icon, a name, what it does and what it costs', bad.length === 0, bad.join(', '));
    const icons = Object.values(meta).map((m) => m.icon);
    ok('…and no two share an icon', new Set(icons).size === icons.length, icons.join(' '));
    /* The one currently pricing orders has to be obvious in the list. */
    ok('the one in use is marked', /in use now/.test(TAXJS));
    ok('…and the label outside the modal follows the same value',
      /tax-engine-current/.test(TAXJS) && /tax-engine-current/.test(HTML));
  }

  console.log('\n  pausing, and what may never be paused');
  {
    ok('the pausable list is short and explicit', P.PAUSABLE.length === 3);
    for (const s of ['twilio', 'veeqo', 'orderAlerts']) ok(s + ' can be paused', P.PAUSABLE.includes(s));
    /* The refusals are the point. Each of these breaks the store or silently
       stops customers being told something. */
    for (const s of ['stripe', 'supabase', 'resend', 'shippo', 'cloudflare', 'cloudinary', 'loops']) {
      ok(s + ' can NEVER be paused', !P.PAUSABLE.includes(s));
    }
    ok('the endpoint refuses an unpausable service', /That service cannot be paused/.test(CTRL));
    ok('…rather than silently doing nothing', /pausable: PAUSABLE/.test(CTRL));

    /* A pause that only changes the UI is a lie — each one has a real gate. */
    const VEEQO = fs.readFileSync(path.join(ROOT, 'functions/api/_veeqo.js'), 'utf8');
    const ALERTS = fs.readFileSync(path.join(ROOT, 'functions/api/_order-alerts.js'), 'utf8');
    const HOOK = fs.readFileSync(path.join(ROOT, 'functions/api/shippo-webhook.js'), 'utf8');
    ok('veeqo is gated in code', /isPaused\(cache \|\| \{\}, 'veeqo'\)/.test(VEEQO));
    ok('order alerts are gated in code', /isPaused\(cache, 'orderAlerts'\)/.test(ALERTS));
    ok('SMS is gated in code', /isPaused\(cache, 'twilio'\)/.test(HOOK));

    /* An unreadable setting must mean NOT paused. A service silently staying
       off because a settings read wobbled is an outage nobody asked for. */
    ok('an unreadable setting reads as not paused', P.isPaused(null, 'twilio') === false);
    ok('a garbage value reads as not paused', P.isPaused({ api_paused: 'nonsense' }, 'twilio') === false);
    ok('only an explicit true pauses', P.isPaused({ api_paused: { twilio: 'yes' } }, 'twilio') === false);
    ok('…and true does', P.isPaused({ api_paused: { twilio: true } }, 'twilio') === true);
    ok('an unpausable service is never reported paused',
      P.isPaused({ api_paused: { resend: true } }, 'resend') === false,
      'a settings row must not be able to invent a pause');

    ok('the button asks for the code', /CONTROL_SECRET\) to confirm/.test(ADMIN));
    ok('…and says what stops before you confirm', /pause \? meta\.effect/.test(ADMIN));
    ok('pausing is audited', /action: paused \? 'service\.paused' : 'service\.resumed'/.test(CTRL));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✗ suite crashed: ' + e.stack); process.exit(1); });
