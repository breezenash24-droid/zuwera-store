// backup-export — read-only, token-protected snapshot of the Zuwera database.
//
// Returns a structured JSON copy of the customer / order / catalog tables so it
// can be mirrored into a Google Sheet and/or committed to a private repo as a
// backup. SECURITY:
//   • Auth is a shared secret in the `x-backup-token` header, compared against
//     the BACKUP_TOKEN function secret. With no token set it rejects everything.
//   • Uses the service role (auto-injected) to read past RLS, but NEVER returns
//     secrets: password hashes are excluded (auth admin API omits them), the
//     api_key_overrides / webhook_events tables are skipped, and secret-looking
//     site_settings values are redacted.
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
];
// Excluded on purpose: api_key_overrides, webhook_events, zw_insert_throttle,
// zw_banned_words (secrets / raw webhook payloads / noise).

// site_settings rows whose key matches this hold API secrets — redact the value.
const SECRET_KEY_RX = /key|token|secret|password|capi|webhook/i;

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
