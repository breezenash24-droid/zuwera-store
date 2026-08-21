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

**Included tables:** `orders`, `profiles`, `auth_users` (emails + metadata),
`reviews`, `restock_requests`, `waitlist`, `favorites`, `products`,
`color_variants`, `product_images`, `product_sizes`, `size_charts`,
`site_settings`, `admin_audit_log`, `webhook_events` (payment-event log),
`zw_banned_words`.

**Broken out of `site_settings` JSON into readable tabs:** `returns`, `order_ops`,
`customer_profiles`, `inventory`, `refund_audit_log`, and `promotions` (coupons,
which live nested in `commerce_config.promotions`). The `return_requests` *table*
is an empty legacy table — live returns are the `returns` tab.

**Excluded for safety:** password hashes (never returned), `api_key_overrides`,
`zw_insert_throttle` (transient), and any secret-looking `site_settings` value
(redacted).

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

## New tables are picked up on their own

You do not have to tell the backup about a new table. Each run asks PostgREST
which tables exist — the same OpenAPI document the API itself publishes — and
exports anything it finds, so a table added in Supabase on Tuesday is in
Wednesday morning's backup with its own tab.

Two things it will **not** take, and it says so on the Overview rather than
skipping quietly:

- anything on the never-export list (`api_key_overrides`, `zw_insert_throttle`)
- any newly discovered table whose **name** looks like it holds credentials —
  `*_keys`, `*_secrets`, `*_tokens`, `*_credentials`, `*_passwords`

That second rule exists because discovery turns "somebody added a table" into
"somebody published a table", and this payload lands in a Google Sheet and a git
repo. If it holds one back wrongly, the Overview names it and you can add it to
the known list in `supabase/functions/backup-export/index.ts`.

The known list is a **floor**, not the whole truth: if discovery fails, the run
falls back to it, so a bad day makes the backup no smaller than it was.

**Rows are paged**, so nothing stops at the project's 1000-row "Max rows" cap —
which was silent, and would have started quietly dropping orders the day you
passed a thousand. Customers are paged the same way (that one was hardcoded to
the first 1000). A table past 50,000 rows stops and reports itself as truncated,
which is a truncated backup that knows it is truncated.

Anything discovered gets a plain tab named after the table. To give it a nicer
label, a description and a place in the tab order, add it to `DISPLAY`,
`DESCRIPTION` and `TAB_ORDER` in `google-sheet/Code.gs`.

---

## If the Sheet stops updating

The Apps Script trigger is the part that fails silently, so check it in this
order. Everything you need is in the Sheet itself.

1. **Sheet → Extensions → Apps Script → Executions.** Every run is listed with
   its status and, for a failure, the exact line. This answers the question in
   one look.
2. **Triggers** (same project, left rail). Google **disables a trigger** after
   repeated failures — if `backupToSheet` is missing or greyed out, that is what
   happened. Re-run `setup` to reinstall it.
3. **Gmail**, search `Summary of failures for Google Apps Script`. Google emails
   these; they are easy to miss.
4. **Drive storage.** A full Drive means the script cannot write to the Sheet at
   all. Sheets count against your quota.
5. **Prove the export itself still works**, independently of Google:
   ```bash
   curl -s -H "x-backup-token: <your-token>"      https://qfgnrsifcwdubkolsgsq.supabase.co/functions/v1/backup-export | head -c 400
   ```
   JSON back means the edge function is fine and the fault is on the Google side.
6. **Compare against the GitHub repo backup** (Step 4). If that one kept running,
   the fault is Apps Script alone. If both stopped, look at the token or the
   function.

**Known failure, fixed 2026-08-21.** `getBandings()` can return a banding whose
range no longer exists, and `.remove()` on that handle throws *"The alternating
colors range you selected does not exist."* One unguarded call in
`getOrRenameSheet_` ended the whole run — every night, for six days, with the
Sheet still showing the last date it succeeded. Both removal calls are guarded
now, each tab is written independently, and the Overview carries a **This run**
line that names any tab that failed. If you are running an older copy of
`Code.gs`, paste the current one in.

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
