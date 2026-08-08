# Architecture

How the pieces fit, and why they are arranged this way. For deployment steps see
[SETUP.md](SETUP.md).

## Shape

```
                 ┌──────────────────────────────────────────┐
   browser ──────│  Cloudflare Pages (repository root)      │
                 │  *.html + *.js + *.css, static, cached   │
                 └───────────────┬──────────────────────────┘
                                 │  /api/*  (per _routes.json)
                 ┌───────────────▼──────────────────────────┐
                 │  Pages Functions — functions/api/, 68     │
                 │  holds every secret; the only tier that   │
                 │  may use the Supabase service-role key    │
                 └──┬─────────┬─────────┬─────────┬──────────┘
                    │         │         │         │
              ┌─────▼───┐ ┌───▼───┐ ┌───▼────┐ ┌──▼──────────┐
              │Supabase │ │Stripe │ │Shippo /│ │Resend /     │
              │Postgres │ │       │ │Veeqo   │ │Brevo / Loops│
              └─────────┘ └───────┘ └────────┘ └─────────────┘
```

The browser also talks to Supabase directly with the **anon** key for public
reads (products, reviews) and authenticated user actions. That path is safe only
because row-level security constrains it — RLS is load-bearing, not decorative.

## Three trust tiers

1. **Browser, anon key.** Reads products and published content. Writes only what
   RLS permits for the signed-in user. The anon key ships in page source; that is
   by design.
2. **Browser, authenticated.** Same key, plus a Supabase session. RLS policies
   key off `auth.uid()` and `profiles.admin_role`.
3. **Pages Functions, service-role key.** Bypasses RLS entirely. Everything that
   must not be forgeable — payment capture, stock decrement, label purchase,
   loyalty credit — happens here and nowhere else.

The rule that keeps this coherent: **never move a service-role operation into the
browser, and never trust a price, quantity, or discount that arrived from one.**
`create-payment-intent` recomputes every amount server-side from the database.

## Frontend

Vanilla JavaScript. No framework, no bundler, no JSX, no TypeScript. Each page is
an ordinary `.html` file; shared behaviour lives in root-level `.js` modules
loaded with `defer`, so they execute in document order after parsing.

That ordering is not incidental — several modules deliberately override globals
declared by earlier ones. `zw-login.js` loads after `auth.js` and `storefront.js`
specifically so its assignment of `window.openAuthModal` wins, making it the
single login entry point. Reordering script tags can silently change behaviour.

**First paint matters here.** Anything that must be correct before the first
frame — theme, header auth state, member pricing — is driven by a small
synchronous inline script reading `localStorage`, placed *before* the element it
controls. Async state (`getSession()` and friends) arrives ~500 ms later and is
too late to prevent a visible flash.

### Styling

`storefront-cohesion.css` is the shared design system and by far the largest
stylesheet: tokens, motion, layout, and the modal system. Three themes
(dark / light / super-light) are selected by classes on `<body>`.

The modal system is the part most worth understanding before editing. All
compact-width (`≤900px`) modal treatment is owned by a single block near the end
of the file. It previously competed with an older full-screen block, and because
`:not(#id)` chains inflate specificity, the *newer* block silently lost — leaving
some modals shaped like sheets but sized like desktop dialogs. Keep it as one
block. If a modal needs different compact behaviour, exclude it explicitly rather
than adding a second competing block.

A few components inject their own `<style>` at runtime (`zw-login.js`,
`lang.js`). Those win over `storefront-cohesion.css` on ties because they are
appended later in the DOM. Editing the stylesheet will not affect them — edit the
component.

## Data model

`site_settings` is the unusual one: a single key/value JSONB table holding almost
all configuration and storefront content — theme, navigation, announcement bar,
feature flags, legal copy, commerce config. It is also where several API keys
live, which is why anonymous reads are gated by an explicit per-key allow-list
rather than blanket public access.

Two consequences:

- **A new publicly-readable key must be added to the allow-list** or the page
  reads nothing and silently uses defaults. The admin still saves it fine, which
  makes this confusing to diagnose.
- **JSONB blobs are read-modify-write**, so concurrent writes lose updates.
  `mutateSetting()` in `functions/api/_commerce.js` wraps writes in a
  compare-and-set retry. Use it for anything that must not lose a concurrent
  update — promo usage counts, loyalty balances — rather than a plain write.

Core tables: `products`, `color_variants`, `product_sizes` (per-colour stock),
`product_images`, `orders`, `profiles`, `reviews`, `favorites`,
`loyalty_ledger`, `bundles`, `admin_audit_log`.

**Money is stored in cents** in order items (`amount`), not dollars. Formatting
divides by 100 at the display boundary. Treating that field as dollars produces a
100× error, which has happened before.

## Checkout

1. Browser posts the cart to `create-payment-intent`.
2. The function **re-prices everything from the database** — client-supplied
   prices are never trusted — applies promos and tax, and returns a Stripe client
   secret.
3. Shipping rates are fetched from Shippo and Veeqo and rate-shopped per service.
   The winning provider is signed into the rate token so the webhook buys the
   label from the same one.
4. Stripe confirms payment in the browser.
5. Stripe calls `/api/stripe-webhook`.

**The webhook is the real transaction boundary.** It writes the order, decrements
stock atomically, buys the shipping label, awards loyalty points, credits
referrals, increments promo usage, and sends confirmation email. If it is
misconfigured, checkout looks successful to the customer while none of that
happens. It is the highest-consequence file in the repository.

## Admin

`admin.html` plus `admin-main.js` (the page's JavaScript was extracted out of
inline `<script>` and is order-sensitive — it creates the top-level `sb` client).
RBAC lives in `profiles.admin_role`, enforced in `_rbac.js` client-side *and* in
RLS policies server-side. Client-side checks are for UX; the RLS policies are the
actual boundary.

`builder.html` is a separate visual page builder. It authenticates with a
short-lived `zw_builder_token` handed over from the admin rather than a Supabase
session, so its `sb` client is effectively anonymous — admin-only settings must
be read through its authenticated REST helper, not the `sb` client, or they come
back empty.

## Caching

`_headers` sets `/*.js` and `/*.css` to `immutable, max-age=31536000`, and HTML
to `no-cache`. Long-lived asset caching only works because
`bump-cache-version.js` content-hashes every asset and rewrites the `?v=` on
every reference at build time. An asset reference that escapes the stamper is
pinned in browsers for a year with no way to push a fix — this has happened, via
URLs built in JavaScript strings rather than `src=` attributes.

HTML is deliberately uncached so a deploy takes effect immediately. Do not add
edge caching for HTML.

## Email

Transactional email tries **Resend → Brevo → Loops** in order, so a single
provider outage does not lose order confirmations. Templates share
`_email-theme.js`, which reads fonts, colours, logo, and editable copy from
`site_settings` server-side (no RLS involved, since Functions use the service
role). Scheduled sends — abandoned cart, review requests — need an external cron
hitting the endpoint with `x-cron-token`; Pages Functions have no built-in
scheduler.
