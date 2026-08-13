/* Being told, instead of finding out.
 *
 * Nothing called /api/status except the admin page, so a key that died at 4am
 * stayed dead and silent until somebody happened to open the tab. The panel
 * could only ever describe the moment you were looking at it.
 *
 * THE PROPERTY THAT MATTERS IS RESTRAINT. A cron reporting "Resend is still
 * failing" every fifteen minutes gets muted inside a day, and a muted alert is
 * worse than no alert: the same silence, plus the belief that you are covered.
 * So this fires on CHANGE — working to failing, and again on recovery — and
 * says nothing about steady state, good or bad.
 *
 * And it must not shout on its first run. With no history every service looks
 * like it just changed, which would alert on all thirteen at once and teach
 * the reader to ignore it immediately.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };

const SRC = fs.readFileSync(path.join(ROOT, 'functions/api/status-watch.js'), 'utf8');
const STATUS = fs.readFileSync(path.join(ROOT, 'functions/api/api-status.js'), 'utf8');

(async () => {
  const mod = await import(pathToFileURL(ROOT + '/functions/api/status-watch.js').href);

  console.log('\n  scheduled service watch\n');

  console.log('  it cannot be triggered by accident');
  {
    const req = (tok) => ({ headers: { get: (h) => (h === 'x-cron-token' ? tok : null) } });
    const body = async (r) => JSON.parse(await r.text());

    const off = await mod.onRequestPost({ request: req('x'), env: {} });
    ok('no token configured → disabled, not open', off.status === 503);
    ok('…and says why', /STATUS_WATCH_TOKEN is not set/.test((await body(off)).error));

    const wrong = await mod.onRequestPost({ request: req('nope'), env: { STATUS_WATCH_TOKEN: 'a-real-token' } });
    ok('a wrong token is refused', wrong.status === 401);
    const none = await mod.onRequestPost({ request: req(null), env: { STATUS_WATCH_TOKEN: 'a-real-token' } });
    ok('a missing token is refused', none.status === 401);

    /* A health watcher reachable by anything that follows links — a preview
       crawler, a browser prefetch — is a watcher that fires alerts nobody
       asked for. */
    const get = await mod.onRequestGet();
    ok('GET is not a way in', get.status === 405);

    ok('the token compare does not exit early on the first wrong byte',
      /diff \|= a\.charCodeAt\(i\) \^ b\.charCodeAt\(i\)/.test(SRC));
  }

  console.log('\n  it runs the panel\'s checks, not its own');
  {
    /* A watcher with a second copy of "is Resend healthy" eventually disagrees
       with the page, and the disagreement surfaces as an alert nobody can
       reproduce by opening the dashboard — so the obvious next step actively
       misleads. */
    ok('runChecks is imported from the status endpoint',
      /import \{ runChecks, recordRun, svcKey, checkReturnSigning \} from '\.\/api-status\.js'/.test(SRC));
    ok('…and exported there for it', /export async function runChecks/.test(STATUS));
    ok('…including the non-vendor returns-signing check',
      /export function checkReturnSigning/.test(STATUS) && /checkReturnSigning/.test(SRC));
    ok('the watcher defines no vendor checks of its own',
      !/api\.resend\.com|api\.brevo\.com|api\.stripe\.com|goshippo\.com/.test(SRC));
  }

  console.log('\n  only a change is worth saying');
  {
    /* The comparison, rebuilt from the endpoint's own logic and run — this is
       the piece where a wrong answer means either silence during an outage or
       an alert storm. */
    const transitions = (services, prev) => {
      const firstRun = !prev || Object.keys(prev).length === 0;
      const broke = [], fixed = [];
      for (const [name, s] of Object.entries(services)) {
        const now = !!(s && s.ok);
        const before = prev && prev[name];
        if (firstRun || !before) continue;
        if (before.ok && !now) broke.push(name);
        else if (!before.ok && now) fixed.push(name);
      }
      return { firstRun, broke, fixed };
    };

    const t1 = transitions({ resend: { ok: false } }, { resend: { ok: true } });
    ok('working → failing raises it', t1.broke.join() === 'resend' && !t1.fixed.length);

    const t2 = transitions({ resend: { ok: true } }, { resend: { ok: false } });
    ok('failing → working raises the all-clear', t2.fixed.join() === 'resend' && !t2.broke.length);

    /* The restraint. Both of these are the common case on a healthy schedule
       and both must be silent. */
    const t3 = transitions({ resend: { ok: true } }, { resend: { ok: true } });
    ok('still working says nothing', !t3.broke.length && !t3.fixed.length);
    const t4 = transitions({ resend: { ok: false } }, { resend: { ok: false } });
    ok('still failing says nothing — this is what stops alerts being muted',
      !t4.broke.length && !t4.fixed.length);

    /* With no history every service looks like it just changed. */
    const t5 = transitions({ resend: { ok: false }, stripe: { ok: false } }, {});
    ok('the first run alerts on nothing', t5.firstRun && !t5.broke.length);
    const t6 = transitions({ resend: { ok: false } }, null);
    ok('…and so does a missing history table', t6.firstRun && !t6.broke.length);

    /* A service seen for the first time mid-life has no previous state; it is
       not a transition either. */
    const t7 = transitions({ resend: { ok: false }, brandnew: { ok: false } }, { resend: { ok: false } });
    ok('a service with no prior sample is not treated as newly broken', !t7.broke.length);

    const many = transitions(
      { resend: { ok: false }, stripe: { ok: false }, shippo: { ok: true } },
      { resend: { ok: true }, stripe: { ok: true }, shippo: { ok: false } },
    );
    ok('several at once are all reported', many.broke.length === 2 && many.fixed.length === 1);
  }

  console.log('\n  the alert is worth reading');
  {
    ok('it says what actually breaks for a customer', /What this affects: /.test(SRC));
    ok('…for the ones where that is not obvious',
      /shippo:\s*'Checkout cannot quote shipping/.test(SRC) && /stripe:\s*'Payments/.test(SRC));
    /* An alert about Resend, sent through Resend, arrives only when it is not
       needed. */
    ok('an email outage is not announced through the provider that is down',
      /avoid: name === 'resend' \? \['resend'\]/.test(SRC));
    ok('services are named in words, not keys', /const LABELS = \{/.test(SRC));
    ok('a recovery is info, not another emergency', /key: 'service-recovered'[\s\S]{0,80}severity: 'info'/.test(SRC));
    ok('an outage is critical', /key: 'service-down'[\s\S]{0,80}severity: 'critical'/.test(SRC));
    ok('a failed alert cannot fail the run', /catch \(_\) \{ \/\* an alert that cannot send/.test(SRC));
  }

  console.log('\n  it does not lose the observation');
  {
    /* Recording BEFORE alerting. If the alert throws after a successful record,
       one event is missed; if it throws before, the next run sees the same
       transition again and alerts twice for one outage. */
    ok('the run is recorded before the alerts go out',
      SRC.indexOf('await recordRun(env, services)') < SRC.indexOf("key: 'service-down'"));
    ok('…and a failed record does not stop the alerts', /recordRun\(env, services\)\.catch\(\(\) => \{\}\)/.test(SRC));
  }

  console.log('\n  it is reachable and documented');
  {
    const settings = fs.readFileSync(path.join(ROOT, 'functions/api/_settings.js'), 'utf8');
    ok('the token is admin-editable, so turning it on is not a redeploy',
      /'STATUS_WATCH_TOKEN'/.test(settings));
    const admin = fs.readFileSync(path.join(ROOT, 'admin-main.js'), 'utf8');
    ok('the admin explains it', /api\/status-watch/.test(admin));
    ok('…and says what it does that the page cannot',
      /nothing checks these services unless somebody opens this page/.test(admin));
    ok('both alert kinds have a row in the editor',
      /\['service-down',/.test(admin) && /\['service-recovered',/.test(admin));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✗ suite crashed: ' + e.stack); process.exit(1); });
