# Zuwera data backups

A free, automated backup of the customer / order / catalog data in Supabase, in
two forms:

- **Google Sheet** — one tab per table, refreshed daily. Open it any time.
- **Private GitHub repo** — dated CSV + JSON snapshots committed daily, so you
  have point-in-time history and a real restore path.

Both pull from one secure source: a token-protected Supabase **Edge Function**
(`backup-export`). The function runs server-side with the database's service
role, so the master key never leaves Supabase — the Sheet and the repo only ever
hold a harmless shared token.

## What's included / excluded

**Included:** `orders`, `profiles`, `auth_users` (emails + metadata), `reviews`,
`return_requests`, `restock_requests`, `waitlist`, `favorites`, `products`,
`color_variants`, `product_images`, `product_sizes`, `size_charts`,
`site_settings`, `admin_audit_log`.

**Excluded for safety:** password hashes (never returned), `api_key_overrides`,
`webhook_events`, and any secret-looking `site_settings` value (redacted).

---

## Step 1 — Make a shared token

Generate a random string (this is the only secret the Sheet and repo will hold):

```bash
openssl rand -hex 32
```

Keep it handy — you'll paste it in three places below as `BACKUP_TOKEN`.

## Step 2 — Deploy the edge function

Source: [`supabase/functions/backup-export/index.ts`](../supabase/functions/backup-export/index.ts).

**Option A — Supabase CLI**
```bash
supabase functions deploy backup-export --no-verify-jwt --project-ref qfgnrsifcwdubkolsgsq
supabase secrets set BACKUP_TOKEN=<your-token> --project-ref qfgnrsifcwdubkolsgsq
```

**Option B — Dashboard:** Edge Functions → *Deploy a new function* → name it
`backup-export`, paste the file's contents, and turn **Verify JWT = off**. Then
Project Settings → Edge Functions → Secrets → add `BACKUP_TOKEN`.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically — you
do **not** add those.

Your function URL is:
`https://qfgnrsifcwdubkolsgsq.supabase.co/functions/v1/backup-export`

**Test it:**
```bash
curl -s -H "x-backup-token: <your-token>" \
  https://qfgnrsifcwdubkolsgsq.supabase.co/functions/v1/backup-export | head -c 400
```
You should see `{"exported_at": ... "counts": {...}}`. A wrong/missing token
returns `401` (good — that means it's locked down).

## Step 3 — Google Sheet (daily, openable)

1. New Google Sheet → Extensions → Apps Script.
2. Paste [`google-sheet/Code.gs`](google-sheet/Code.gs) (replace the sample).
3. Gear (Project Settings) → Script Properties → add:
   - `BACKUP_URL` = the function URL above
   - `BACKUP_TOKEN` = your token
4. Pick the `setup` function in the toolbar → **Run** → authorize. It pulls a
   backup now and installs a daily 4 AM trigger.

Runs on Google's servers, free, independent of the website.

## Step 4 — Private repo snapshots (history + restore)

1. Create a **new private** GitHub repo, e.g. `zuwera-backups`
   (private — the files hold customer emails/addresses).
2. Add these two files from [`github-backup-repo/`](github-backup-repo/):
   - `.github/workflows/backup.yml`
   - `export.mjs`
3. Repo → Settings → Secrets and variables → Actions → add:
   - `BACKUP_URL` = the function URL
   - `BACKUP_TOKEN` = your token
4. Actions tab → *Daily backup* → **Run workflow** to test. After that it runs
   every day and commits to `backups/<date>/` and `backups/latest/`.

---

## Restoring

- **Quick lookups / a few records:** open the Google Sheet or a CSV from the repo.
- **Re-import a table:** the per-table JSON/CSV can be imported back into Supabase
  (Table editor → Import, or `COPY`/insert). IDs and timestamps are preserved.
- **Worst case (project gone):** spin up a fresh Supabase project, recreate the
  schema, then load the JSON/CSV snapshots.

## Notes

- The daily pull also **keeps a free Supabase project from auto-pausing** after 7
  days of inactivity.
- Rotate the token any time: set a new `BACKUP_TOKEN` secret on the function and
  update it in the Sheet's Script Properties and the repo secret.
- Want a full schema + data SQL dump too (one-command restore)? That's an easy
  add-on using a read-only database role — ask and I'll wire it in.
