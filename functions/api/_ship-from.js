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
 * The names are now FROM_*, which is what the thing actually is.
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

/** Both names for one field, new first. Used by the status pages to report which is set. */
export function shipFromKeys(field) {
  return ['FROM_' + field, 'SHIPPO_FROM_' + field];
}

/**
 * One field of the origin address.
 *
 * `cache` is a settings bundle from fetchSiteSettings, so an address typed into
 * the admin panel wins over the environment. Callers with no cache get the
 * environment alone, which is what they had before.
 */
export function shipFromValue(field, env = {}, cache = {}, fallback = '') {
  const [next, legacy] = shipFromKeys(field);
  const found = resolveSetting(next, env, cache) || resolveSetting(legacy, env, cache);
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
