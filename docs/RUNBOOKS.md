# Incident Runbooks

Quick, do-this-now guides for the failure modes that actually matter for a store.
Keep responses calm and reversible. When in doubt, **roll back first, diagnose after**.

## 0. First 5 minutes of any incident
1. Confirm scope: is it the whole site, one page, or checkout only? Try an
   incognito window (rules out your own cache/localStorage).
2. Check Cloudflare Pages → Deployments: did a deploy just go out? If yes and the
   timing matches, **roll back** to the previous good deployment.
3. Check Supabase → Project status (is the database up / paused?).
4. Check the error log: `SELECT * FROM error_log ORDER BY created_at DESC LIMIT 50;`
   (see [error tracking](#5-runtime-js-errors)).

## 1. Checkout is failing / customers can't pay
- **Symptom:** payment modal errors, or orders not being created.
- Check `/api/create-payment-intent` is up: it should return `400` to an empty POST
  (that's healthy — it means the Function runs). A `5xx` means the Function is broken.
- Verify **Stripe keys** in CF env vars match the current mode (test vs live) — a
  test key in production (or vice-versa) silently breaks payment intents.
- Check Stripe Dashboard → Developers → Logs for the actual API error.
- If a recent deploy touched `checkout.js`/`create-payment-intent`, roll back.

## 2. Orders paid but not appearing / not fulfilled
- **Cause is almost always the Stripe webhook.** Orders are marked paid by
  `/api/stripe-webhook`.
- Stripe Dashboard → Developers → **Webhooks**: confirm the endpoint is
  `https://zuwera.store/api/stripe-webhook` and recent deliveries are `200`.
  Failed deliveries can be **resent** from there.
- `/api/stripe-webhook` returns `400` to an unsigned POST (healthy). `5xx` = broken.
- Check the signing secret env var matches the endpoint's secret in Stripe.

## 3. Whole site down / 5xx
- Cloudflare status (cloudflarestatus.com) and Supabase status first — it may not be you.
- CF Pages → Deployments: if the latest build failed, production keeps serving the
  last good build. If a bad build deployed, **roll back**.
- Supabase paused (free tier pauses after inactivity)? Un-pause it.

## 4. Homepage/theme looks broken (stuck light, wrong logo, tiling)
- 90% of the time this is a **stale client**: DevTools → Application → **Clear site
  data** → reload. The builder preview shares localStorage with the live homepage.
- If it reproduces in a clean incognito window, it's real — check the published
  `page_builder_published` config in `site_settings` and recent `storefront*.js`/CSS commits.

## 5. Runtime JS errors
- Client errors are captured to Supabase `error_log` by `error-reporter.js` →
  `/api/log-error`. Triage: `SELECT message, url, count(*) FROM error_log
  WHERE created_at > now() - interval '1 day' GROUP BY 1,2 ORDER BY 3 DESC;`
- Cloudflare Function logs: CF dashboard → Pages → your project → Functions →
  real-time logs (or `wrangler pages deployment tail`).

## 6. Database restore
- See [DATABASE.md](./DATABASE.md#restore). **Rehearse this before you need it.**

## 7. Suspected key/secret leak
- Rotate immediately in the source (Stripe/Supabase/Cloudflare dashboards) **and**
  update CF env vars. gitleaks (CI) scans history; if a key ever landed in git,
  rotating is mandatory even after removal — git history is forever.
