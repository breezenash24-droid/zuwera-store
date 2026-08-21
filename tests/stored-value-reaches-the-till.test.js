/* The ledger was complete and unreachable.
 *
 * Migration 0030 built the whole instrument — issue, hold, capture, release,
 * void, an expiring hold so a dead Worker strands nothing — and
 * create-payment-intent already knew how to spend one. What none of it had was
 * a way in: no field at checkout, no screen to issue from, nothing on the
 * account page. Every line of it was correct and no shopper could reach any of
 * it, which is the same as not having built it.
 *
 * This file is about the three surfaces, and specifically about the ways a
 * surface can lie about what the system underneath it will do:
 *
 *   - offering a payment button that would charge a different number than the
 *     one on the screen,
 *   - confirming a card payment for an order the server already completed,
 *   - showing somebody a balance they have no way to type,
 *   - and sizing a gift card against a total that has not finished loading.
 *
 * Each of those is a place where the browser and the server disagree about
 * money, which is the one category of bug this codebase keeps paying for.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const checkoutHtml = read('checkout.html');
const checkoutJs = read('checkout.js');
const cc = read('commerce-checkout.js');
const account = read('account.html');
const adminHtml = read('admin.html');
const adminMod = read('stored-value-admin.js');
const svApi = read('functions/api/stored-value.js');
const mySvApi = read('functions/api/my-stored-value.js');
const adminApi = read('functions/api/admin-stored-value.js');

console.log('\n  the field exists, and only where it can be honoured\n');

ok('checkout ships a gift-card field',
  /id="zw-sv-shell"/.test(checkoutHtml) && /id="zw-sv-input"/.test(checkoutHtml));

ok('…hidden until the server says the store runs them',
  /id="zw-sv-shell" style="display:none/.test(checkoutHtml),
  'a shop with no gift cards must not show a box for one');

/* The promo box has an injection fallback so it can appear on the bag. Stored
   value must NOT — a bag page cannot take a payment, so a gift card applied
   there would be applied against nothing. */
ok('there is no injection fallback that could put it on a page that takes no payment',
  !/createElement\('div'\)[\s\S]{0,400}zw-sv-shell/.test(cc)
  && /const n = svNodes\(\);\s*\n\s*if \(!n\.shell \|\| SV\.probed\) return;/.test(cc),
  'the shell is static markup on the checkout page, on purpose');

console.log('\n  asking whether the feature is on must not cost a balance check');

ok('the enabled probe is a GET',
  /export async function onRequestGet/.test(svApi)
  && /await fetch\('\/api\/stored-value'\)/.test(cc));

ok('…and the GET is not rate limited, while the POST still is',
  /onRequestPost[\s\S]*?await limit\(env, request, 'stored-value'/.test(svApi)
  && !/onRequestGet[\s\S]*?await limit\(/.test(svApi),
  'twenty guesses an hour is for the endpoint that answers about a secret');

console.log('\n  only the code travels — the amount is the server\'s');

ok('the browser sends a code and never an applied amount',
  /storedValueCode: url === '\/api\/create-payment-intent' \? SV\.code : undefined/.test(cc)
  && !/storedValueCents|appliedCents:\s*SV/.test(cc),
  'a browser that can name the deduction is a browser that can name a bigger one');

/* PayPal prices from the same quoteCart() but has no hold, no capture and no
   release. A code sent there would be quoted against and never spent — the
   shopper would see the discount and the card would still be full. */
ok('…and only to the route that can actually hold and capture one',
  /paypal-create-order/.test(cc) && !/storedValueCode[\s\S]{0,80}paypal/i.test(cc));

ok('the express buttons come down while a card is applied',
  /EXPRESS_IDS\s*=\s*\[[^\]]*'paypal-button'[^\]]*\]/.test(cc)
  && /svToggleExpress\(appliedCents > 0\)/.test(cc),
  'a wallet sheet showing one total and an intent charging another');

/* Most of those elements are hidden already for their own reasons — PayPal is
   not configured, the browser has no wallet. Restoring them all to visible
   would show buttons that were never meant to be there. */
ok('…and putting them back restores what they were, not "visible"',
  /__zwSvPrev = el\.style\.display/.test(cc)
  && /el\.style\.display = el\.__zwSvPrev \|\| ''/.test(cc));

ok('…and says why, rather than just removing a control',
  /zw-sv-express-note/.test(cc) && /Remove the card below to use PayPal or a wallet/.test(cc));

console.log('\n  an order that is already paid must not be confirmed again');

/* Stripe will not create a zero PaymentIntent, so a card that covers the whole
   total means create-payment-intent captures, fulfils and returns the finished
   order. There is no clientSecret. confirmCardPayment(undefined) THROWS, and
   the catch turns that into a decline message — telling a shopper their
   payment failed for an order that is placed and paid. */
ok('the card path returns as soon as the server says paid in full',
  /if \(piData\.paidInFull\) \{[\s\S]{0,200}?showOrderConfirmed\(piData\.orderNumber, email/.test(checkoutJs));

ok('…and so does the wallet path, even though it should be unreachable',
  /if \(piData\.paidInFull\) \{[\s\S]{0,200}?ev\.complete\('success'\)/.test(checkoutJs));

ok('…and the server really does answer that way',
  /paidInFull: true/.test(read('functions/api/create-payment-intent.js')));

console.log('\n  the number it is sized against is the one on the page');

/* checkout.html does not use the #summary-* ids getSummaryNodes() looks for —
   it has its own #pm-* summary with three separate writers. Reading the wrong
   element here would size every gift card against $0 and hide the lines that
   prove it worked. */
ok('the total is read from the checkout page\'s own summary first',
  /document\.getElementById\('pm-total'\) \|\| getSummaryNodes\(\)\.total/.test(cc));

/* A total still waiting on tax or shipping is written as an em dash and marked
   .dash. parseMoney() reads that as zero — a number — and min(balance, 0) is
   nothing at all. */
ok('…and a total still waiting on tax counts as unknown, not as zero',
  /if \(!el \|\| el\.classList\.contains\('dash'\)\) return 0;/.test(cc)
  && /attributeFilter: \['class'\]/.test(cc),
  'and the redraw has to watch the class, or it never learns the total arrived');

ok('the applied figure is capped by the total, so it never over-claims',
  /Math\.min\(SV\.balanceCents, totalCents\)/.test(cc));

console.log('\n  stored value is tender, so the total keeps its meaning');

ok('the summary shows a separate amount due rather than shrinking the total',
  /id="zw-sv-due-row"/.test(checkoutHtml)
  && /<span>Amount due<\/span>/.test(checkoutHtml));

ok('…and the gift-card line sits below the total, not among the discounts',
  checkoutHtml.indexOf('id="zw-sv-rows"') > checkoutHtml.indexOf('<span>Total</span>'),
  'above the total would read as a discount, which would mean tax on a smaller base');

console.log('\n  the account page shows what somebody actually has');

ok('a shopper can see their own balances',
  /id="acct-tab-giftcards"/.test(account) && /panel-giftcards/.test(account)
  && /\/api\/my-stored-value/.test(account));

ok('…and the code, because the till takes a code',
  /class="gc-code" data-code=/.test(account),
  'a balance with no code is a number that mocks them');

ok('…and the tab only appears when there is something in it',
  /if \(r && r\.ok && r\.enabled && r\.cards && r\.cards\.length\)/.test(account),
  'a wallet tab that is always empty teaches people not to open it');

/* owner_email exists so an admin can issue to somebody with no account yet.
   Matching on the email in a session would hand the balance to anyone who can
   sign up with that address. */
ok('the match is on user id, never on the email in a session',
  /owner_user_id=eq\./.test(mySvApi)
  && !/owner_email=(eq|ilike)\./.test(mySvApi));

/* …which only works if something resolves an email to an account at issue
   time. Without it every store credit ever issued is invisible on the account
   it was issued to. */
ok('…so issuing binds the account when there is one to bind',
  /async function accountForEmail/.test(adminApi)
  && /const ownerUserId = body\.ownerUserId \|\| await accountForEmail\(env, ownerEmail\)/.test(adminApi));

ok('…and two accounts on one address bind neither, rather than guessing',
  /rows\.length === 1 \? rows\[0\]\.id \|\| null : null/.test(adminApi));

ok('a spent or expired card is not shown as a card',
  /if \(cents <= 0\) continue;/.test(mySvApi));

console.log('\n  the admin screen can issue money and still cannot list it');

ok('the issuing screen exists and is loaded',
  /stored-value-admin\.js/.test(adminHtml) && /action: 'issue'/.test(adminMod));

/* commerce-admin.js also wraps navigateTo, and its wrapper handles `commerce`
   WITHOUT calling through. The wrapper installed second is the one that
   survives — so the script order is load-bearing, and there is a fallback that
   does not depend on it. */
ok('…after commerce-admin.js, which does not call through for that page',
  adminHtml.indexOf('stored-value-admin.js') > adminHtml.indexOf('commerce-admin.js'));

ok('…and a delegated click covers it if that order ever changes',
  /closest\('\[data-page="commerce"\]'\)/.test(adminMod));

ok('it draws into its own mount, not the one the coupons module rewrites',
  /mount\.id = 'storedValueMount'/.test(adminMod)
  && !/commerceMount/.test(adminMod),
  'two modules writing one innerHTML is how a card disappears on the first save');

ok('there is no list of codes anywhere in it',
  !/action: 'list'/.test(adminMod) && !/'list'/.test(adminApi),
  'a list of live codes is a list of spendable money');

ok('…but the outstanding liability is visible, which needs no codes',
  /action === 'summary'/.test(adminApi) && /Outstanding/.test(adminMod));

ok('…and the summary says so when it could not count everything',
  /const capped = values\.length > SUMMARY_CAP;/.test(adminApi)
  && /return \{\s*\n\s*capped,/.test(adminApi),
  'silently under-reporting what the store owes is worse than a number with a caveat');

ok('…and the screen repeats that caveat rather than swallowing it',
  /s\.capped \?/.test(adminMod) && /under-reported, not wrong/.test(adminMod));

ok('the code is shown once and the panel cannot get it back',
  /Shown once and never again/.test(adminMod));

ok('the switch is here too, because the server refuses to issue while it is off',
  /id="svEnabled"/.test(adminMod)
  && /Gift cards and store credit are switched off/.test(adminApi));

ok('…and it is written to the settings row the SERVER reads',
  /key: 'stored_value'/.test(adminMod)
  && /getSetting\(env, 'stored_value'/.test(read('functions/api/_stored-value.js')));

console.log('\n  what is deliberately still missing');

/* Not built yet, and the returns screen still says so. Putting the option back
   before the money can actually move would be the same promise that got it
   removed in the first place. */
ok('refunds to a card are not offered yet, and the reminder test still stands',
  fs.existsSync(path.join(ROOT, 'tests', 'store-credit-is-not-offered.test.js')),
  'that test failing is the signal to re-offer store credit on the return forms');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
