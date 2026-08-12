/**
 * functions/api/_tax.js — who works out the sales tax.
 *
 * The built-in table (below) is what has always run: state rates, Ohio by
 * county via ZIP3, Illinois by ZIP3, flat KY/IN, plus whatever Admin → Tax
 * overrides. It is free and honest and wrong at the edges — it cannot know a
 * city district rate, or that clothing is exempt in PA/NJ/MN and exempt under
 * $110 in NY, which for a clothing store is the expensive part.
 *
 * So the table is now one engine among several rather than the only path. An
 * admin picks the engine on the Tax page; everything else here is about making
 * that choice safe:
 *
 *   • The default is 'builtin'. A store that never opens the setting behaves
 *     exactly as it did before this file existed.
 *   • Every external engine falls back to the table. A tax API that is slow,
 *     down, or misconfigured must never be able to stop a customer paying, so
 *     a failure is a fallback and a note in the metadata — not an error.
 *   • Every call is time-boxed. A checkout waiting on someone else's API is a
 *     checkout being abandoned.
 *   • Whatever answered is stamped on the order (tax_engine), so the compliance
 *     figures on the Tax page can be read for what they are. A number you
 *     cannot attribute is not much use at filing time.
 *
 * Keys live in Cloudflare env vars, never site_settings — they are secrets and
 * the admin never needs to see them again after pasting them.
 */

import { fetchSiteSettings } from './_settings.js';
import { shipFromValue } from './_ship-from.js';

/* How long a checkout will wait for someone else's tax API before giving up and
   using the table. Generous enough for a healthy provider, short enough that a
   sick one costs a customer a moment rather than the sale. */
const TAX_API_TIMEOUT_MS = 3000;

/* ── Why a fallback must not change the price ────────────────────────────────
   Falling back to the table keeps checkout alive when a provider is sick. That
   is right. But it silently changed the PRICE: the provider returned Hamilton
   County's 7.8% and the table returned the store's 7.0% override, so the same
   cart came to $48.80 or $48.48 depending on whether an API answered inside
   three seconds. Reloading the page was, in the customer's words, a gamble.

   A rate is not volatile — jurisdictions move them quarterly, not per request.
   So the last rate a provider gave for an address is a far better answer than
   the table when that provider is briefly unreachable: it is the SAME number
   the shopper saw a moment ago, and it is the correct one.

   Keyed by engine + jurisdiction, because two engines may legitimately disagree
   and a cached Ohio rate must never be served for Oregon. Module scope, so it
   lives as long as the isolate — good enough to make a reload stable, and it
   simply misses on a cold start rather than going wrong. */
const RATE_TTL_MS = 6 * 60 * 60 * 1000;   // 6h — far shorter than rates change
const rateCache = new Map();

function rateKey(engine, address) {
  const zip = String(address?.zip || '').replace(/\D/g, '').slice(0, 5);
  return engine + '|' + normalizeStateCode(address?.state) + '|' + zip;
}

function rememberRate(engine, address, rate) {
  if (!Number.isFinite(rate) || rate <= 0) return;
  rateCache.set(rateKey(engine, address), { rate, at: Date.now() });
}

function recallRate(engine, address) {
  const hit = rateCache.get(rateKey(engine, address));
  if (!hit || Date.now() - hit.at > RATE_TTL_MS) return null;
  return hit.rate;
}

export const TAX_ENGINES = ['builtin', 'taxjar', 'taxcloud', 'avalara', 'ziptax', 'stripe_tax', 'external', 'none'];

/* ── What a store sells, in nobody's vocabulary in particular ────────────────
   Every provider has its own code system for "this is clothing": Stripe writes
   txcd_30011000, TaxJar writes 20010, Avalara writes something else again. Tag
   products with a provider's codes and switching provider means re-tagging the
   catalogue — which is the thing that makes a tax provider hard to leave.

   So products carry a neutral category and each engine maps it to its own code
   on the way out. Switching from Stripe Tax to TaxJar is then a setting change
   and nothing else, which is the point.

   This matters most for a clothing store: clothing is exempt in PA, NJ and MN
   and exempt under $110 per garment in NY. A provider that is not told the
   goods are clothing charges full rate on all of it, and the exemption is most
   of why you would pay for a provider at all. */
export const TAX_CATEGORIES = {
  general:  'General goods',
  clothing: 'Clothing',
  footwear: 'Footwear',
  digital:  'Digital goods',
  exempt:   'Not taxable',
};

/* Deliberately EMPTY rather than pre-filled with codes I would be guessing at.
   A blank code means "send no code", and every provider then applies the
   default set in its own dashboard — which for Stripe Tax is a real setting
   (Tax → Default product tax code) and the right place for it to live.

   A wrong tax code is a compliance error that looks like a working checkout,
   so these are filled in from Admin → Tax against the provider's own published
   list, never inferred here. */
const DEFAULT_TAX_CODES = { stripe_tax: {}, taxjar: {}, taxcloud: {}, avalara: {} };

/** The provider's own code for one of our categories, or '' to send none. */
export function taxCodeFor(engine, category, config = {}) {
  const cat = String(category || 'general').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(TAX_CATEGORIES, cat)) return '';
  const configured = (config.taxCodes || {})[engine] || {};
  const shipped = DEFAULT_TAX_CODES[engine] || {};
  return String(configured[cat] ?? shipped[cat] ?? '');
}

/* Cart lines in the shape a provider wants, with the category resolved to that
   provider's code. Falls back to one lumped line when the caller has no item
   detail — the display path asking "what is the rate around here?" rather than
   pricing a real cart. A lump is a worse question: per-item rules like New
   York's $110 clothing threshold cannot be applied to it. */
function providerLines(engine, lineItems, taxableCents, config) {
  const items = Array.isArray(lineItems)
    ? lineItems.filter((i) => i && (Number(i.amountTotal) > 0 || Number(i.amount) > 0))
    : [];
  if (!items.length) {
    return [{
      amount: Math.max(0, Math.round(taxableCents)),
      quantity: 1,
      reference: 'cart',
      code: taxCodeFor(engine, config.defaultCategory, config),
    }];
  }
  return items.map((item, i) => ({
    /* Line TOTAL, not unit price: both providers want the extended amount.
       `amountTotal` wins when the caller has already worked it out — a cart
       with a promo on it has line totals that do not divide evenly by quantity,
       and re-deriving them here would not add back up to what is being charged. */
    amount: Math.max(0, Math.round(
      Number.isFinite(Number(item.amountTotal))
        ? Number(item.amountTotal)
        : Number(item.amount) * (Number(item.quantity) || 1),
    )),
    quantity: Number(item.quantity) || 1,
    reference: String(item.sku || item.name || ('line' + i)).slice(0, 60),
    code: taxCodeFor(engine, item.taxCategory || config.defaultCategory, config),
  }));
}

// ─── The built-in table ────────────────────────────────────────────────────
// Moved here from create-payment-intent so both the engine layer and the
// payment path read one copy. Behaviour is unchanged.

const US_STATE_NAME_TO_CODE = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
  COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA',
  HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA',
  KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD',
  MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO',
  MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ',
  'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND',
  OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT',
  VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI',
  WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC',
};

const DEFAULT_US_STATE_TAX_RATES = {
  AL: 0.04, AK: 0, AZ: 0.056, AR: 0.065, CA: 0.0725,
  CO: 0.029, CT: 0.0635, DE: 0, FL: 0.06, GA: 0.04,
  HI: 0.04, ID: 0.06, IL: 0.0625, IN: 0.07, IA: 0.06,
  KS: 0.065, KY: 0.06, LA: 0.05, ME: 0.055, MD: 0.06,
  MA: 0.0625, MI: 0.06, MN: 0.06875, MS: 0.07, MO: 0.04225,
  MT: 0, NE: 0.055, NV: 0.0685, NH: 0, NJ: 0.06625,
  NM: 0.05125, NY: 0.04, NC: 0.0475, ND: 0.05, OH: 0.0575,
  OK: 0.045, OR: 0, PA: 0.06, RI: 0.07, SC: 0.06,
  SD: 0.042, TN: 0.07, TX: 0.0625, UT: 0.061, VT: 0.06,
  VA: 0.053, WA: 0.065, WV: 0.06, WI: 0.05, WY: 0.04,
  DC: 0.06,
};

// Ohio county combined rates (state 5.75% + county levy)
const OH_COUNTY_RATES = {
  Adams:0.0725,Allen:0.0675,Ashland:0.07,Ashtabula:0.07,Athens:0.07,
  Auglaize:0.0725,Belmont:0.0725,Brown:0.0725,Butler:0.07,Carroll:0.0725,
  Champaign:0.0725,Clark:0.0725,Clermont:0.07,Clinton:0.0725,Columbiana:0.0725,
  Coshocton:0.0725,Crawford:0.0725,Cuyahoga:0.08,Darke:0.0725,Defiance:0.0725,
  Delaware:0.07,Erie:0.0675,Fairfield:0.0675,Fayette:0.0725,Franklin:0.075,
  Fulton:0.0725,Gallia:0.0725,Geauga:0.07,Greene:0.0675,Guernsey:0.0725,
  Hamilton:0.07,Hancock:0.0675,Hardin:0.0725,Harrison:0.0725,Henry:0.0725,
  Highland:0.0725,Hocking:0.0725,Holmes:0.0725,Huron:0.0725,Jackson:0.0725,
  Jefferson:0.0725,Knox:0.0725,Lake:0.0725,Lawrence:0.0725,Licking:0.0725,
  Logan:0.0725,Lorain:0.065,Lucas:0.0725,Madison:0.07,Mahoning:0.0725,
  Marion:0.0725,Medina:0.0675,Meigs:0.0725,Mercer:0.0725,Miami:0.0675,
  Monroe:0.0725,Montgomery:0.075,Morgan:0.0725,Morrow:0.0725,Muskingum:0.0725,
  Noble:0.0725,Ottawa:0.07,Paulding:0.0725,Perry:0.0725,Pickaway:0.0725,
  Pike:0.0725,Portage:0.0725,Preble:0.07,Putnam:0.0725,Richland:0.0725,
  Ross:0.0725,Sandusky:0.0725,Scioto:0.0725,Seneca:0.0725,Shelby:0.0725,
  Stark:0.065,Summit:0.0675,Trumbull:0.0725,Tuscarawas:0.0725,Union:0.07,
  VanWert:0.0725,Vinton:0.0725,Warren:0.0675,Washington:0.0725,Wayne:0.0675,
  Williams:0.0725,Wood:0.0675,Wyandot:0.0725,
};

const OH_ZIP3_TO_COUNTY = {
  '430':'Franklin','431':'Franklin','432':'Franklin','433':'Marion','434':'Wood',
  '435':'Defiance','436':'Lucas','437':'Muskingum','438':'Coshocton',
  '440':'Lorain','441':'Cuyahoga','442':'Summit','443':'Summit',
  '444':'Mahoning','445':'Mahoning','446':'Stark','447':'Stark','448':'Stark',
  '449':'Richland',
  '450':'Hamilton','451':'Clermont','452':'Hamilton','453':'Miami','454':'Montgomery',
  '455':'Clark','456':'Ross','457':'Athens','458':'Allen','459':'Allen',
};

const IL_ZIP3_RATES = {
  '600':0.0825,'601':0.0725,'602':0.0725,'603':0.07,'604':0.0825,'605':0.0725,
  '606':0.1025,'607':0.1025,'608':0.0825,'609':0.075,
  '610':0.0825,'611':0.08,'612':0.0825,'613':0.0625,'614':0.085,'615':0.085,
  '616':0.0825,'617':0.0625,'618':0.0725,'619':0.0725,
  '620':0.0835,'621':0.0725,'622':0.0625,'623':0.085,'624':0.085,'625':0.09,
  '626':0.085,'627':0.085,'628':0.0625,'629':0.0725,
};

function normalizeRate(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed > 1 ? parsed / 100 : parsed;
}

export function normalizeStateCode(value) {
  if (!value) return '';
  const upper = String(value).trim().toUpperCase().replace(/\./g, '');
  if (upper.length === 2) return upper;
  return US_STATE_NAME_TO_CODE[upper] || '';
}

function parseConfiguredStateRates(rawValue) {
  const parsed = {};
  const raw = String(rawValue || '').trim();
  if (!raw) return parsed;

  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw);
      Object.entries(obj || {}).forEach(([key, value]) => {
        const state = normalizeStateCode(key);
        const rate = normalizeRate(value);
        if (state && rate !== null) parsed[state] = rate;
      });
      return parsed;
    } catch (_) {}
  }

  raw.split(',').forEach((entry) => {
    const [keyPart, valuePart] = entry.split(/[:=]/);
    const state = normalizeStateCode(keyPart);
    const rate = normalizeRate(valuePart);
    if (state && rate !== null) parsed[state] = rate;
  });

  return parsed;
}

function detectUsStateFromRequest(request) {
  const country = String(request?.cf?.country || request?.headers?.get('CF-IPCountry') || 'US').trim().toUpperCase();
  if (country !== 'US') return '';
  const candidates = [
    request?.cf?.regionCode,
    request?.cf?.region,
    request?.headers?.get('CF-Region-Code'),
    request?.headers?.get('CF-Region'),
  ];
  for (const candidate of candidates) {
    const normalized = normalizeStateCode(candidate);
    if (normalized) return normalized;
  }
  return '';
}

/**
 * The built-in table after every layer of override has been applied: the
 * shipped defaults, then Cloudflare env vars, then Admin → Tax.
 *
 * Extracted so the merge exists once. It used to happen inline in the function
 * below, which meant anything else wanting to know a rate — the admin page, the
 * checkout summary — had no way to ask and grew its own copy of the numbers
 * instead. Three copies of a tax table is three answers to one question.
 */
export function effectiveTables(env = {}, dbOverrides = {}) {
  const configuredRates = parseConfiguredStateRates(env.STATE_TAX_RATES || env.SALES_TAX_BY_STATE || env.TAX_RATES_BY_STATE);
  return {
    stateRates: { ...DEFAULT_US_STATE_TAX_RATES, ...configuredRates, ...(dbOverrides.stateRates || {}) },
    ohCounty:   { ...OH_COUNTY_RATES, ...(dbOverrides.ohCountyRates || {}) },
    ohZip3:     { ...OH_ZIP3_TO_COUNTY },
    ilZip3:     { ...IL_ZIP3_RATES,   ...(dbOverrides.ilZip3Rates   || {}) },
    flat:       { KY: 0.06, IN: 0.07, ...(dbOverrides.flatRates     || {}) },
    fallback:   normalizeRate(env.DEFAULT_SALES_TAX_RATE) ?? 0,
  };
}

/** Admin → Tax's saved overrides. Callers that do not pass their own get these. */
export async function loadTaxOverrides(env) {
  try {
    const settings = await fetchSiteSettings(['tax_rate_overrides'], env);
    const v = settings.tax_rate_overrides;
    return (v && typeof v === 'object') ? v : JSON.parse(v || '{}');
  } catch (_) { return {}; }
}

/** The built-in table's answer. Unchanged from where it used to live. */
export function getTaxRateForAddress(address, env, request, dbOverrides = {}) {
  const country = String(address?.country || 'US').trim().toUpperCase();
  if (country !== 'US') return { stateCode: '', taxRate: 0 };
  const stateCode = normalizeStateCode(address?.state) || detectUsStateFromRequest(request);
  const t = effectiveTables(env, dbOverrides);

  if (!stateCode) return { stateCode: '', taxRate: t.fallback };

  // KY/IN: flat statewide rates, no county add-ons
  if (t.flat[stateCode] !== undefined) return { stateCode, taxRate: t.flat[stateCode] };

  const zip = String(address?.zip || address?.postal_code || '').replace(/\D/g, '');

  // Ohio: county-level lookup via ZIP3 prefix
  if (stateCode === 'OH' && zip.length >= 3) {
    const county = t.ohZip3[zip.slice(0, 3)];
    const taxRate = (county && t.ohCounty[county]) ? t.ohCounty[county] : (t.stateRates.OH || 0.0725);
    return { stateCode, taxRate };
  }

  // Illinois: ZIP3-level lookup
  if (stateCode === 'IL' && zip.length >= 3) {
    const taxRate = t.ilZip3[zip.slice(0, 3)] ?? (t.stateRates.IL || 0.0625);
    return { stateCode, taxRate };
  }

  const taxRate = t.stateRates[stateCode] ?? t.fallback;
  return { stateCode, taxRate };
}

// ─── Engine configuration ──────────────────────────────────────────────────

/** site_settings.tax_engine, with every field defaulted. */
export async function getTaxEngineConfig(env) {
  let raw = {};
  try {
    const settings = await fetchSiteSettings(['tax_engine'], env);
    const v = settings.tax_engine;
    raw = (v && typeof v === 'object') ? v : JSON.parse(v || '{}');
  } catch (_) { raw = {}; }

  const engine = TAX_ENGINES.indexOf(raw.engine) !== -1 ? raw.engine : 'builtin';
  return {
    engine,
    // Whether a failed external call falls back to the table. On by default:
    // a store that picked TaxJar still wants to take the order when TaxJar is
    // having an afternoon. Turn it off only if collecting a slightly wrong
    // amount is worse for you than collecting an approximate one.
    fallback: raw.fallback !== false,
    endpoint: String(raw.endpoint || ''),   // 'external' engine only

    /* What this store sells, when a product does not say for itself. A clothing
       store sets this once and every line is priced as clothing. */
    defaultCategory: Object.prototype.hasOwnProperty.call(TAX_CATEGORIES, raw.defaultCategory)
      ? raw.defaultCategory : 'general',

    /* { stripe_tax: { clothing: 'txcd_…' }, taxjar: { clothing: '20010' } } —
       each provider's own codes for our neutral categories. Blank sends none. */
    taxCodes: (raw.taxCodes && typeof raw.taxCodes === 'object') ? raw.taxCodes : {},

    /* Whether a completed sale is reported back to the provider for filing.
       On by default: a provider that priced the order and never heard it
       completed bills you for the calculation and has nothing to file from. */
    reportSales: raw.reportSales !== false,

    /* Avalara's company code — one AvaTax account can hold several. */
    companyCode: String(raw.companyCode || ''),

    /* A second engine, priced alongside the live one and charged from never.
       Choosing between the table and a paid provider is otherwise a guess;
       this makes it a measurement taken on real orders. Off unless named. */
    shadowEngine: TAX_ENGINES.indexOf(raw.shadowEngine) !== -1 ? raw.shadowEngine : '',
  };
}

/* ── Customers who do not pay tax ────────────────────────────────────────────
   A reseller holding a valid certificate must not be charged. Resolved here
   rather than in the checkout so that every payment route gets it without
   having to remember — the same reason the engine lives here at all.

   Deliberately strict about what counts: revoked or expired is not exempt, and
   a certificate for the wrong state is not exempt either. An exemption is the
   one setting that makes tax vanish, so it fails closed. */
export async function findExemption({ env, email, userId, stateCode }) {
  const url = (env.SUPABASE_URL || '').trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !key || (!email && !userId)) return null;

  const filters = [];
  if (userId) filters.push('user_id.eq.' + encodeURIComponent(userId));
  if (email) filters.push('email.ilike.' + encodeURIComponent(String(email).trim()));
  if (!filters.length) return null;

  try {
    const resp = await fetch(
      url + '/rest/v1/tax_exemptions?or=(' + filters.join(',') + ')&revoked_at=is.null&select=*',
      { headers: { apikey: key, Authorization: 'Bearer ' + key } },
    );
    if (!resp.ok) return null;
    const rows = await resp.json();
    const now = Date.now();
    const state = normalizeStateCode(stateCode);
    return (Array.isArray(rows) ? rows : []).find((r) => {
      if (r.expires_at && new Date(r.expires_at).getTime() < now) return false;
      const states = Array.isArray(r.states) ? r.states.filter(Boolean) : [];
      /* No states listed means the certificate covers everywhere. */
      return !states.length || states.map(normalizeStateCode).includes(state);
    }) || null;
  } catch (_) {
    /* Unreadable means NOT exempt. Failing open here would hand a tax holiday
       to everyone the moment the database hiccuped. */
    return null;
  }
}

// ─── Provider adapters ─────────────────────────────────────────────────────
// Each returns { taxCents, rate, note } or throws. Never returns a partial
// answer: a provider that cannot price this address must throw so the caller
// can fall back rather than quietly charge zero.

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' timed out')), ms)),
  ]);
}

async function fromTaxJar({ env, config, address, taxableCents, shippingCents, lineItems }) {
  const key = env.TAXJAR_API_KEY;
  if (!key) throw new Error('TAXJAR_API_KEY not set');
  const lines = providerLines('taxjar', lineItems, taxableCents, config);
  const resp = await withTimeout(fetch('https://api.taxjar.com/v2/taxes', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from_country: 'US',
      from_zip: shipFromValue('ZIP', env),
      from_state: shipFromValue('STATE', env),
      to_country: address.country || 'US',
      to_zip: address.zip || '',
      to_state: normalizeStateCode(address.state),
      to_city: address.city || '',
      to_street: address.line1 || '',
      amount: taxableCents / 100,
      shipping: (shippingCents || 0) / 100,
      /* Per line, so a clothing exemption applies to the garments and not to
         the whole cart. Sending only `amount` gets everything taxed alike. */
      line_items: lines.map((l, i) => ({
        id: String(i + 1),
        quantity: l.quantity,
        unit_price: (l.amount / l.quantity) / 100,
        ...(l.code ? { product_tax_code: l.code } : {}),
      })),
    }),
  }), TAX_API_TIMEOUT_MS, 'TaxJar');
  if (!resp.ok) throw new Error('TaxJar ' + resp.status);
  const data = await resp.json();
  const amount = Number(data?.tax?.amount_to_collect);
  if (!Number.isFinite(amount)) throw new Error('TaxJar returned no amount');
  return { taxCents: Math.round(amount * 100), rate: Number(data?.tax?.rate) || 0, note: 'taxjar' };
}

async function fromZipTax({ env, address, taxableCents }) {
  const key = env.ZIPTAX_API_KEY;
  if (!key) throw new Error('ZIPTAX_API_KEY not set');
  const zip = String(address.zip || '').replace(/\D/g, '').slice(0, 5);
  if (!zip) throw new Error('Zip-Tax needs a ZIP');
  const url = `https://api.zip-tax.com/request/v50?key=${encodeURIComponent(key)}&postalcode=${encodeURIComponent(zip)}`;
  const resp = await withTimeout(fetch(url), TAX_API_TIMEOUT_MS, 'Zip-Tax');
  if (!resp.ok) throw new Error('Zip-Tax ' + resp.status);
  const data = await resp.json();
  const rate = Number(data?.results?.[0]?.taxSales);
  if (!Number.isFinite(rate)) throw new Error('Zip-Tax returned no rate');
  return { taxCents: Math.round(taxableCents * rate), rate, note: 'ziptax' };
}

async function fromStripeTax({ env, config, address, taxableCents, shippingCents, lineItems }) {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not set');
  // Tax Calculations API. Form-encoded, like the rest of Stripe.
  const body = new URLSearchParams({
    currency: 'usd',
    'customer_details[address][country]': address.country || 'US',
    'customer_details[address][postal_code]': address.zip || '',
    'customer_details[address][state]': normalizeStateCode(address.state),
    'customer_details[address][city]': address.city || '',
    'customer_details[address][line1]': address.line1 || '',
    'customer_details[address_source]': 'shipping',
  });

  /* Real lines rather than one lump. New York exempts clothing under $110 PER
     GARMENT — a single $240 line is over the threshold and a cart of three $80
     shirts is not, and only one of those is the truth. */
  providerLines('stripe_tax', lineItems, taxableCents, config).forEach((l, i) => {
    body.set(`line_items[${i}][amount]`, String(l.amount));
    body.set(`line_items[${i}][quantity]`, String(l.quantity));
    body.set(`line_items[${i}][reference]`, l.reference);
    if (l.code) body.set(`line_items[${i}][tax_code]`, l.code);
  });

  /* Shipping is taxable in a good many states and was not being declared at
     all, so those orders under-collected on the postage. */
  if (shippingCents > 0) body.set('shipping_cost[amount]', String(Math.round(shippingCents)));

  const resp = await withTimeout(fetch('https://api.stripe.com/v1/tax/calculations', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }), TAX_API_TIMEOUT_MS, 'Stripe Tax');
  if (!resp.ok) throw new Error('Stripe Tax ' + resp.status);
  const data = await resp.json();
  const amount = Number(data?.tax_amount_exclusive);
  if (!Number.isFinite(amount)) throw new Error('Stripe Tax returned no amount');
  return {
    taxCents: Math.round(amount),
    rate: taxableCents > 0 ? amount / taxableCents : 0,
    note: 'stripe_tax',
    /* The calculation's id. Stripe will only file a sale you report back to it,
       and reporting is done by referring to this calculation — so it has to
       survive as far as the webhook that sees the payment succeed. */
    ref: String(data?.id || ''),
  };
}

/* Anything else — Avalara, Sovos, an accountant's own service, a spreadsheet
   behind a Worker. Point it at an endpoint and it gets the address and the
   taxable amount; it answers with cents, or a rate, or TaxJar's field name,
   whichever is easiest to produce. Absorbing an existing integration should not
   require this repo to know that provider's SDK. */
async function fromExternal({ env, config, address, taxableCents, shippingCents }) {
  const endpoint = config.endpoint || env.TAX_API_ENDPOINT || '';
  if (!endpoint) throw new Error('No external tax endpoint configured');
  const headers = { 'Content-Type': 'application/json' };
  if (env.TAX_API_KEY) headers.Authorization = 'Bearer ' + env.TAX_API_KEY;
  const resp = await withTimeout(fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      currency: 'usd',
      taxableCents,
      shippingCents: shippingCents || 0,
      address: {
        line1: address.line1 || '', city: address.city || '',
        state: normalizeStateCode(address.state), zip: address.zip || '',
        country: address.country || 'US',
      },
    }),
  }), TAX_API_TIMEOUT_MS, 'Tax endpoint');
  if (!resp.ok) throw new Error('Tax endpoint ' + resp.status);
  const data = await resp.json();

  // Cents first, then dollars, then a rate — in that order, because a provider
  // that gives cents is unambiguous and a rate needs multiplying.
  if (Number.isFinite(Number(data?.taxCents))) {
    return { taxCents: Math.round(Number(data.taxCents)), rate: Number(data.rate) || 0, note: 'external' };
  }
  const dollars = Number(data?.taxAmount ?? data?.amount_to_collect ?? data?.tax?.amount_to_collect);
  if (Number.isFinite(dollars)) {
    return { taxCents: Math.round(dollars * 100), rate: Number(data.rate) || 0, note: 'external' };
  }
  const rate = Number(data?.rate ?? data?.taxSales ?? data?.results?.[0]?.taxSales);
  if (Number.isFinite(rate)) {
    return { taxCents: Math.round(taxableCents * rate), rate, note: 'external' };
  }
  throw new Error('Tax endpoint returned nothing usable');
}

/* ── TaxCloud ────────────────────────────────────────────────────────────────
   The cheap rung between the built-in table and paying a percentage of every
   order. Its Lookup/AuthorizedWithCapture/Returned trio maps exactly onto
   quote/record/reverse, which is why it fits here without special cases.

   Needs the origin address, so it reads the same SHIP_FROM_* the labels use. */
function tcAddress(a) {
  return {
    Address1: a.line1 || a.street1 || '',
    City: a.city || '',
    State: normalizeStateCode(a.state) || '',
    Zip5: String(a.zip || '').replace(/\D/g, '').slice(0, 5),
  };
}

function tcOrigin(env) {
  return {
    Address1: shipFromValue('STREET1', env),
    City: shipFromValue('CITY', env),
    State: normalizeStateCode(shipFromValue('STATE', env)),
    Zip5: shipFromValue('ZIP', env),
  };
}

async function fromTaxCloud({ env, config, address, taxableCents, shippingCents, lineItems }) {
  const loginId = env.TAXCLOUD_API_LOGIN_ID;
  const key = env.TAXCLOUD_API_KEY;
  if (!loginId || !key) throw new Error('TAXCLOUD_API_LOGIN_ID / TAXCLOUD_API_KEY not set');

  const lines = providerLines('taxcloud', lineItems, taxableCents, config);
  const resp = await withTimeout(fetch('https://api.taxcloud.net/1.0/TaxCloud/Lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiLoginID: loginId,
      apiKey: key,
      customerID: 'guest',
      /* A quote is not an order. cartID is left for TaxCloud to assign here and
         only pinned when the sale is actually recorded. */
      cartID: '',
      cartItems: lines.map((l, i) => ({
        Index: i,
        ItemID: l.reference,
        /* Taxability Information Code — TaxCloud's name for a product
           category. Blank means "let the account default decide", same rule as
           every other provider here. */
        ...(l.code ? { TIC: Number(l.code) || 0 } : {}),
        Price: l.amount / 100 / (l.quantity || 1),
        Qty: l.quantity || 1,
      })),
      origin: tcOrigin(env),
      destination: tcAddress(address),
      deliveredBySeller: false,
    }),
  }), TAX_API_TIMEOUT_MS, 'TaxCloud');
  if (!resp.ok) throw new Error('TaxCloud ' + resp.status);
  const data = await resp.json();
  const rows = data && data.CartItemsResponse;
  if (!Array.isArray(rows)) throw new Error('TaxCloud returned no cart response');
  const dollars = rows.reduce((n, r) => n + (Number(r.TaxAmount) || 0), 0);
  if (!Number.isFinite(dollars)) throw new Error('TaxCloud returned no amount');
  return {
    taxCents: Math.round(dollars * 100),
    rate: taxableCents > 0 ? (dollars * 100) / taxableCents : 0,
    note: 'taxcloud',
    ref: String(data.CartID || ''),
  };
}

/* ── Avalara AvaTax ──────────────────────────────────────────────────────────
   The one an accountant eventually names. Its own model happens to match this
   file's: a SalesOrder is a quote and changes nothing, a committed SalesInvoice
   is the recorded sale. So quote and record are the same endpoint with two
   different document types rather than two integrations. */
function avaAuth(env) {
  const id = env.AVALARA_ACCOUNT_ID;
  const key = env.AVALARA_LICENSE_KEY;
  if (!id || !key) throw new Error('AVALARA_ACCOUNT_ID / AVALARA_LICENSE_KEY not set');
  return 'Basic ' + btoa(id + ':' + key);
}

function avaBase(env) {
  /* Sandbox until told otherwise. Pointing a first integration at production
     and discovering it there is the wrong order to find things out in. */
  return String(env.AVALARA_ENV || '').toLowerCase() === 'production'
    ? 'https://rest.avatax.com'
    : 'https://sandbox.rest.avatax.com';
}

function avaAddress(a) {
  return {
    line1: a.line1 || a.street1 || '',
    city: a.city || '',
    region: normalizeStateCode(a.state) || '',
    postalCode: a.zip || '',
    country: a.country || 'US',
  };
}

function avaDocument({ env, config, address, taxableCents, shippingCents, lineItems, type, code, commit }) {
  const lines = providerLines('avalara', lineItems, taxableCents, config).map((l, i) => ({
    number: String(i + 1),
    quantity: l.quantity,
    amount: l.amount / 100,
    ...(l.code ? { taxCode: l.code } : {}),
    description: l.reference,
  }));
  if (shippingCents > 0) {
    /* Avalara's own shipping code, so freight is treated as freight in states
       that tax it differently from goods. */
    lines.push({ number: 'FREIGHT', quantity: 1, amount: shippingCents / 100, taxCode: 'FR020100', description: 'Shipping' });
  }
  return {
    type,
    companyCode: config.companyCode || env.AVALARA_COMPANY_CODE || 'DEFAULT',
    date: new Date().toISOString().slice(0, 10),
    customerCode: 'guest',
    currencyCode: 'USD',
    addresses: { shipFrom: avaAddress({
      line1: shipFromValue('STREET1', env), city: shipFromValue('CITY', env),
      state: shipFromValue('STATE', env), zip: shipFromValue('ZIP', env),
      country: shipFromValue('COUNTRY', env) || 'US',
    }), shipTo: avaAddress(address) },
    lines,
    commit: Boolean(commit),
    ...(code ? { code } : {}),
  };
}

async function fromAvalara({ env, config, address, taxableCents, shippingCents, lineItems }) {
  const auth = avaAuth(env);
  const resp = await withTimeout(fetch(avaBase(env) + '/api/v2/transactions/create', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    /* SalesOrder, not SalesInvoice: a quote must not appear in the filing
       ledger. The sale is recorded separately when it completes. */
    body: JSON.stringify(avaDocument({
      env, config, address, taxableCents, shippingCents, lineItems,
      type: 'SalesOrder', commit: false,
    })),
  }), TAX_API_TIMEOUT_MS, 'Avalara');
  if (!resp.ok) throw new Error('Avalara ' + resp.status);
  const data = await resp.json();
  const total = Number(data && data.totalTax);
  if (!Number.isFinite(total)) throw new Error('Avalara returned no totalTax');
  return {
    taxCents: Math.round(total * 100),
    rate: taxableCents > 0 ? (total * 100) / taxableCents : 0,
    note: 'avalara',
  };
}

const ADAPTERS = {
  taxjar: fromTaxJar,
  taxcloud: fromTaxCloud,
  avalara: fromAvalara,
  ziptax: fromZipTax,
  stripe_tax: fromStripeTax,
  external: fromExternal,
};

// ─── The one call the payment path makes ───────────────────────────────────

/**
 * Work out the tax for an order.
 *
 * Always resolves — never throws — because the alternative is a customer who
 * cannot check out because someone else's API is down. The `engine` it reports
 * is the one that actually produced the number, which is not always the one
 * that was configured, and that difference is the thing worth recording.
 */
async function resolveTaxInner({
  env, request, address, taxableCents, shippingCents = 0,
  dbOverrides = null, lineItems = null,
  /* Who is buying, so a held exemption certificate can be honoured. */
  customer = null,
  /* The Worker's waitUntil. Shadow mode uses it to price the order a second
     time AFTER the response has gone out — a comparison the customer waits for
     is a comparison that costs you the sale. Without it, shadow mode simply
     does not run rather than adding latency to a checkout. */
  waitUntil = null,
  /* Set when resolveTax is being called BY shadow mode, so the shadow run
     cannot start a shadow run of its own. */
  _shadowOf = null,
  /* Shadow mode prices with a different engine than the one configured. An
     explicit argument rather than a flag smuggled through env, so it is
     obvious in a stack trace which engine answered and why. */
  forceEngine = null,
}) {
  const base = await getTaxEngineConfig(env);
  const config = forceEngine ? { ...base, engine: forceEngine } : base;

  /* An exemption short-circuits everything, including the provider call: there
     is nothing to ask when the answer is zero by law, and asking would bill for
     a calculation that cannot change the outcome. */
  if (!_shadowOf && (customer?.email || customer?.userId)) {
    const exemption = await findExemption({
      env, email: customer.email, userId: customer.userId,
      stateCode: address?.state,
    });
    if (exemption) {
      return {
        taxCents: 0, rate: 0,
        stateCode: normalizeStateCode(address?.state),
        engine: config.engine,
        exempt: true,
        /* Stamped onto the order so a zero can be explained at filing time.
           An untraceable zero is indistinguishable from a bug. */
        exemptionId: String(exemption.id || ''),
        exemptionCertificate: String(exemption.certificate || ''),
      };
    }
  }
  /* A caller that did not bring the admin's overrides gets them read here rather
     than quietly pricing without them. The payment path passes its own (it is
     already reading settings for other reasons); anything else — the checkout
     summary's quote, say — would otherwise have to remember, and forgetting
     looks exactly like the drift this whole file exists to stop. */
  const overrides = dbOverrides || await loadTaxOverrides(env);
  const builtin = () => {
    const { stateCode, taxRate } = getTaxRateForAddress(address, env, request, overrides);
    return {
      taxCents: taxableCents > 0 ? Math.round(taxableCents * taxRate) : 0,
      rate: taxRate,
      stateCode,
      engine: 'builtin',
    };
  };

  // Shelved: something outside this checkout handles tax entirely. Charging
  // nothing here is a deliberate, and consequential, choice — the admin is
  // warned in as many words before they can pick it.
  if (config.engine === 'none') {
    return { taxCents: 0, rate: 0, stateCode: normalizeStateCode(address?.state), engine: 'none' };
  }

  if (config.engine === 'builtin') return builtin();

  const adapter = ADAPTERS[config.engine];
  if (!adapter) return { ...builtin(), engine: 'builtin', fallbackFrom: config.engine, note: 'no adapter' };

  try {
    const out = await adapter({ env, config, address, taxableCents, shippingCents, lineItems });
    const rate = out.rate || (taxableCents > 0 ? out.taxCents / taxableCents : 0);
    rememberRate(config.engine, address, rate);
    return {
      taxCents: Math.max(0, out.taxCents),
      rate,
      stateCode: normalizeStateCode(address?.state),
      engine: config.engine,
      /* The provider's handle on this calculation, for reporting the sale once
         it completes. Empty for engines with nothing to report to. */
      ref: out.ref || '',
    };
  } catch (err) {
    console.error('[tax] ' + config.engine + ' failed:', err.message);

    /* Before the table: the last rate this provider gave for this address.
       A three-second blip must not reprice the cart. Same jurisdiction, same
       engine, hours old at most — it is the number the shopper was already
       quoted, and it is more accurate than the state-level table. */
    const cached = recallRate(config.engine, address);
    if (cached != null && config.fallback) {
      console.warn('[tax] using last known ' + config.engine + ' rate for this address (' + cached + ')');
      return {
        taxCents: taxableCents > 0 ? Math.round(taxableCents * cached) : 0,
        rate: cached,
        stateCode: normalizeStateCode(address?.state),
        engine: config.engine,
        fallbackFrom: config.engine,
        cached: true,
      };
    }

    if (!config.fallback) {
      // Explicitly told not to guess. Zero is wrong, but it is wrong in a way
      // that shows up in the Tax page rather than silently mispricing.
      return {
        taxCents: 0, rate: 0, stateCode: normalizeStateCode(address?.state),
        engine: config.engine, failed: true,
      };
    }
    return { ...builtin(), fallbackFrom: config.engine, failed: true };
  }
}

/* ── Shadow mode ─────────────────────────────────────────────────────────────
   Price the order a second time with a different engine, charge from neither
   but the live one, and record what the other would have said.

   Choosing between the free table and a paid provider is otherwise a guess:
   nobody knows how far the table is off until a customer or a state says so.
   This answers it with the store's own orders, at the cost of one extra API
   call per order and no risk at all — the shadow figure never reaches a price.

   Three rules it must not break:
     • It runs AFTER the response. A comparison the customer waits for is a
       comparison that costs you the sale, so without a waitUntil it does not
       run at all rather than adding latency.
     • It can never throw into the caller. The live answer has already been
       given; a failure here is a missing log row, nothing more.
     • Its own failures are recorded, because "the shadow engine errored on
       every order" is exactly the sort of finding worth having before you
       switch to it. */
async function logShadow(env, row) {
  const url = (env.SUPABASE_URL || '').trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !key) return;
  try {
    await fetch(url + '/rest/v1/tax_shadow_log', {
      method: 'POST',
      headers: {
        apikey: key, Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });
  } catch (_) { /* a lost comparison is not worth an error path */ }
}

export async function resolveTax(args) {
  const live = await resolveTaxInner(args);
  const { env, address, taxableCents, waitUntil, _shadowOf, customer } = args || {};

  if (_shadowOf || typeof waitUntil !== 'function') return live;

  let config;
  try { config = await getTaxEngineConfig(env); } catch (_) { return live; }
  const shadow = config.shadowEngine;
  /* Comparing an engine with itself is a request that can only ever agree. */
  if (!shadow || shadow === (live.engine || config.engine)) return live;

  waitUntil((async () => {
    let shadowCents = null, error = null;
    try {
      const out = await resolveTaxInner({
        ...args,
        /* Same cart, same address, different engine — and marked as a shadow
           run so it cannot recurse or spend another exemption lookup. */
        forceEngine: shadow,
        customer: null,
        _shadowOf: live.engine || 'live',
      });
      shadowCents = out.taxCents;
    } catch (e) { error = (e && e.message) || String(e); }

    await logShadow(env, {
      order_number: (args.orderNumber || null),
      state: normalizeStateCode(address?.state) || null,
      zip: String(address?.zip || '').replace(/\D/g, '').slice(0, 5) || null,
      taxable_cents: Math.round(taxableCents || 0),
      live_engine: live.engine || null,
      live_cents: Math.round(live.taxCents || 0),
      shadow_engine: shadow,
      shadow_cents: shadowCents == null ? null : Math.round(shadowCents),
      delta_cents: shadowCents == null ? null : Math.round(shadowCents - (live.taxCents || 0)),
      shadow_error: error,
    });
  })());

  return live;
}

/* ── Telling the provider the sale actually happened ─────────────────────────

   A calculation is a quote, not a record. Stripe Tax and TaxJar both bill for
   pricing an order and both file from a separate list of COMPLETED sales — so
   an integration that only ever calculates gets charged for every checkout and
   arrives at filing season with nothing to file from. That was the state of
   this repo before now: nothing anywhere called either provider's transaction
   API.

   Both verbs below are deliberately shaped the same and take the same neutral
   arguments, so which provider is configured is not something the fulfilment
   or refund code has to know. Adding Avalara later means adding two functions
   here and nothing anywhere else.

   Neither may ever throw into its caller. The customer has already paid; a
   provider being down is a bookkeeping problem to retry, not a reason to fail
   an order that has money attached to it. Both report what happened so a
   failure is visible rather than silent. */

/** Report a completed sale. Returns { ok, id, engine, skipped?, error? }. */
export async function recordTaxSale({ env, ref, order }) {
  const config = await getTaxEngineConfig(env);
  const engine = config.engine;

  if (!config.reportSales) return { ok: true, skipped: 'reporting turned off', engine };
  /* Nothing to report to: the table is ours, Zip-Tax is a rate lookup with no
     filing product, and 'none' means something outside this checkout handles
     tax entirely. */
  if (engine === 'builtin' || engine === 'ziptax' || engine === 'none') {
    return { ok: true, skipped: 'engine files nothing', engine };
  }

  try {
    if (engine === 'stripe_tax') {
      if (!ref) return { ok: false, engine, error: 'no calculation to report' };
      const key = env.STRIPE_SECRET_KEY;
      if (!key) return { ok: false, engine, error: 'STRIPE_SECRET_KEY not set' };
      const body = new URLSearchParams({ calculation: ref, reference: String(order?.orderNumber || '') });
      const resp = await withTimeout(fetch('https://api.stripe.com/v1/tax/transactions/create_from_calculation', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }), TAX_API_TIMEOUT_MS, 'Stripe Tax record');
      const data = await resp.json().catch(() => null);
      if (!resp.ok) return { ok: false, engine, error: 'Stripe ' + resp.status + ' ' + (data?.error?.message || '') };
      return { ok: true, engine, id: String(data?.id || '') };
    }

    if (engine === 'taxjar') {
      const key = env.TAXJAR_API_KEY;
      if (!key) return { ok: false, engine, error: 'TAXJAR_API_KEY not set' };
      /* TaxJar files from the order itself rather than from a prior quote, so
         there is no handle to carry — the order number is the id on both
         sides, which is also what a refund later refers back to. */
      const resp = await withTimeout(fetch('https://api.taxjar.com/v2/transactions/orders', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transaction_id: String(order?.orderNumber || ''),
          transaction_date: order?.createdAt || new Date().toISOString(),
          from_country: 'US',
          from_zip: shipFromValue('ZIP', env),
          from_state: shipFromValue('STATE', env),
          to_country: order?.address?.country || 'US',
          to_zip: order?.address?.zip || '',
          to_state: normalizeStateCode(order?.address?.state),
          to_city: order?.address?.city || '',
          to_street: order?.address?.line1 || '',
          amount: (order?.subtotalCents || 0) / 100,
          shipping: (order?.shippingCents || 0) / 100,
          sales_tax: (order?.taxCents || 0) / 100,
        }),
      }), TAX_API_TIMEOUT_MS, 'TaxJar record');
      const data = await resp.json().catch(() => null);
      /* Already filed — a webhook retry, not a fault. */
      if (resp.status === 422 && /already exists/i.test(JSON.stringify(data || ''))) {
        return { ok: true, engine, id: String(order?.orderNumber || ''), duplicate: true };
      }
      if (!resp.ok) return { ok: false, engine, error: 'TaxJar ' + resp.status };
      return { ok: true, engine, id: String(data?.order?.transaction_id || order?.orderNumber || '') };
    }

    if (engine === 'taxcloud') {
      const loginId = env.TAXCLOUD_API_LOGIN_ID, key = env.TAXCLOUD_API_KEY;
      if (!loginId || !key) return { ok: false, engine, error: 'TaxCloud credentials not set' };
      const now = new Date().toISOString();
      const resp = await withTimeout(fetch('https://api.taxcloud.net/1.0/TaxCloud/AuthorizedWithCapture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiLoginID: loginId, apiKey: key, customerID: 'guest',
          cartID: ref || String(order?.orderNumber || ''),
          orderID: String(order?.orderNumber || ''),
          dateAuthorized: now, dateCaptured: now,
        }),
      }), TAX_API_TIMEOUT_MS, 'TaxCloud record');
      const data = await resp.json().catch(() => null);
      if (!resp.ok) return { ok: false, engine, error: 'TaxCloud ' + resp.status };
      /* ResponseType 3 is OK; anything less carries messages worth surfacing. */
      if (data && Number(data.ResponseType) < 3) {
        return { ok: false, engine, error: JSON.stringify(data.Messages || data) };
      }
      return { ok: true, engine, id: String(order?.orderNumber || '') };
    }

    if (engine === 'avalara') {
      const config2 = config;
      const resp = await withTimeout(fetch(avaBase(env) + '/api/v2/transactions/create', {
        method: 'POST',
        headers: { Authorization: avaAuth(env), 'Content-Type': 'application/json' },
        /* A committed SalesInvoice is the recorded sale — the same endpoint the
           quote uses, with the document type that counts. */
        body: JSON.stringify(avaDocument({
          env, config: config2,
          address: order?.address || {},
          taxableCents: order?.subtotalCents || 0,
          shippingCents: order?.shippingCents || 0,
          lineItems: null,
          type: 'SalesInvoice', commit: true,
          code: String(order?.orderNumber || ''),
        })),
      }), TAX_API_TIMEOUT_MS, 'Avalara record');
      const data = await resp.json().catch(() => null);
      if (!resp.ok) return { ok: false, engine, error: 'Avalara ' + resp.status + ' ' + ((data && data.error && data.error.message) || '') };
      return { ok: true, engine, id: String((data && data.code) || order?.orderNumber || '') };
    }

    return { ok: true, skipped: 'engine has no reporting API', engine };
  } catch (err) {
    return { ok: false, engine, error: (err && err.message) || String(err) };
  }
}

/** Reverse a reported sale, in full or in part. Same contract as above. */
export async function reverseTaxSale({ env, transactionId, order, amountCents, taxCents, full = false }) {
  const config = await getTaxEngineConfig(env);
  const engine = config.engine;

  if (!config.reportSales) return { ok: true, skipped: 'reporting turned off', engine };
  if (engine === 'builtin' || engine === 'ziptax' || engine === 'none') {
    return { ok: true, skipped: 'engine files nothing', engine };
  }

  try {
    if (engine === 'stripe_tax') {
      if (!transactionId) return { ok: false, engine, error: 'no recorded transaction to reverse' };
      const key = env.STRIPE_SECRET_KEY;
      if (!key) return { ok: false, engine, error: 'STRIPE_SECRET_KEY not set' };
      const body = new URLSearchParams({
        original_transaction: transactionId,
        mode: full ? 'full' : 'partial',
        /* Stripe requires a reference unique to the reversal, not the order —
           two partial refunds on one order are two reversals. */
        reference: 'refund-' + String(order?.orderNumber || '') + '-' + Date.now(),
      });
      if (!full) {
        body.set('flat_amount', String(-Math.abs(Math.round(amountCents || 0))));
      }
      const resp = await withTimeout(fetch('https://api.stripe.com/v1/tax/transactions/create_reversal', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }), TAX_API_TIMEOUT_MS, 'Stripe Tax reversal');
      const data = await resp.json().catch(() => null);
      if (!resp.ok) return { ok: false, engine, error: 'Stripe ' + resp.status + ' ' + (data?.error?.message || '') };
      return { ok: true, engine, id: String(data?.id || '') };
    }

    if (engine === 'taxjar') {
      const key = env.TAXJAR_API_KEY;
      if (!key) return { ok: false, engine, error: 'TAXJAR_API_KEY not set' };
      const orderId = String(order?.orderNumber || '');
      const resp = await withTimeout(fetch('https://api.taxjar.com/v2/transactions/refunds', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          /* TaxJar wants a refund id distinct from the order id it refers to. */
          transaction_id: orderId + '-refund-' + Date.now(),
          transaction_reference_id: orderId,
          transaction_date: new Date().toISOString(),
          from_country: 'US',
          from_zip: shipFromValue('ZIP', env),
          from_state: shipFromValue('STATE', env),
          to_country: order?.address?.country || 'US',
          to_zip: order?.address?.zip || '',
          to_state: normalizeStateCode(order?.address?.state),
          to_city: order?.address?.city || '',
          to_street: order?.address?.line1 || '',
          /* Negative: a refund is a sale in reverse in TaxJar's ledger. */
          amount: -Math.abs((amountCents || 0) / 100),
          shipping: 0,
          sales_tax: -Math.abs((taxCents || 0) / 100),
        }),
      }), TAX_API_TIMEOUT_MS, 'TaxJar reversal');
      const data = await resp.json().catch(() => null);
      if (!resp.ok) return { ok: false, engine, error: 'TaxJar ' + resp.status };
      return { ok: true, engine, id: String(data?.refund?.transaction_id || '') };
    }

    if (engine === 'taxcloud') {
      const loginId = env.TAXCLOUD_API_LOGIN_ID, key = env.TAXCLOUD_API_KEY;
      if (!loginId || !key) return { ok: false, engine, error: 'TaxCloud credentials not set' };
      const resp = await withTimeout(fetch('https://api.taxcloud.net/1.0/TaxCloud/Returned', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiLoginID: loginId, apiKey: key,
          orderID: String(order?.orderNumber || ''),
          /* Empty list is TaxCloud's whole-order return. This store refunds by
             amount rather than by line, so naming specific lines would be
             inventing detail it does not have. */
          cartItems: [],
          returnedDate: new Date().toISOString(),
        }),
      }), TAX_API_TIMEOUT_MS, 'TaxCloud reversal');
      if (!resp.ok) return { ok: false, engine, error: 'TaxCloud ' + resp.status };
      return { ok: true, engine, id: String(order?.orderNumber || '') };
    }

    if (engine === 'avalara') {
      /* Voiding removes the tax on the WHOLE sale. That is right for a full
         refund and wrong for a partial one, which needs a ReturnInvoice with
         line detail this store does not keep per refund. Refusing is better
         than reversing more than actually came back. */
      if (!full) {
        return { ok: false, engine, error: 'Avalara partial reversals need a ReturnInvoice — reverse this one in AvaTax directly' };
      }
      const company = config.companyCode || env.AVALARA_COMPANY_CODE || 'DEFAULT';
      const code = encodeURIComponent(String(order?.orderNumber || ''));
      const resp = await withTimeout(fetch(
        avaBase(env) + '/api/v2/companies/' + encodeURIComponent(company) + '/transactions/' + code + '/void',
        {
          method: 'POST',
          headers: { Authorization: avaAuth(env), 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 'DocVoided' }),
        }
      ), TAX_API_TIMEOUT_MS, 'Avalara reversal');
      if (!resp.ok) return { ok: false, engine, error: 'Avalara ' + resp.status };
      return { ok: true, engine, id: String(order?.orderNumber || '') };
    }

    return { ok: true, skipped: 'engine has no reporting API', engine };
  } catch (err) {
    return { ok: false, engine, error: (err && err.message) || String(err) };
  }
}
