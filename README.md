# Zuwera Store

A custom, self-hosted e-commerce platform: storefront, checkout, and a full
admin back office. No Shopify, no WooCommerce, no per-transaction platform fee —
the whole stack is code in this repository plus managed services you own.

- **[SETUP.md](SETUP.md)** — deploy a working instance from scratch
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — how the pieces fit together

## Stack

| Layer | Technology |
|---|---|
| Hosting / CDN / edge | Cloudflare Pages |
| Server-side API | Cloudflare Pages Functions (`functions/api/`, 68 endpoints) |
| Database / auth / storage | Supabase (PostgreSQL, RLS, Auth) |
| Payments | Stripe (Payment Intents + webhooks), Apple Pay |
| Shipping | Shippo and Veeqo (rate-shopped per request) |
| Transactional email | Resend, with Brevo and Loops as failover |
| Media | Cloudflare R2 and Cloudinary |
| Analytics | PostHog, Meta CAPI, Google Tag |
| Translation | DeepL |

The frontend is **vanilla JavaScript** — no framework, no bundler, no build step
for application code. Pages are plain `.html` files served from the repository
root; shared behaviour lives in root-level `.js` modules loaded with `defer`.

## Running locally

```bash
npm install          # also runs the postinstall build chain (see below)
npx wrangler pages dev .
```

Opening `index.html` directly in a browser renders the storefront shell, but
anything that calls `/api/*` (checkout, shipping rates, admin actions) needs the
Wrangler dev server, since those routes are Cloudflare Functions.

A local instance still talks to whatever Supabase and Stripe projects the
environment variables point at. Point it at test/dev projects, or you will be
reading and writing production data. See [SETUP.md](SETUP.md).

## Build chain

There is no bundler. `postinstall` runs three scripts in order:

```
stamp-config-defaults.js   inline non-secret defaults into config
minify-inplace.js          minify root .js/.css  (only when CF_PAGES is set)
bump-cache-version.js      content-hash every asset, rewrite ?v= references
```

`bump-cache-version.js` matters more than it looks. `_headers` serves `/*.js` and
`/*.css` as `immutable, max-age=31536000`, so a reference without a fresh `?v=`
hash is pinned in browser caches for a year. The stamper rewrites both
`src=`/`href=` attributes and JS string literals that already carry a `?v=`.

**Cloudflare Pages serves the repository root, not `dist/`.** `dist/` is a local
build artifact, gitignored, and not what ships.

## Commands

| Command | What it does |
|---|---|
| `npm run audit:repo` | Syntax-checks every JS file and inline script, validates asset and `/api` references |
| `npm run deployment-checklist` | ~40 assertions about wiring that static analysis cannot catch |
| `npm run ci` | Both of the above |
| `npm run checkout-cart-smoke` | Smoke test for cart and checkout maths |
| `npm run bump-cache` | Re-stamp asset hashes by hand |

### Testing, stated honestly

`npm test` runs **327 checks across 9 suites** in `tests/`. No framework and no
dev dependency: each suite is a plain Node script that prints its results and
exits non-zero on failure, so a clean checkout can run the tests before it
installs anything.

Alongside them, CI runs static analysis (`repo-audit.js`), 30 wiring assertions
(`deployment-checklist.js`), a checkout/cart smoke script, and gitleaks secret
scanning on every push. `npm run ci` runs the lot.

**What the suites cover.** Pure logic — discount arithmetic, tax rates and their
admin overrides, config normalising, preview-token signing and forgery — and the
contracts between files that this codebase keeps breaking: the two typography
selector maps that must stay identical, the four SQL files that must carry the
same RLS allow-list, CSS specificity where a rule has to outrank a specific other
rule, and cache headers that must differ between catalogue and stock. Most of
them exist because the exact bug they describe shipped once already; several
assert the arithmetic of a past regression so it is described, not just caught.

**What they do not cover, which is the honest gap.** They do not drive a browser
and they do not talk to Supabase or Stripe. There is no end-to-end run of a real
checkout against Stripe test cards, and no test exercises RLS policies against a
live database. So a change to payments, stock or auth still deserves manual
verification against a test Stripe key and a non-production Supabase project —
the suite will catch a broken contract, not a broken integration.

## Repository layout

```
*.html                 storefront + admin pages, served from root
*.js                   shared frontend modules (vanilla, loaded with defer)
storefront-cohesion.css shared design system — the largest single stylesheet
functions/api/         Cloudflare Pages Functions (server-side, 68 endpoints)
scripts/               build and verification tooling
supabase-*.sql         schema and RLS policies, run by hand (see SETUP.md)
backup-tools/          scheduled data export to Sheets + a private repo
_headers               security headers and cache policy
_routes.json           tells Pages which paths invoke Functions
```

## Admin

`admin.html` is a single-page back office covering products, variants,
inventory, orders, returns, customers, promotions, loyalty, feature flags, and
storefront content. Access is gated by `profiles.admin_role` (RBAC), enforced
both client-side and in RLS policies, with TOTP MFA and an audit log.

`builder.html` is a separate visual page builder for storefront layout.

## Known rough edges

Kept here deliberately, because finding them by surprise is worse:

- **Storefront content lives in `site_settings`**, a single JSONB key/value
  table. Anon reads are gated by a per-key allow-list policy; a new public key
  must be added to that allow-list or the page silently falls back to defaults.
  See the header comments in `supabase-feature-flags-public-read.sql`.
- **~1,400 hardcoded references** to the Zuwera brand, `zuwera.store`, and a
  specific Supabase project ref. Re-skinning this for another brand is a real
  search-and-replace exercise, not a config change.
- **30 `supabase-*.sql` files** with no manifest and no migration tool. The run
  order is documented in [SETUP.md](SETUP.md); `supabase-master-schema.sql`
  begins with `DROP TABLE ... CASCADE` and must never be run against a database
  with data in it.
- **Environment variables have accumulated aliases** — several settings are read
  under two or three different names. [SETUP.md](SETUP.md) lists the canonical
  one for each.
