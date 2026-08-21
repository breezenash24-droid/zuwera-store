// backup-export — read-only, token-protected snapshot of the Zuwera database.
//
// Returns a structured JSON copy of the customer / order / catalog tables so it
// can be mirrored into a Google Sheet and/or committed to a private repo as a
// backup. SECURITY:
//   • Auth is a shared secret in the `x-backup-token` header, compared against
//     the BACKUP_TOKEN function secret. With no token set it rejects everything.
//   • Uses the service role (auto-injected) to read past RLS, but NEVER returns
//     secrets: password hashes are excluded (auth admin API omits them), the
//     api_key_overrides table is skipped, and secret-looking site_settings
//     values are redacted.
//   • Deploy with JWT verification OFF (it uses its own token), e.g.
//       supabase functions deploy backup-export --no-verify-jwt
//
// Env (BACKUP_TOKEN you set; the rest are auto-provided by Supabase):
//   BACKUP_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── THE TABLES THIS KNOWS ABOUT, WHICH IS A FLOOR AND NOT THE WHOLE TRUTH ────
//
// This list used to BE the backup: a table not named here was silently absent,
// which is the kind of gap you discover on the day you need it. Discovery now
// adds to it (see discoverTables), and this stays as the floor — if discovery
// fails for any reason, the backup is exactly what it was yesterday rather than
// suddenly smaller. Failure must never shrink a backup.
const TABLES = [
  "orders", "profiles", "return_requests", "restock_requests", "waitlist",
  "reviews", "favorites", "products", "color_variants", "product_images",
  "product_sizes", "size_charts", "site_settings", "admin_audit_log",
  "webhook_events", "zw_banned_words",
];

// ── AND THE ONES IT MUST NEVER TAKE ─────────────────────────────────────────
//
// Auto-discovery turns "somebody added a table" into "somebody published a
// table" — this payload lands in a Google Sheet and a git repo. Both of those
// are more places than a secret should ever be, and neither of them asked.
//
// So a discovered table has to get past two gates. Named here, or looking like
// it holds credentials, and it is held back and REPORTED rather than dropped
// quietly: being told "api_key_overrides was skipped" is how you find out the
// rule is working, and how you argue with it if it is wrong.
const NEVER_EXPORT = new Set([
  "api_key_overrides",   // API secrets, by definition
  "zw_insert_throttle",  // transient rate-limit state, worthless in a backup
]);

// Applied to DISCOVERED tables only. The known list above wins outright, which
// is what keeps webhook_events — a structured payment-event log with no raw
// payloads, deliberately included — from being caught by /webhook/ here.
const SECRET_TABLE_RX = /(^|_)(key|keys|secret|secrets|token|tokens|credential|credentials|password|passwords|webhook|webhooks)(_|$)/i;

// How many rows to ask for at a time, and the point at which a table is so big
// that something has gone wrong and the run should say so rather than sit there.
const PAGE = 1000;
const MAX_ROWS_PER_TABLE = 50000;

// site_settings rows whose key matches this hold API secrets — redact the value.
const SECRET_KEY_RX = /key|token|secret|password|capi|webhook/i;

// Some operational data (returns, order ops, customer profiles, inventory) lives
// as JSON blobs in site_settings rather than in dedicated tables. Pull these out
// into readable tables so the backup shows them as rows, not one giant cell.
const COMMERCE_BLOBS: Array<{ key: string; table: string; arrayProp?: string }> = [
  { key: "commerce_returns", table: "returns", arrayProp: "requests" },
  { key: "commerce_order_ops", table: "order_ops" },
  { key: "commerce_customer_profiles", table: "customer_profiles" },
  { key: "commerce_inventory", table: "inventory" },
  { key: "refund_audit_log", table: "refund_audit_log" },
];

// ── WHAT TABLES EXIST, ASKED OF POSTGREST ITSELF ────────────────────────────
//
// PostgREST publishes an OpenAPI document at the REST root describing every
// table and view it exposes. That is the same source of truth the API uses, so
// a table that a client could read is a table this finds — no migration, no
// SQL function, and nothing to remember to update when the schema changes.
//
// Supabase currently answers with Swagger 2.0 (`definitions`); newer PostgREST
// emits OpenAPI 3 (`components.schemas`). Both are read, because which one you
// get is somebody else's deployment decision.
//
// NEVER THROWS. A discovery failure returns nothing and the run proceeds on the
// known list — the floor. The alternative, a backup that fails entirely because
// it could not enumerate, trades a complete backup for no backup.
async function discoverTables(url: string, key: string): Promise<string[]> {
  try {
    const resp = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/openapi+json" },
    });
    if (!resp.ok) return [];
    const spec = await resp.json();
    const defs = spec?.definitions ?? spec?.components?.schemas ?? {};
    return Object.keys(defs).filter((n) => typeof n === "string" && !n.startsWith("("));
  } catch (_) {
    return [];
  }
}

// ── EVERY ROW, NOT THE FIRST THOUSAND ───────────────────────────────────────
//
// `select("*")` is capped by the project's "Max rows" setting — 1000 by
// default — and the cap is SILENT: you get a thousand rows and no indication
// there were more. A backup that quietly stops at a thousand is worse than one
// that is obviously missing, because it looks complete.
//
// This pages until a short page comes back. If a table is somehow bigger than
// MAX_ROWS_PER_TABLE it stops and says so, which is a truncated backup that
// KNOWS it is truncated — the only acceptable kind.
async function fetchAll(
  supabase: ReturnType<typeof createClient>,
  table: string,
): Promise<{ rows: Record<string, unknown>[]; error?: string; truncated?: boolean }> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; from < MAX_ROWS_PER_TABLE; from += PAGE) {
    const { data, error } = await supabase.from(table).select("*").range(from, from + PAGE - 1);
    if (error) return { rows, error: error.message };
    const batch = (data ?? []) as Record<string, unknown>[];
    rows.push(...batch);
    if (batch.length < PAGE) return { rows };
  }
  return { rows, truncated: true };
}

// Turn an object-map ({id: {...}}) into an array of rows ({id, ...fields}).
function mapToRows(obj: unknown): Record<string, unknown>[] {
  if (!obj || typeof obj !== "object") return [];
  if (Array.isArray(obj)) return obj as Record<string, unknown>[];
  return Object.entries(obj as Record<string, unknown>).map(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? { id: k, ...(v as Record<string, unknown>) }
      : { id: k, value: v }
  );
}

Deno.serve(async (req) => {
  const expected = Deno.env.get("BACKUP_TOKEN");
  const provided = req.headers.get("x-backup-token") || "";
  if (!expected || provided !== expected) {
    return json({ error: "unauthorized" }, 401);
  }

  const supaUrl = Deno.env.get("SUPABASE_URL")!;
  const supaKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supaUrl, supaKey, { auth: { persistSession: false } });

  const tables: Record<string, unknown> = {};
  const counts: Record<string, number> = {};

  /* ── WHICH TABLES, DECIDED FRESH EVERY RUN ────────────────────────────────
     The known list first and in its own order — the Sheet lays its tabs out
     that way and a stable order is worth keeping — then anything discovered
     that is not already in it, alphabetically, so a new table lands in a
     predictable place rather than wherever PostgREST happened to list it. */
  const discovered = await discoverTables(supaUrl, supaKey);
  const known = new Set(TABLES);
  const held: Array<{ table: string; why: string }> = [];
  const added: string[] = [];

  for (const name of discovered.slice().sort()) {
    if (known.has(name)) continue;
    if (NEVER_EXPORT.has(name)) { held.push({ table: name, why: "on the never-export list" }); continue; }
    if (SECRET_TABLE_RX.test(name)) { held.push({ table: name, why: "name looks like it holds credentials" }); continue; }
    added.push(name);
  }

  const exportList = [...TABLES, ...added];
  const truncated: string[] = [];

  for (const t of exportList) {
    const got = await fetchAll(supabase, t);
    if (got.error) { tables[t] = { error: got.error }; continue; }
    if (got.truncated) truncated.push(t);
    let rows = got.rows;
    if (t === "site_settings") {
      // Split the commerce_* JSON blobs out into their own readable tables.
      const byKey: Record<string, unknown> = {};
      const blobKeys = new Set(COMMERCE_BLOBS.map((b) => b.key));
      let commerceConfig: Record<string, unknown> | null = null;
      rows = rows.filter((r: Record<string, unknown>) => {
        const k = String(r.key ?? "");
        if (k === "commerce_config" && r.value && typeof r.value === "object") {
          commerceConfig = r.value as Record<string, unknown>; // peek; keep in rows
        }
        if (blobKeys.has(k)) { byKey[k] = r.value; return false; }
        return true;
      });
      for (const b of COMMERCE_BLOBS) {
        const v = byKey[b.key];
        const src = b.arrayProp && v && typeof v === "object"
          ? (v as Record<string, unknown>)[b.arrayProp]
          : v;
        const arr = mapToRows(src);
        tables[b.table] = arr;
        counts[b.table] = arr.length;
      }
      // Coupons/discounts are nested in commerce_config.promotions.
      const promos = commerceConfig && Array.isArray(commerceConfig.promotions)
        ? (commerceConfig.promotions as unknown[]) : [];
      tables["promotions"] = promos;
      counts["promotions"] = promos.length;
      // Redact secret-looking values from whatever site_settings rows remain.
      rows = rows.map((r: Record<string, unknown>) =>
        SECRET_KEY_RX.test(String(r.key ?? "")) ? { ...r, value: "[redacted]" } : r
      );
    }
    tables[t] = rows;
    counts[t] = rows.length;
  }

  // auth.users — emails/metadata only. listUsers() never returns password hashes.
  try {
    /* Was `{ page: 1, perPage: 1000 }` — the first thousand customers and no
       word about the rest. Same silent cap as the row limit, hardcoded instead
       of configured, and just as invisible at the moment it starts biting. */
    const collected: Array<Record<string, unknown>> = [];
    let error: { message: string } | null = null;
    for (let page = 1; page <= 50; page += 1) {
      const res = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
      if (res.error) { error = res.error; break; }
      const batch = res.data?.users ?? [];
      collected.push(...(batch as unknown as Array<Record<string, unknown>>));
      if (batch.length < 1000) break;
    }
    const data = error ? null : { users: collected as unknown as Array<Record<string, any>> };
    if (!error && data) {
      const users = data.users.map((u) => ({
        id: u.id,
        email: u.email,
        phone: u.phone,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
        email_confirmed_at: u.email_confirmed_at,
        provider: u.app_metadata?.provider,
        providers: u.app_metadata?.providers,
      }));
      tables["auth_users"] = users;
      counts["auth_users"] = users.length;
    }
  } catch (e) {
    tables["auth_users"] = { error: String(e) };
  }

  /* WHAT THIS RUN DECIDED, said out loud. Discovery that works invisibly is
     discovery you cannot audit — "which tables am I actually backing up" has to
     be answerable without reading this file, and a table held back for looking
     like a credential store has to be visible so it can be argued with. */
  return json({
    exported_at: new Date().toISOString(),
    counts,
    discovery: {
      /* 0 means the OpenAPI read failed and the run fell back to the known
         list. Not an error — but the difference between "nothing new" and
         "could not look" matters, so it is not reported as the same thing. */
      seen: discovered.length,
      added,
      held,
      truncated,
    },
    tables,
  }, 200);
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
