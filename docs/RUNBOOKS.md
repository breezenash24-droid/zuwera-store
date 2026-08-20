# Incident Runbooks

Quick, do-this-now guides for the failure modes that actually matter for a store.
Keep responses calm and reversible. When in doubt, **roll back first, diagnose after**.

Each entry is written for someone who did not build this and is reading it at 2am.
Where a symptom has bitten this store before, that is said plainly — the history is
the useful part, because the same shape recurs.

**The one rule worth internalising:** almost every serious bug here has been *one
question with two answerers* — two bits of code independently deciding the same
thing and disagreeing quietly. When something is wrong and both halves look
correct, look for the second answerer.

---

## 0. First 5 minutes of any incident
1. Confirm scope: is it the whole site, one page, or checkout only? Try an
   incognito window (rules out your own cache/localStorage).
2. Check Cloudflare Pages → Deployments: did a deploy just go out? If yes and the
   timing matches, **roll back** to the previous good deployment.
3. Check Supabase → Project status (is the database up / paused?).
4. Check the error log: `SELECT * FROM error_log ORDER BY created_at DESC LIMIT 50;`
   (see [runtime errors](#7-runtime-js-errors)).
5. **Is money still moving?** Stripe Dashboard → Payments. If payments are arriving,
   you have time. If they stopped, go to [§1](#1-checkout-is-failing--customers-cant-pay).

## 0b. Things that fail SILENTLY

These have no symptom until someone looks. Check them on a schedule, not in an
incident — by the time they hurt, they have been wrong for weeks.

| What | How to check | Section |
|---|---|---|
| Tax collecting nothing | Admin → Tax — the banner at the top | [§5](#5-no-tax-is-being-collected) |
| Confirmation emails not sending | Admin → Emails, or `email_log` | [§3](#3-no-confirmation-emails) |
| Backups not running | `backup-export` needs `BACKUP_TOKEN` set | [§10](#10-backups) |
| A migration never applied | Admin → APIs → Database migrations | [§8](#8-a-feature-is-configured-but-does-nothing) |
| Stock overstated | Worker log for `NOTHING decremented` | [§6](#6-stock-is-wrong) |

---

## 1. Checkout is failing / customers can't pay
- **Symptom:** payment modal errors, or orders not being created.
- Check `/api/create-payment-intent` is up: it should return `400` to an empty POST
  (that's healthy — it means the Function runs). A `5xx` means the Function is broken.
- Verify **Stripe keys** in CF env vars match the current mode (test vs live) — a
  test key in production (or vice-versa) silently breaks payment intents.
- Check Stripe Dashboard → Developers → Logs for the actual API error.
- If a recent deploy touched `checkout.js`/`create-payment-intent`, roll back.

> **Seen before:** `json()` was called five times in `create-payment-intent.js` and
> never imported, so *every* return path threw — including the catch block. Cloudflare
> answered with its own error page and the browser reported
> `Unexpected token '<'`. A missing import presenting as a parse error three layers
> away. `tests/endpoint-contract.test.js` now runs every payment handler to catch this.

## 2. Orders paid but not appearing / not fulfilled
- **Cause is almost always the Stripe webhook.** Orders are written by
  `/api/stripe-webhook`.
- Stripe Dashboard → Developers → **Webhooks**: confirm the endpoint is
  `https://zuwera.store/api/stripe-webhook` and recent deliveries are `200`.
  Failed deliveries can be **resent** from there — that is the recovery path.
- `/api/stripe-webhook` returns `400` to an unsigned POST (healthy). `5xx` = broken.
- Check the signing secret env var matches the endpoint's secret in Stripe.
- Search the Worker log for `ORDER NOT SAVED` — fulfilment shouts this and fires a
  **critical ops alert** when the order row fails to write. The customer *has* been
  charged; the payment id and order number are in the message.

> **Going live is two changes, not one.** Stripe keeps test and live webhooks
> entirely separate. Swapping only `STRIPE_SECRET_KEY` leaves the webhook pointed at
> a test-mode endpoint whose signing secret no longer matches: payments succeed, the
> customer is charged, and *nothing after that runs* — no email, no label, no stock
> decrement, no order row. Change `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
> together, then place one real order and confirm the email arrives.

## 3. No confirmation emails
- **Check it is actually the email and not all of fulfilment** — if orders are also
  missing, go to [§2](#2-orders-paid-but-not-appearing--not-fulfilled) first.
- Admin → APIs → Resend card → **Test** button. It sends a real message and prints
  the verbatim provider error.
- `SELECT * FROM email_log ORDER BY created_at DESC LIMIT 20;` — every automated send
  is recorded here. Nothing in the table means the send was never *attempted*.
- Resend accepts ≠ delivers. Resend → Logs shows bounces and suppressions; a hard
  bounce suppresses that address until you remove it there.
- `EMAIL_FROM` must be on a domain verified in Resend. Unset, it renders literally as
  `Zuwera <undefined>` and every send 422s.
- Brevo takes over automatically **only** if `BREVO_API_KEY` is set. The Resend card
  says whether that failover is armed.

> **Seen before:** `buildOrderConfirmation` referenced an undeclared `meta` and threw
> on *every* order for weeks. No confirmation email had ever been sent. The throw was
> swallowed by a `Promise.allSettled`, so the log said nothing and orders looked fine.
> `tests/order-end-to-end.test.js` now asserts an email is actually sent.

## 4. Shipping labels failing
- Admin dashboard surfaces label failures — `recordLabelFailure` writes them, so a
  declined card on the Shippo account does not fail silently.
- Admin → APIs → Shippo → **Test: quote live rates**. It prints Shippo's own message.
- **Nine times out of ten it is the ship-from address, not the key.** Shippo reports
  address problems inside `messages[]` rather than as an error status. Set the
  `SHIP_FROM_*` vars (see `_ship-from.js`).
- Free tier is 30 labels/month. Past that, Veeqo takes over **if** `VEEQO_API_KEY` is
  set — the Shippo card shows how many are left. Veeqo needs *Amazon Shipping V2*
  enabled on the account; it is not on by default.
- An order still completes without a label. The customer gets their confirmation
  without tracking, and the failure is recorded for you.

## 5. No tax is being collected
- Admin → **Tax**. The banner at the top probes three states that tax what this store
  sells and goes **red** if all of them return zero.
- **Stripe Tax charges tax only where you have added a registration.** With none
  added it answers `200 OK` with `tax_amount_exclusive: 0` for every address on
  earth — no error, so the fallback never fires and nothing else notices.
  Fix in **Stripe → Tax → Registrations**: home state first (physical nexus), then
  whatever the nexus table on the Tax page shows you have crossed.
- A *single* state returning zero is usually correct — Oregon has no sales tax,
  clothing is exempt in PA/NJ/MN and under $110/garment in NY. Only "zero everywhere"
  is a fault.
- Probe it directly:
  `curl 'https://zuwera.store/api/tax-quote?state=OH&zip=45202&amount=12000&shipping=800'`
  **Pass `amount`.** Without it you are asking for tax on $0 and will get $0 — that
  mistake produced a false alarm once already.

## 6. Stock is wrong
- Search the Worker log for `NOTHING decremented`. That means the sale went through
  but no `product_sizes` row matched, so **stock is now overstated on a live product**.
- Usual cause: the colour. `product_sizes` is per-colour, and a decrement without
  `p_color_name` takes stock off whichever row matches first.
- Check migration **0007** is applied (Admin → APIs → Database migrations). Before it,
  the RPC returned void, so "found no row and did nothing" was indistinguishable from
  success.
- Bag quantities are capped at what is actually in stock, and the bag shows what is
  left *to add* — not the shelf total. A shopper with 2 in their bag seeing "1 left"
  is that working, not a bug.

## 7. Runtime JS errors
- Client errors are captured to Supabase `error_log` by `error-reporter.js` →
  `/api/log-error`. Triage: `SELECT message, url, count(*) FROM error_log
  WHERE created_at > now() - interval '1 day' GROUP BY 1,2 ORDER BY 3 DESC;`
- Cloudflare Function logs: CF dashboard → Pages → your project → Functions →
  real-time logs (or `wrangler pages deployment tail`).
- `error_log` grows without limit and has been the largest table in the database.
  Prune it; 500 MB is the free tier.

## 8. A feature is configured but does nothing
- **Almost always an unapplied migration.** PostgREST rejects the *whole row* for one
  unknown column, so a single missing field silently kills every write that includes it.
- Admin → **APIs → Database migrations**. It compares the repository against
  production and lists anything pending.
- Migration `0016` once timed out and applied *nothing* while reporting success. If a
  migration looks stuck, verify the actual schema before re-running.

## 9. The site looks wrong (stuck light, invisible text, wrong colours)
- **90% of the time this is a stale client:** DevTools → Application → *Clear site
  data* → reload. The builder preview shares `localStorage` with the live homepage.
- If it reproduces in clean incognito, it is real. **Do not reason about the CSS —
  measure it.** In the console on the affected page:
  ```js
  const n = document.querySelector('.pcard-name');  // or whatever looks wrong
  let e = n; while (e && e !== document.documentElement) {
    console.log(e.tagName + '.' + e.className, getComputedStyle(e).color, e.style.color || '');
    e = e.parentElement;
  }
  ```
  The first ancestor whose colour stops being wrong is the element introducing it.
  This found a bug in one paste that three rounds of reading CSS had got wrong.
- **Section colours:** Builder → the section → Section Style. `Background` and
  `Text Color` both offer *Default*, a **theme colour**, or a custom one. A custom
  colour is a literal frozen against whatever theme was active when it was picked —
  it will not follow light/dark. Prefer a theme colour.
- **Whole homepage stuck in one theme:** Builder → **More ▾ → Homepage theme**. It is
  saved and published, not a preview setting. Set it to **🎨 Site theme** to follow
  Appearance.

## 10. Backups
- Backups run from the deployed `backup-export` Supabase edge function, gated on
  `x-backup-token`. **It does nothing until `BACKUP_TOKEN` is set.**
- Destination is a Google Sheet plus a private GitHub repo.
- Restore: see [DATABASE.md](./DATABASE.md#backups--restore). **Rehearse this before you need it.**

## 11. Locked out of the admin
- Roles live in `profiles.admin_role`, enforced by `_rbac.js` server-side and
  `ZW_RBAC` in the panel. A role change takes effect on next request, not next deploy.
- **`REFUND_SECRET` is deliberately a Cloudflare env var with no reset button in the
  panel.** That is by design: it is meant to be something admin access alone does not
  give you. If it is lost, rotate it in Cloudflare — there is no in-app recovery, and
  adding one would defeat the point.
- If RLS is refusing everything, check migration `0017`
  (`0017_rls_respects_permissions.sql`) applied cleanly.

### 11a. Lost the authenticator — every admin endpoint returns 401
Symptom: you can sign in, the panel loads, and every action fails with *"This
session has not completed two-factor verification."* The Workers log shows
`admin auth: refused an aal1 assurance session for <you>`.

`verifyAdmin()` in `_commerce.js` requires an `aal2` token. **There is no
environment variable to turn that off, on purpose** — the same reasoning as
`REFUND_SECRET` above: a store that can disable MFA enforcement is a store where
MFA enforcement is off. Recovery is out-of-band, through an account nobody
signing in to the storefront holds:

1. Supabase dashboard → **Authentication → Users** → find your user.
2. Delete the enrolled TOTP factor (**MFA** section on the user's detail page).
3. Sign in to `/admin.html` again. With no factor present the panel routes you
   to enrolment, you scan the new QR code, and the session comes back as `aal2`.

Two things worth knowing before you need this:
- **Enrol a second factor now**, on a second device, and keep the recovery codes
  Supabase shows at enrolment. That turns this runbook into a non-event.
- `/api/admin-access` deliberately does **not** require `aal2`. It is the "are
  you an admin at all" check that runs before the MFA step, so a first sign-in
  can always reach the enrolment screen. If you ever find yourself adding
  `verifyAdmin` to it, that is the lockout.

## 11b. Are the public-endpoint protections actually running?
`GET /api/health` answers, under `protections`:

```json
"protections": {
  "rateLimit": { "memory": true, "database": "ok", "durable": true },
  "botCheck": "on"
}
```

- `database: "missing"` → migration **0029** has not been run. The limiter is
  still working from its in-isolate counter, which stops a loop from one address
  and not a spread across many. Run the migration.
- `botCheck: "not-configured"` → `TURNSTILE_SECRET_KEY` is unset, so
  `/api/subscribe` accepts requests without a token.

Both of those fail **open** by design — a late migration must not take checkout
down — which is exactly why they are published here rather than assumed. This is
deliberately not part of the `ok` flag: an uptime monitor should page for a store
that cannot serve, not for a migration nobody has run yet.

## 12. Suspected key/secret leak
- Rotate immediately in the source (Stripe/Supabase/Cloudflare dashboards) **and**
  update CF env vars. gitleaks (CI) scans history; if a key ever landed in git,
  rotating is mandatory even after removal — git history is forever.
- Anything that can spend money or send mail as the domain is **env-only** by design
  (`ENV_ONLY_KEYS` in `functions/api/_settings.js`) and cannot be written from the
  admin panel. If you find one of those stored in `site_settings`, that is a finding.

---

## 13. Testing a price change before it reaches customers

Prices are the one area where "try it and see" costs real money, because
**approving a price row is live immediately** — there is no staging copy of the
catalogue. Work outwards from the checks that cannot touch a customer.

### The safe order

**Applying the migrations is not the risky step.** 0021 and 0022 are additive and
inert: every column is nullable, no row is seeded with a price, and the resolver
falls back to the catalogue whenever nothing applies. Applying them changes no
price. The risky step is *approving a row*, which happens later and on purpose.

### 1. Before you deploy anything — check the arithmetic

```
node scripts/price-check.js --product 220 --colour 176.97
node scripts/price-check.js --product 220 --member 198 --colour 250 --as member
node scripts/price-check.js --product 220 --list sale:176.97:5@2026-09-20..2026-09-27 --on 2026-09-25
```

This runs the **real resolver** — the same module the checkout imports — against a
scenario you type. It answers "what would we charge", names which rule won, and
shows why a row did not apply (`outside its window`, `not this shopper`,
`proposed`). Use it to sanity-check any change you are about to approve.

`npm test` covers the same rules exhaustively; this is for a specific case you
are about to make real.

### 2. Apply the migrations, then prove nothing moved

Admin → APIs → Database migrations → Check → Apply pending. Then in the Supabase
SQL editor:

```sql
select count(*) filter (where current_price is not null) as priced_colours,
       count(*) as colourways from color_variants;     -- priced_colours = 0
select count(*) from prices;                            -- 0
select code, active, priority from price_lists;         -- default (on), members (OFF)
```

If any of those is non-zero, stop — something wrote prices you did not intend.

### 3. Test the workflow without changing a price

On the Pricing page, propose a change **with a start date in the future**. Then:

- The storefront must be unchanged (it is not approved).
- Approve it. The storefront must **still** be unchanged (its window has not opened).
- The Register shows the movement, the old figure, and `self-approved` if you were
  also the proposer.

This exercises propose → approve → register end to end and cannot alter a price.

### 4. Test the real path on a product no customer can reach

Set a product's status to **draft** and use that as the subject. Then:

- Price a colourway on the product form, or approve a list row starting now.
- Product page: click between swatches — the price and the struck-through
  compare-at must change with the colour.
- Add to bag → the bag must show the **same** figure.
- Open checkout → the summary must show the same figure again.

The bag is where this breaks: `refreshCartCatalogPrices` re-prices from the
catalogue on load, and if it ignored colour a dearer colourway would display low
and then be **refused at checkout** by the never-bill-above-shown guard.

### 5. The charge itself — test mode only

Switch `STRIPE_SECRET_KEY` and the publishable key to their `sk_test_` /
`pk_test_` pair in Cloudflare, redeploy, and confirm the checkout shows
**"Test mode active"**. Pay with `4242 4242 4242 4242`, any future expiry, any CVC.

Then confirm all four (see *Before you call it fixed*): payment in Stripe, order
row, confirmation email, stock decremented — and additionally that
`orders.total` equals the figure the summary showed.

**Switch the keys back afterwards.** A store left on test keys takes no money and
looks completely healthy; `/api/webhook-check` reports `stripe_mode` if you are
unsure which you are on.

### What you cannot test without a real charge

A live capture, a live PayPal capture, and a real Stripe Tax calculation. Test
mode exercises every code path but Stripe's own live rails.

### If a shopper reports a price they did not expect

```sql
select at, actor_email, action, product_title, color_name,
       from_amount, to_amount, starts_at, ends_at, self_approved
  from price_audit order by at desc limit 50;
```

That is the whole point of the register — it answers who, when, and from what,
which `admin_audit_log` cannot do for prices.

---

## Rolling back

Cloudflare Pages → Deployments → the last known-good build → **Rollback**. This is
the fastest lever you have and it is reversible; use it before diagnosing.

Note that **Pages serves the repository root, not `dist/`**. The `dist` allowlist is
CI-only and stale — do not rely on it when reasoning about what shipped.

## Before you call it fixed

Place one real order end to end and confirm **all four**: the payment appears in
Stripe, the order row exists, the confirmation email arrives, and stock went down.
Those are four different systems and this codebase has repeatedly had one of them
broken while the other three looked healthy.
