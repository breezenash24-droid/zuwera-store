/**
 * functions/api/_ship-from.js — where this store ships from.
 *
 * One address, wanted by four different things: the shipping label, the return
 * label, the rate quote, and the tax origin a provider needs to work out
 * whether a sale is interstate. It was named SHIPPO_FROM_* because Shippo
 * asked for it first, which made it look like a Shippo setting — so when the
 * tax adapters needed the same address they reached for a courier's variable,
 * and a store not using Shippo at all still had to fill in Shippo's fields.
 *
 * The names are now SHIP_FROM_*, which is what the thing actually is.
 *
 * SHIPPO_FROM_* keeps working, and is read whenever the new name is unset.
 * That is not politeness — a rename that requires every deployment to update
 * its environment before the next deploy is a rename that breaks label
 * purchasing for anyone who does it in the wrong order. Both names can coexist
 * indefinitely; the old ones can be deleted whenever it suits.
 */

import { resolveSetting } from './_settings.js';

export const SHIP_FROM_FIELDS = [
  'NAME', 'STREET1', 'STREET2', 'CITY', 'STATE', 'ZIP', 'COUNTRY', 'EMAIL', 'PHONE',
];

/**
 * Every name one field has ever had, most-preferred first.
 *
 * SHIP_FROM_, not FROM_: this set includes an email address, and the store
 * already has EMAIL_FROM — the address customer emails are SENT from. A
 * FROM_EMAIL sitting beside an EMAIL_FROM is the same six characters in a
 * different order meaning something entirely different, and someone would
 * eventually put the support address on a shipping label or the courier
 * contact on an order confirmation. SHIP_FROM_ says which one it is.
 *
 * FROM_* is read too, briefly, because it was published as the new name before
 * this was noticed. All three can coexist; SHIP_FROM_* is the one to use.
 */
export function shipFromKeys(field) {
  return ['SHIP_FROM_' + field, 'FROM_' + field, 'SHIPPO_FROM_' + field];
}

/**
 * One field of the origin address.
 *
 * `cache` is a settings bundle from fetchSiteSettings, so an address typed into
 * the admin panel wins over the environment. Callers with no cache get the
 * environment alone, which is what they had before.
 */
export function shipFromValue(field, env = {}, cache = {}, fallback = '') {
  let found = '';
  for (const key of shipFromKeys(field)) {
    found = resolveSetting(key, env, cache);
    if (found) break;
  }
  return String(found || fallback || '').trim();
}

/** The whole address, in the shape every caller was already building by hand. */
export function shipFrom(env = {}, cache = {}) {
  return {
    name:    shipFromValue('NAME',    env, cache, 'Zuwera'),
    street1: shipFromValue('STREET1', env, cache),
    street2: shipFromValue('STREET2', env, cache),
    city:    shipFromValue('CITY',    env, cache),
    state:   shipFromValue('STATE',   env, cache),
    zip:     shipFromValue('ZIP',     env, cache),
    country: shipFromValue('COUNTRY', env, cache, 'US'),
    email:   shipFromValue('EMAIL',   env, cache, 'orders@zuwera.store'),
    phone:   shipFromValue('PHONE',   env, cache),
  };
}

/**
 * Whether there is enough of an address to buy a label or price a rate.
 *
 * Street, city, state and ZIP — a missing country defaults to US and a missing
 * name defaults to the store, but none of those four can be guessed. Kept here
 * rather than in each caller so "incomplete" means the same thing to the rate
 * quote and to the label purchase; those disagreeing is how a checkout offers
 * a shipping price that then cannot be bought.
 */
export function shipFromIsComplete(address) {
  const a = address || {};
  return Boolean(a.street1 && a.city && a.state && a.zip);
}
