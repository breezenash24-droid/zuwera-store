# Setup

Deploying a working instance from scratch. Budget half a day for a first run —
most of it is creating accounts and copying keys, not writing code.

## 1. Accounts you need

| Service | Required? | Used for |
|---|---|---|
| Cloudflare | **yes** | Pages hosting, Functions, R2 media storage |
| Supabase | **yes** | Postgres, auth, row-level security |
| Stripe | **yes** | Payments, webhooks |
| Resend | **yes** | Transactional email |
| Shippo | recommended | Live shipping rates and labels |
| Veeqo | optional | Second shipping provider, rate-shopped against Shippo |
| Brevo / Loops | optional | Email failover if Resend is down |
| Cloudinary | optional | Image transforms (R2 alone also works) |
| PostHog | optional | Product analytics |
| DeepL | optional | Storefront translation |
| Turnstile | optional | Bot protection on auth forms |

## 2. Database

Run the SQL in the Supabase SQL editor, **in this order**.

> **`supabase-master-schema.sql` begins with `DROP TABLE ... CASCADE`.**
> It destroys all existing data. Run it only on an empty project. Never run it
> against an instance that has orders in it.

**Foundation — run one of these, not all three:**

1. `supabase-master-schema.sql` — the canonical schema for a fresh install.
   Supersedes `supabase-setup.sql` and `supabase-migration-v2.sql`, which are
   earlier generations kept for history. Skip those two.

**Then the feature migrations.** These layer on top and are mostly independent:

```
supabase-rbac.sql                     admin roles (run before other admin SQL)
supabase-rbac-custom-access.sql
supabase-admin-audit-log.sql
supabase-profiles-rls-hardening.sql
supabase-security-hardening.sql
supabase-atomic-settings.sql          REQUIRED — compare-and-set for settings
supabase-decrement-stock-fix.sql      REQUIRED — atomic stock decrement
supabase-feature-flags.sql
supabase-feature-flags-public-read.sql
supabase-loyalty.sql
supabase-referrals.sql
supabase-bundles.sql
supabase-journal.sql
supabase-newsletter.sql
supabase-abandoned-carts.sql
supabase-email-log.sql
supabase-review-photos.sql
supabase-review-photo-moderation.sql
supabase-review-requests.sql
supabase-product-questions.sql
supabase-product-sports.sql
supabase-product-best-for.sql
supabase-product-descriptor.sql
supabase-local-delivery.sql
supabase-migration-media.sql
```

Two are not optional despite the names. `supabase-atomic-settings.sql` installs
the compare-and-set path for `site_settings` writes; without it, concurrent
writes silently lose updates. `supabase-decrement-stock-fix.sql` installs the
atomic stock RPC; without it, oversells are possible under load.

### The public-read allow-list

`site_settings` holds both storefront content and API-key secrets, so anonymous
reads are restricted to an explicit per-key allow-list.

**Three files ALTER that same policy, and `ALTER POLICY` replaces the list rather
than appending to it.** They are kept identical on purpose:

```
supabase-image-effects.sql
supabase-bag-panel.sql
supabase-feature-flags-public-read.sql
```

Run any one of them and you get the complete, correct list. If you add a new
publicly-readable key later, **add it to all three**, or whichever runs last will
silently revoke it — the storefront then falls back to defaults with no error
anywhere.

## 3. Cloudflare Pages

Connect the repository. Settings:

- **Build command:** `npm install`
- **Build output directory:** `/` (the repository root — *not* `dist/`)
- **Node version:** 18 or newer

`npm install` triggers the `postinstall` chain that minifies assets and stamps
cache-busting hashes. There is no separate build step.

`_routes.json` declares which paths invoke Functions (`/api/*`, `/product/*`);
everything else is served as a static asset.

## 4. Environment variables

Set these in **Cloudflare Pages → Settings → Environment variables**, not in a
`.env` file. Nothing secret belongs in the repository.

Several settings are readable under more than one name, an artefact of renames
over time. The canonical name is listed first; the alias still works.

### Required

| Variable | Notes |
|---|---|
| `SUPABASE_URL` | alias: `SUPABASE_PROJECT_URL` |
| `SUPABASE_ANON_KEY` | public by design; also hardcoded in client pages |
| `SUPABASE_SERVICE_ROLE_KEY` | aliases: `SUPABASE_SERVICE_KEY`, `SUPABASE_SERVICE_ROLE` |
| `STRIPE_SECRET_KEY` | `sk_test_…` until you are ready to take real money |
| `STRIPE_PUBLISHABLE_KEY` | also `STRIPE_TEST_PUBLISHABLE_KEY` / `STRIPE_LIVE_PUBLISHABLE_KEY` |
| `STRIPE_WEBHOOK_SECRET` | from the webhook you create in step 5 |
| `RESEND_API_KEY` | |
| `RESEND_FROM_EMAIL` | must be on a domain verified with Resend |
| `SITE_URL` | full origin, e.g. `https://example.com` |
| `ADMIN_EMAILS` | comma-separated; these accounts get admin access |

> **Watch the service-role key.** Server code resolves it as
> `SUPABASE_SERVICE_ROLE_KEY || SUPABASE_SERVICE_KEY || SUPABASE_ANON_KEY`. If it
> is missing or misspelled, requests silently fall back to anonymous privileges
> and RLS quietly blocks the writes instead of erroring. Symptoms are "orders
> aren't saving" with a clean log. Check this variable first.

### Shipping

| Variable | Notes |
|---|---|
| `SHIPPO_API_KEY` | |
| `SHIPPO_FROM_NAME` / `_STREET1` / `_CITY` / `_STATE` / `_ZIP` / `_COUNTRY` / `_PHONE` / `_EMAIL` | ship-from address |
| `SHIPPO_FREE_LIMIT` | default 30 — Shippo's free monthly label allowance |
| `STANDARD_SHIPPING_CENTS` | alias: `DEFAULT_SHIPPING_CENTS`; flat-rate fallback |
| `FREE_SHIPPING_THRESHOLD` | alias: `SHIPPING_FREE_THRESHOLD` |
| `CHECKOUT_RATE_SECRET` | signs shipping rate tokens — set to any long random string |

### Tax

| Variable | Notes |
|---|---|
| `STATE_TAX_RATES` | JSON map; aliases: `SALES_TAX_BY_STATE`, `TAX_RATES_BY_STATE` |
| `DEFAULT_SALES_TAX_RATE` | fallback when a state is not listed |

### Optional integrations

`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`,
`R2_PUBLIC_BASE_URL` · `BREVO_API_KEY` · `POSTHOG_PROJECT_API_KEY`,
`POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID` · `META_PIXEL_ID`,
`META_CAPI_TOKEN` · `DEEPL_API_KEY`, `TRANSLATE_API_TOKEN`,
`TRANSLATE_ALLOWED_ORIGINS` · `TURNSTILE_SECRET_KEY` ·
`APPLE_PAY_MERCHANT_IDENTIFIER`, `APPLE_PAY_CERT`, `APPLE_PAY_MTLS` (see
[APPLE_PAY_SETUP.md](APPLE_PAY_SETUP.md)) · `REFUND_SECRET`,
`SECURITY_ALERT_EMAIL`, `SECURITY_ALERT_RESEND_KEY`

## 5. Stripe webhook

Create a webhook endpoint in the Stripe dashboard:

- **URL:** `https://yourdomain.com/api/stripe-webhook`
- **Events:** `payment_intent.succeeded`, `payment_intent.payment_failed`,
  `charge.refunded`

Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

The webhook does a lot more than mark orders paid — it decrements stock, buys
the shipping label, awards loyalty points, credits referrals, increments promo
usage, and sends the confirmation email. If it is misconfigured, checkout still
appears to succeed while none of that happens. Verify it before launch.

## 6. First admin account

1. Sign up through the storefront like a normal customer.
2. Add that email to `ADMIN_EMAILS` and redeploy.
3. In Supabase, set the account's `profiles.admin_role` to `super_admin`.
4. Sign in at `/admin.html` and enrol in TOTP MFA when prompted.

## 7. Verify

```bash
npm run ci                    # static analysis + wiring assertions
npm run checkout-cart-smoke   # cart and checkout maths
```

Then, by hand, with a Stripe **test** key:

- Place an order end to end and confirm it appears in the admin
- Confirm the confirmation email arrives
- Confirm stock decremented on the ordered variant
- Confirm a shipping label was purchased (or that the failure is recorded)
- Sign in and out on the storefront
- Load the admin on a phone — layout differs materially from desktop

One `deployment-checklist` assertion ("Every local js/css reference is
cache-bustable") currently fails on a clean checkout. It is a stale assertion,
not a real defect: `bump-cache-version.js` deliberately allows a missing `?v=`
and adds one at build time. Everything else should pass.
