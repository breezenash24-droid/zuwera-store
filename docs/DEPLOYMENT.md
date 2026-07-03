# Deployment & Release Process

Production is **Cloudflare Pages**, which builds and deploys the `main` branch
automatically. Treat `main` as always-shippable.

## The flow (use this, not direct pushes to main)

```
feature branch  ──PR──▶  CI (GitHub Actions)  ──▶  CF preview URL  ──▶  merge to main  ──▶  production
```

1. **Branch.** `git checkout -b fix/thing` — never commit straight to `main`.
2. **Open a PR.** GitHub Actions (`.github/workflows/ci.yml`) runs on the PR:
   - `npm run audit:repo` — JS/HTML syntax, broken asset refs, `/api` endpoint resolution.
   - `npm run deployment-checklist` — semantic wiring + checkout/cart smoke tests.
   - `npm run build` — static build sanity.
   - gitleaks secret scan + `npm audit`.
   A red check means **do not merge**.
3. **Preview.** Cloudflare Pages posts a per-PR preview URL (`<hash>.zuwera-store.pages.dev`).
   Verify the actual change there — this is your staging environment.
4. **Merge to `main`.** CF builds `main` → production at `zuwera.store`.

> One-time setup: in GitHub → Settings → Branches, add a **branch protection rule**
> on `main` requiring the `CI / verify` and `CI / secrets-scan` checks to pass
> before merge. That turns the pipeline from advisory into an actual gate.

## Build specifics
- `scripts/cloudflare-pages-build.js` copies an explicit **allowlist** of files
  (+ `.well-known/`, `assets/`, `images/`) into `dist/`. **A new client-side file
  will not deploy unless you add it to that `files[]` array.** Functions in
  `functions/` deploy automatically (scoped by `_routes.json` to `/api/*`,`/product/*`).
- `postinstall` runs `scripts/bump-cache-version.js`, which content-hashes root
  `.js`/`.css` and rewrites `file.ext?v=hash` in the HTML. Cloudflare re-hashes
  assets with LF endings, so the live `?v=` can differ from local — expected.
- `builder.html` is **not** a versioned asset (it's one big inline script), so it's
  fetched fresh; a builder change is live as soon as CF finishes building.

## Rollback
Fastest path is the Cloudflare Pages dashboard → **Deployments → (previous good) →
Rollback**. It re-points production at that build instantly, no git needed.
For a code revert: `git revert <bad-sha>` → PR → merge (keeps history clean).

## Config that lives outside git (know where it is)
- **Secrets / env vars:** Cloudflare Pages → Settings → Environment variables
  (Stripe keys, `SUPABASE_SERVICE_ROLE_KEY`, `BACKUP_TOKEN`, R2/Cloudinary, etc.).
- **Store content / settings:** Supabase `site_settings` (key/value) + `page_builder*`.
- **DB schema:** applied via SQL — see [DATABASE.md](./DATABASE.md).
