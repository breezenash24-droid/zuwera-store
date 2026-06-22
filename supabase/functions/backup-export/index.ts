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

// Tables to export (everything worth keeping; secret/noise tables omitted).
const TABLES = [
  "orders", "profiles", "return_requests", "restock_requests", "waitlist",
  "reviews", "favorites", "products", "color_variants", "product_images",
  "product_sizes", "size_charts", "site_settings", "admin_audit_log",
  "webhook_events", "zw_banned_words",
];
// Excluded on purpose: api_key_overrides (secret keys) and zw_insert_throttle
// (transient rate-limit state). webhook_events IS included — it's a structured
// payment-event log (no raw payloads/secrets).

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

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const tables: Record<string, unknown> = {};
  const counts: Record<string, number> = {};

  for (const t of TABLES) {
    const { data, error } = await supabase.from(t).select("*");
    if (error) { tables[t] = { error: error.message }; continue; }
    let rows = data ?? [];
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
    const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
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

  return json({ exported_at: new Date().toISOString(), counts, tables }, 200);
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
