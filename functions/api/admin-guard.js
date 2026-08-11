/**
 * POST /api/admin-guard — ask the limits about an action the browser is about
 * to take itself.
 *
 * READ THIS BEFORE USING IT. This is ADVISORY. It answers the question and
 * changes nothing; the caller then goes and does the thing with its own
 * Supabase credentials. Somebody who skips the call skips the limit.
 *
 * That is not a flaw to be fixed here — it is the shape of the problem. A
 * limit can be made to truly bind only where the browser has no legitimate
 * reason to hold the permission, and then you take the permission away
 * (migration 0009 for deleting products, 0010 for granting roles). The actions
 * this serves are ones the panel must be able to do for ordinary work: the
 * product editor needs UPDATE on products, so a price limit cannot be sealed
 * without moving the entire editor server-side.
 *
 * So it is worth exactly what it is worth: it stops mistakes, it makes the
 * intended path refuse and say why, and it writes the refusal down. It does
 * not stop somebody determined with a console. The panel labels limits that
 * rely on this differently for that reason, and nothing here should be
 * described as enforcement.
 *
 * WHY ONE ENDPOINT AND NOT FIVE. These differ only in an action name and a
 * number. Five near-identical endpoints would be five places for the shape of
 * a ctx to drift from what the rules expect, which is the failure this whole
 * area keeps producing.
 */

import { cors, json, decide } from './_commerce.js';

/* Named, not open. An open action parameter lets a caller invent an action no
   rule mentions and be told yes — a check that passes because nothing matched,
   reported as a check that passed. The permission each maps to is the RBAC
   gate that must ALSO hold: the limits narrow, they never grant. */
const GUARDED = {
  product_price:  'products',
  bulk_edit:      'products',
  promo_create:   'commerce',
  loyalty_adjust: 'loyalty',
  order_edit:     'orders',
  customer_export: 'users',
};

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: cors(env) });
}

export async function onRequestPost({ request, env }) {
  const h = cors(env);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, 400, h); }

  const { accessToken, action, resource } = body || {};
  const permission = GUARDED[String(action || '')];
  if (!permission) return json({ error: 'Unknown action.' }, 400, h);

  /* The resource is whatever the caller says it is, and it has to be — the
     browser is the only thing that knows it is about to change a price by 40%.
     That is the honest limit of an advisory check and the reason this file
     says so at the top rather than in a commit message nobody will read. */
  const verdict = await decide(env, accessToken, permission, {
    action: String(action),
    resource: resource && typeof resource === 'object' ? resource : {},
  });

  return json({
    allow: !!verdict.allow,
    reason: verdict.reason || '',
    limited: !!verdict.limited,
    ownerMayOverride: !!verdict.ownerMayOverride,
    rule: verdict.rule || '',
  }, verdict.allow ? 200 : 403, h);
}
