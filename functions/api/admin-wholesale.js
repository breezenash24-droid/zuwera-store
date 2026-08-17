/**
 * /api/admin-wholesale — grant, change and revoke wholesale accounts.
 *
 * Wholesale was buildable but not OPERABLE. The resolver, the customer group,
 * the order minimum and the database guard all shipped; the only way to create
 * an account was to write JSON into profiles.wholesale by hand in the SQL
 * editor. A feature whose happy path is "open the SQL editor" is not a feature
 * a licensee can sell, and it is not one this store's owner should be running
 * either — one mistyped key and a buyer either pays retail or pays nothing.
 *
 * ── WHY THE SERVER OWNS THIS ────────────────────────────────────────────────
 *
 * profiles.wholesale decides what a customer is charged. Migration 0024 puts a
 * trigger on the column so a shopper cannot grant it to themselves, and that
 * trigger exempts the service role — which is what this file runs as. So this
 * endpoint IS the enforcement point for everything the trigger cannot see:
 * whether the caller may price, and whether the JSON is a shape the resolver
 * understands.
 *
 * The browser never sends a wholesale object. It sends fields, and this file
 * builds the object — because a body that carries
 * `{"status":"approved","min_order_cents":0}` is a body that can say anything,
 * and min_order_cents 0 is the difference between a $250 minimum and none.
 *
 * ── STATUS IS NOT A FREE-TEXT FIELD ─────────────────────────────────────────
 *
 * Only `approved` puts a buyer in the wholesale customer group — see
 * isWholesaleBuyer() in _price-resolution.js. `applied` and `suspended` are
 * deliberately NOT the group: an application that priced at wholesale while it
 * was still an application would be an open door. Anything else is refused
 * here rather than stored and quietly ignored later, because a status the
 * resolver does not recognise reads as "not approved" and looks like a bug.
 *
 * ── AND THE LIST HAS TO EXIST ───────────────────────────────────────────────
 *
 * An approved buyer with no wholesale price list pays retail. Nothing errors —
 * listApplies() simply matches nothing and the resolver falls back to the
 * catalogue price, which is the behaviour that keeps an empty pricing system
 * from selling at zero. Correct, and indistinguishable from a broken feature.
 * So the GET reports whether the list exists, and `ensure-list` creates it, so
 * the page can say what is missing instead of leaving it to be discovered.
 */

import { cors, json, verifyAdmin } from './_commerce.js';
import { permsHave } from './_rbac.js';
import { wholesaleMinimumCents } from './_price-resolution.js';

function H(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!env.SUPABASE_URL || !key) return null;
  return { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
}

/* Same shape as admin-prices.js. verifyAdmin(env, token) returns the admin or
   NULL — not {ok} — and passing (request, env) makes the Request object the env,
   which fails with a configuration error that is not the real problem. */
async function requireAdmin(request, env, capability) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const admin = await verifyAdmin(env, token);
  if (!admin) throw new Error('Not authorised.');
  if (capability && !permsHave(admin.permissions, capability)) {
    throw new Error('Your role does not have permission for this action.');
  }
  return admin;
}

/* The three the resolver knows. Kept here as the single gate rather than
   validated in the browser, which can be skipped.
   Exported so tests can check the round trip against _price-resolution.js
   rather than against a second copy of these strings — two files agreeing on a
   JSON shape is exactly the kind of agreement that quietly stops being true. */
export const STATUSES = ['applied', 'approved', 'suspended'];
export const TERMS = ['prepaid', 'net15', 'net30', 'net60'];

const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/* Money arrives as dollars from a form and is stored as cents, because the
   resolver compares it against a cart subtotal in cents. A minimum stored in
   the wrong unit is a $250 minimum that refuses a $25,000 order. */
export function minimumCents(v) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

/**
 * The stored object, built from fields rather than accepted whole.
 *
 * `prev` is what is already there, so a partial edit does not silently drop
 * approved_at or the original approver — the record of WHO granted an account
 * is the part that matters six months later.
 */
export function buildWholesale(fields, prev, actor) {
  const status = STATUSES.includes(String(fields.status)) ? String(fields.status) : 'applied';
  const before = prev && typeof prev === 'object' ? prev : {};
  const out = {
    status,
    company: text(fields.company, 120),
    tax_id: text(fields.taxId, 60),
    min_order_cents: minimumCents(fields.minOrder),
    terms: TERMS.includes(String(fields.terms)) ? String(fields.terms) : 'prepaid',
    notes: text(fields.notes, 1000),
    /* Whether a resale certificate is on file. Stored on the account so the
       page can show its own state, while the thing that actually zeroes tax is
       the tax_exemptions row syncExemption() writes — one flag, two places,
       and the row is the one _tax.js reads. */
    resale_exempt: fields.resaleExempt === true || fields.resaleExempt === 'true',
  };
  /* Stamped the first time it becomes approved and never rewritten, so
     re-saving an approved account does not keep moving the date it was granted.
     A suspension that is later lifted keeps the original approval — the account
     was granted once. */
  if (status === 'approved') {
    out.approved_at = before.approved_at || new Date().toISOString();
    out.approved_by = before.approved_by || actor || '';
  } else if (before.approved_at) {
    out.approved_at = before.approved_at;
    out.approved_by = before.approved_by || '';
  }
  return out;
}

/* Whether a list exists that an approved wholesale buyer would actually match.
   Not "is there a row called wholesale" — customer_group is the field
   listApplies() reads, and a list named "Wholesale" with a null group applies
   to EVERYBODY, which is the accident this check is here to catch. */
async function wholesaleList(env) {
  const h = H(env);
  if (!h) return null;
  const rows = await fetch(
    `${env.SUPABASE_URL}/rest/v1/price_lists?select=id,code,name,priority,active,region,channel,rule_percent_off&customer_group=eq.wholesale`,
    { headers: h, cache: 'no-store' },
  ).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const list = Array.isArray(rows) ? rows : [];
  return {
    exists: list.length > 0,
    active: list.some((l) => l.active !== false),
    lists: list,
  };
}

/**
 * File or withdraw this buyer's resale certificate.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * _tax.js has always read public.tax_exemptions and zeroed the tax for a
 * matching, unrevoked, unexpired certificate. The machinery worked. Nothing
 * could ever put a row in it — no endpoint, no screen — so every wholesale
 * order was charged sales tax it did not owe. Migration 0011 names the cost
 * itself: "an over-collection is money taken from a customer who did not owe
 * it, which is worse than the under-collection everyone worries about."
 *
 * ── Why it is a separate switch, not a consequence of the Tax ID ────────────
 *
 * Charging nobody tax is a legal claim about a document somebody is holding,
 * not a formatting side effect of a field. A Tax ID is recorded on plenty of
 * accounts that hold no resale certificate — VAT numbers, EINs for invoicing —
 * and inferring an exemption from one would zero the tax on all of them.
 * So the certificate is asked for in its own words, and only ever filed for an
 * APPROVED account: a suspended trade buyer buying at retail owes retail tax.
 *
 * Revocation is a revoked_at stamp, never a delete. A certificate that applied
 * to orders already taken has to stay readable, because the question a tax
 * authority asks is "why was this order not charged" and the answer has to
 * still exist.
 */
async function syncExemption(env, { customerId, email, exempt, certificate, company, actorId }) {
  const h = H(env);
  if (!h) return;
  const base = env.SUPABASE_URL + '/rest/v1/';
  const live = `${base}tax_exemptions?user_id=eq.${encodeURIComponent(customerId)}&revoked_at=is.null`;

  if (!exempt) {
    await fetch(live, {
      method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({ revoked_at: new Date().toISOString() }),
    }).catch(() => {});
    return;
  }

  /* Already on file → update it in place rather than stacking a second live
     certificate for the same buyer. Two matching rows is not twice as exempt;
     it is an audit trail that cannot say which one was applied. */
  const existing = await fetch(live + '&select=id&limit=1', { headers: h, cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : [])).catch(() => []);

  const record = {
    user_id: customerId,
    email: email || null,
    certificate: certificate || null,
    business_name: company || null,
    /* Empty means every state. Most certificates are state-specific, and
       narrowing them is the next thing this wants — but claiming a narrower
       scope than the admin stated would under-apply an exemption they filed. */
    states: [],
    revoked_at: null,
    created_by: actorId || null,
  };

  if (Array.isArray(existing) && existing[0]) {
    await fetch(`${base}tax_exemptions?id=eq.${encodeURIComponent(existing[0].id)}`, {
      method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(record),
    }).catch(() => {});
    return;
  }
  await fetch(`${base}tax_exemptions`, {
    method: 'POST', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(record),
  }).catch(() => {});
}

export async function onRequestGet({ request, env }) {
  try {
    await requireAdmin(request, env, 'pricing_write');
    const h = H(env);
    if (!h) return json({ ok: false, error: 'Not configured.' }, 503, cors(env));
    const base = env.SUPABASE_URL + '/rest/v1/';
    const url = new URL(request.url);

    /* ?search= — finding the customer to grant an account TO.
       Separate from the account list because it asks the opposite question:
       that one lists the few profiles that already have wholesale, this one
       searches the many that do not. Server-side rather than filtering a full
       customer download in the page, which is both slow and a copy of the
       customer table sitting in a browser tab. */
    const search = text(url.searchParams.get('search'), 120);
    if (search) {
      /* PostgREST `or=` takes a comma-separated list, so a comma in the search
         term would be read as a second condition. Dropped along with the
         wildcards and parens that would otherwise change the pattern. */
      const safeTerm = search.replace(/[,()*%\\]/g, ' ').trim();
      if (!safeTerm) return json({ ok: true, matches: [] }, 200, cors(env));
      const pattern = `*${safeTerm}*`;
      const rows = await fetch(
        `${base}profiles?select=id,email,full_name,wholesale`
        + `&or=(email.ilike.${encodeURIComponent(pattern)},full_name.ilike.${encodeURIComponent(pattern)})`
        + `&limit=20`,
        { headers: h, cache: 'no-store' },
      ).then((r) => (r.ok ? r.json() : [])).catch(() => []);
      return json({
        ok: true,
        matches: (Array.isArray(rows) ? rows : []).map((p) => ({
          id: p.id,
          email: p.email || '',
          name: p.full_name || '',
          /* So the page can say "already a wholesale account" instead of
             offering to create one that exists. */
          status: (p.wholesale && typeof p.wholesale === 'object' && p.wholesale.status) || '',
        })),
      }, 200, cors(env));
    }

    /* Only profiles that HAVE a wholesale object. Listing every customer and
       filtering in the browser would ship the whole customer table to the
       page to show the handful of rows that are wholesale accounts. */
    const rows = await fetch(
      `${base}profiles?select=id,email,full_name,wholesale,created_at&wholesale=not.is.null&order=created_at.desc&limit=500`,
      { headers: h, cache: 'no-store' },
    ).then((r) => (r.ok ? r.json() : [])).catch(() => []);

    const accounts = (Array.isArray(rows) ? rows : []).map((p) => {
      const w = p.wholesale && typeof p.wholesale === 'object' ? p.wholesale : {};
      return {
        id: p.id,
        email: p.email || '',
        name: p.full_name || '',
        status: String(w.status || ''),
        company: w.company || '',
        taxId: w.tax_id || '',
        /* TWO FIGURES, because they are two different questions and conflating
           them makes the form lie.

           `minOrderCents` is what is STORED, and it is what the edit box has to
           show — reading it back through the helper would hand an admin 0 for a
           minimum they had just typed, because wholesaleMinimumCents() answers
           only for approved accounts and returns 0 for an application.

           `enforcedCents` is what the cart will ACTUALLY refuse below, read
           through that same helper so the page cannot promise a minimum nobody
           applies. On an approved account they agree; on any other status the
           second is 0, and that is worth showing rather than hiding. */
        minOrderCents: Number.isFinite(Number(w.min_order_cents)) ? Math.max(0, Math.round(Number(w.min_order_cents))) : 0,
        enforcedCents: wholesaleMinimumCents(p),
        terms: w.terms || 'prepaid',
        notes: w.notes || '',
        resaleExempt: w.resale_exempt === true,
        approvedAt: w.approved_at || null,
        approvedBy: w.approved_by || '',
      };
    });

    return json({
      ok: true,
      accounts,
      list: await wholesaleList(env),
      statuses: STATUSES,
      terms: TERMS,
    }, 200, cors(env));
  } catch (e) {
    return json({ ok: false, error: e?.message || 'Could not read wholesale accounts.' }, 400, cors(env));
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const admin = await requireAdmin(request, env, 'pricing_write');
    const h = H(env);
    if (!h) return json({ ok: false, error: 'Not configured.' }, 503, cors(env));
    const base = env.SUPABASE_URL + '/rest/v1/';
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || 'save');
    const actor = admin?.profile?.email || admin?.email || '';

    /* Create the list an approved buyer needs. Idempotent on purpose: the page
       offers this whenever the list is missing, and pressing it twice must not
       leave two lists that both match — which would make the resolver's tie
       break decide the price. */
    if (action === 'ensure-list') {
      const existing = await wholesaleList(env);
      if (existing?.exists) return json({ ok: true, created: false, list: existing }, 200, cors(env));

      const res = await fetch(`${base}price_lists`, {
        method: 'POST',
        headers: { ...h, Prefer: 'return=representation' },
        body: JSON.stringify({
          code: 'wholesale',
          name: 'Wholesale',
          customer_group: 'wholesale',
          /* Above the default list, which ships at 0. A wholesale price that
             loses to the everyone-list is a wholesale price nobody is charged. */
          priority: 100,
          active: true,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return json({ ok: false, error: 'Could not create the wholesale price list. ' + detail.slice(0, 200) }, 502, cors(env));
      }
      return json({ ok: true, created: true, list: await wholesaleList(env) }, 200, cors(env));
    }

    /* The list's RULE — "trade is 40% off" instead of a row per product.
       Not put through propose → approve like a price row: a row is a decision
       about one product and each deserves its own signature, while this is one
       decision taken once, recorded in the audit log below. Sending it through
       the row workflow would mean approving a change to prices that do not
       exist yet, on products that do not exist yet. */
    if (action === 'set-rule') {
      const existing = await wholesaleList(env);
      const target = existing && existing.lists && existing.lists[0];
      if (!target) return json({ ok: false, error: 'Create the wholesale price list first.' }, 400, cors(env));

      const raw = body.percentOff;
      let pct = null;
      if (raw !== '' && raw !== null && raw !== undefined) {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0 || n >= 100) {
          return json({ ok: false, error: 'Give a discount between 0 and 100 percent, or leave it blank for none.' }, 400, cors(env));
        }
        pct = Math.round(n * 100) / 100;
      }

      const upd = await fetch(`${base}price_lists?id=eq.${encodeURIComponent(target.id)}`, {
        method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({ rule_percent_off: pct }),
      });
      if (!upd.ok) {
        const detail = await upd.text().catch(() => '');
        return json({ ok: false, error: 'Could not save that rule. ' + detail.slice(0, 200) }, 502, cors(env));
      }

      await fetch(`${base}admin_audit_log`, {
        method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({
          admin_user_id: admin?.id || null,
          admin_email: actor,
          action: 'wholesale.rule',
          resource_type: 'price_lists',
          resource_id: String(target.id),
          metadata: {
            percentOff: pct,
            was: target.rule_percent_off ?? null,
            summary: pct === null
              ? 'Wholesale percentage rule removed'
              : 'Wholesale priced at ' + pct + '% off the catalogue',
          },
        }),
      }).catch(() => {});

      return json({ ok: true, percentOff: pct, list: await wholesaleList(env) }, 200, cors(env));
    }

    const customerId = text(body.customerId, 64);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customerId)) {
      return json({ ok: false, error: 'Pick a customer first.' }, 400, cors(env));
    }

    /* Read the existing object before writing, for two reasons: the customer
       has to exist, and buildWholesale needs the original grant so an edit
       cannot quietly restamp who approved the account. */
    const found = await fetch(
      `${base}profiles?select=id,email,wholesale&id=eq.${encodeURIComponent(customerId)}&limit=1`,
      { headers: h, cache: 'no-store' },
    ).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const profile = Array.isArray(found) ? found[0] : null;
    if (!profile) return json({ ok: false, error: 'No such customer.' }, 404, cors(env));

    /* Revoke is a DELETE of the field, not status:'revoked'. The resolver reads
       "no object" as an ordinary customer, and a status string it does not know
       would read the same way while looking like a state somebody chose. One
       spelling for "not a wholesale account", and it is null. */
    const patch = action === 'revoke'
      ? { wholesale: null }
      : { wholesale: buildWholesale(body, profile.wholesale, actor) };

    if (action !== 'revoke' && !STATUSES.includes(String(body.status))) {
      return json({ ok: false, error: 'Pick a status: applied, approved or suspended.' }, 400, cors(env));
    }

    const upd = await fetch(`${base}profiles?id=eq.${encodeURIComponent(customerId)}`, {
      method: 'PATCH', headers: { ...h, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
    });
    if (!upd.ok) {
      const detail = await upd.text().catch(() => '');
      return json({ ok: false, error: 'Could not save that account. ' + detail.slice(0, 200) }, 502, cors(env));
    }

    /* The certificate follows the account. Only an APPROVED account with the
       box ticked holds a live exemption — revoking, suspending, or unticking
       all withdraw it, because each of those means this buyer is paying retail
       terms again and retail terms include the tax. */
    await syncExemption(env, {
      customerId,
      email: profile.email || '',
      exempt: action !== 'revoke'
        && String(body.status) === 'approved'
        && (body.resaleExempt === true || body.resaleExempt === 'true'),
      certificate: text(body.taxId, 60),
      company: text(body.company, 120),
      actorId: admin?.id || null,
    });

    /* Written server-side, in the same request, for the same reason the price
       register is: an admin who can grant a trade discount should not also be
       the one deciding whether the grant is recorded. */
    await fetch(`${base}admin_audit_log`, {
      method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
      /* The column names are admin_email / resource_type / resource_id /
         metadata — the shape logAdminAudit() in admin-main.js writes and the
         Audit Log page reads. A row written under invented names is rejected by
         the database, swallowed by the .catch() below, and the grant is made
         with no record of it: the one thing this write exists to prevent. */
      body: JSON.stringify({
        admin_user_id: admin?.id || null,
        admin_email: actor,
        action: action === 'revoke' ? 'wholesale.revoke' : 'wholesale.' + String(body.status),
        resource_type: 'profiles',
        resource_id: customerId,
        metadata: {
          email: profile.email || '',
          company: patch.wholesale?.company || '',
          minOrderCents: patch.wholesale?.min_order_cents ?? null,
          terms: patch.wholesale?.terms || '',
          summary: action === 'revoke'
            ? 'Wholesale account removed'
            : 'Wholesale account set to ' + String(body.status),
        },
      }),
    }).catch(() => {});

    return json({
      ok: true,
      account: patch.wholesale,
      /* Answered on every save, so approving somebody immediately surfaces the
         missing list rather than waiting for a confused "why is he paying full
         price" a week later. */
      list: await wholesaleList(env),
    }, 200, cors(env));
  } catch (e) {
    return json({ ok: false, error: e?.message || 'Could not change that account.' }, 400, cors(env));
  }
}

export function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}
