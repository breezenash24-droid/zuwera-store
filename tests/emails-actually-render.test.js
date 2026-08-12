/* Every transactional email must actually RENDER — not merely parse.
 *
 * THE BUG THIS EXISTS FOR.
 *
 * buildOrderConfirmation() read `meta.user_id` and `meta.order_number`. It has
 * no `meta` parameter — `meta` belongs to sendConfirmationEmail(), two frames
 * up. A free variable in a module is not undefined, it is a ReferenceError, so
 * the builder threw on EVERY call, before the Resend request was ever made.
 *
 * Nothing noticed, and the reasons are worth writing down:
 *
 *   - fulfilment runs the email inside Promise.allSettled, so the throw became
 *     one console.error line beside seven siblings that all succeeded;
 *   - the webhook still answered Stripe 200, so Stripe's dashboard showed a
 *     clean delivery;
 *   - the order saved, the label printed, the stock decremented, the loyalty
 *     points landed — every visible signal said the order worked;
 *   - the "all providers failed" alert lives INSIDE the provider chain, which
 *     the throw jumped over, so the one alarm built for undelivered mail could
 *     not fire.
 *
 * Not one order confirmation was sent, for any order, and the only trace was a
 * Worker log line nobody had reason to read.
 *
 * WHY EVERY EXISTING TEST MISSED IT. The file parses, so `node --check` is
 * happy. The line reads correctly to a human and to a regex — `meta.user_id`
 * is exactly what you would expect that line to say. This repo's suites assert
 * against source text, and source text is precisely where this bug is
 * invisible. A free variable is only ever a runtime fault.
 *
 * So this suite calls the builders. That is the whole idea. It renders every
 * type in PREVIEWABLE_TYPES, on both themes, and asserts real HTML comes back.
 * It cannot tell you an email is well designed; it can only tell you the code
 * survives being run — which is the thing that was not true.
 */
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const imp = (f) => import(pathToFileURL(ROOT + '/functions/api/' + f).href);

(async () => {
  const { PREVIEWABLE_TYPES, renderPreview } = await imp('email-preview.js');
  const { getEmailAppearance, getEmailContent } = await imp('_email-theme.js');
  const { buildOrderConfirmation } = await imp('_fulfil.js');

  console.log('\n  every email renders without throwing\n');

  console.log('  the full set, on both themes');
  {
    ok('there are types to render', Array.isArray(PREVIEWABLE_TYPES) && PREVIEWABLE_TYPES.length >= 10,
      'PREVIEWABLE_TYPES: ' + JSON.stringify(PREVIEWABLE_TYPES));

    for (const theme of ['dark', 'light']) {
      /* A real cache shape, so getEmailAppearance produces real tokens rather
         than a stub that happens to satisfy whatever the builders touch. */
      const cache = { email_theme: theme, email_settings: {}, journal_settings: null };
      for (const type of PREVIEWABLE_TYPES) {
        const appearance = getEmailAppearance(cache);
        appearance.logo = 'https://zuwera.store/assets/Zuwera_Wordmark_White.png';
        const content = getEmailContent(cache, type);
        let html = null, err = null;
        try {
          html = renderPreview(type, appearance, content, cache, appearance.logo);
        } catch (e) {
          err = e.constructor.name + ': ' + e.message;
        }
        ok(`${type} (${theme}) renders`, err === null, err);
        /* "Did not throw" is not enough — returning '' or undefined would also
           not throw, and would also send nothing. */
        ok(`${type} (${theme}) produces real HTML`,
          typeof html === 'string' && html.length > 400 && /<(table|div|body|html)/i.test(html),
          html == null ? 'null' : 'length ' + html.length);
        /* The template engine leaving its own placeholders behind means the
           copy never got filled in. */
        ok(`${type} (${theme}) has no unfilled placeholders`,
          typeof html === 'string' && !/\{\{\s*\w+\s*\}\}/.test(html),
          typeof html === 'string' ? (html.match(/\{\{\s*\w+\s*\}\}/) || [''])[0] : 'not a string');
      }
    }
  }

  /* ── The specific line that broke, pinned in both directions ─────────────
     The footer link is why `meta` was reached for at all: an account holder
     goes to /account, a guest goes to the lookup carrying their order number.
     Getting that wrong sent customers into whichever account was signed in on
     the machine — so both branches are asserted, not just "it renders". */
  console.log('\n  the footer link that caused it');
  {
    const base = {
      appearance: Object.assign(getEmailAppearance({ email_theme: 'dark' }), { logo: '' }),
      content: getEmailContent({}, 'order_confirmation'),
      orderId: 'AB12CD', toName: 'Alex', itemsHtml: '', subtotalCents: 6500,
      discountRow: '', shippingDisplay: 'Free', taxCents: 546, totalDollars: '70.46',
      addressHtml: '', carrierHtml: '',
    };
    /* Returns '' rather than throwing, so one broken render reports as a few
       failed assertions instead of taking the whole suite down with it — the
       source-level checks below give the clearest diagnosis of this bug and
       they are worth reaching. */
    const render = (extra) => {
      try { return buildOrderConfirmation(Object.assign({}, base, extra)); }
      catch (e) { console.log('    (render threw: ' + e.message + ')'); return ''; }
    };

    const guest = render({ userId: null, orderNumber: 'ZW-MTP-00143' });
    ok('a guest is sent to the order lookup, carrying their order number',
      guest.includes('/returns?order=ZW-MTP-00143'));
    ok('…and never to /account, which is not theirs to see',
      guest.length > 0 && !/href="[^"]*\/account"/.test(guest));

    const member = render({ userId: 'u_123', orderNumber: 'ZW-MTP-00143' });
    ok('an account holder is sent to /account', member.includes('/account'));

    /* The property that makes the bug unrepeatable. `meta.user_id` threw
       because a free variable throws; a destructured parameter the caller
       forgot is merely undefined, and orderStatusUrl() answers undefined with
       the plain guest lookup. A wrong link is a bad email. The free variable
       was no email at all — so degrading instead of throwing is the fix, not
       an accident of it. */
    let forgot = null, forgotErr = null;
    try { forgot = render({}); } catch (e) { forgotErr = e.message; }
    ok('a caller that passes neither still gets an email, not an exception',
      forgotErr === null, forgotErr);
    ok('…falling back to the guest lookup',
      typeof forgot === 'string' && forgot.includes('/returns'));
  }

  /* ── Nothing in this builder may reach outside its own parameters ────────
     Asserted on the source as well, because the runtime checks above only
     cover the branches they happen to take. `meta` was reachable from the
     footer, which every order confirmation renders; a free variable behind an
     `if` would still slip past a render test. */
  console.log('\n  the builder is closed over its parameters');
  {
    const fs = require('fs');
    const src = fs.readFileSync(ROOT + '/functions/api/_fulfil.js', 'utf8');
    const start = src.indexOf('export function buildOrderConfirmation');
    ok('buildOrderConfirmation is still there to check', start > 0);

    // Brace-balance the function body rather than regex to a closing line —
    // the body is full of `}` inside template literals.
    let d = 0, end = -1;
    const open = src.indexOf('{', src.indexOf(')', start));
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') d++;
      else if (src[i] === '}') { d--; if (d === 0) { end = i; break; } }
    }
    const body = src.slice(open, end + 1)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')   // the explanation above mentions `meta`
      .replace(/\/\/[^\n]*/g, ' ');
    const params = src.slice(src.indexOf('(', start), src.indexOf(')', start));

    ok('it does not reach for `meta`, which is not in its scope',
      !/\bmeta\s*\./.test(body),
      'a free `meta` here throws ReferenceError on every order confirmation');
    ok('it does not reach for `pi` either', !/\bpi\s*\./.test(body));
    ok('userId is an actual parameter', /\buserId\b/.test(params));
    ok('orderNumber is an actual parameter', /\borderNumber\b/.test(params));

    /* And the caller has to hand them over, or the parameters are decorative. */
    const callIdx = src.indexOf('buildOrderConfirmation({', src.indexOf('async function sendConfirmationEmail'));
    const call = src.slice(callIdx, src.indexOf('});', callIdx));
    ok('sendConfirmationEmail passes the order\'s owner through',
      /userId:\s*meta\.user_id/.test(call), call.slice(0, 200));
    ok('…and the order number the guest lookup needs',
      /orderNumber:\s*meta\.order_number/.test(call), call.slice(0, 200));
  }

  /* ── The reason this went unseen for as long as it did ───────────────────
     Not a style point. The email is one of eight siblings in an allSettled,
     and a rejected sibling there is invisible unless something reads the
     result. Fulfilment does log it — that logging is the only signal this
     failure has, so it is worth a test of its own. */
  console.log('\n  a failed email is at least reported');
  {
    const fs = require('fs');
    const src = fs.readFileSync(ROOT + '/functions/api/_fulfil.js', 'utf8');
    ok('the email result is inspected after allSettled',
      /emailResult\.status\s*===\s*'rejected'/.test(src),
      'an unread allSettled result is a silent failure by construction');
    ok('…and says so loudly enough to find in a log',
      /console\.error\('Email failed:'/.test(src));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✗ suite crashed: ' + e.stack); process.exit(1); });
