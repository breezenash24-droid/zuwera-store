/**
 * Cloudflare Pages Function: /api/detect-state
 *
 * Returns a best-effort state code based on Cloudflare edge geolocation.
 * Used only for UX prefill. Final tax/shipping decisions should still use
 * the customer's confirmed shipping address.
 */

const CORS = (env) => ({
  'Access-Control-Allow-Origin': env.SITE_URL || '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
});

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
  WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC'
};

function normalizeStateCode(value) {
  if (!value) return '';
  const normalized = String(value).trim().toUpperCase().replace(/\./g, '');
  if (normalized.length === 2) return normalized;
  return US_STATE_NAME_TO_CODE[normalized] || '';
}

function detectState(request) {
  const cf = request?.cf || {};
  const headerCountry = request.headers.get('CF-IPCountry');
  const headerRegionCode = request.headers.get('CF-Region-Code');
  const headerRegion = request.headers.get('CF-Region');

  const country = String(cf.country || headerCountry || '').toUpperCase();

  const candidates = [
    { value: cf.regionCode, source: 'request.cf.regionCode' },
    { value: cf.region, source: 'request.cf.region' },
    { value: headerRegionCode, source: 'header.CF-Region-Code' },
    { value: headerRegion, source: 'header.CF-Region' }
  ];

  for (const candidate of candidates) {
    const state = normalizeStateCode(candidate.value);
    if (state) {
      return { state, country, source: candidate.source };
    }
  }

  return { state: '', country, source: 'none' };
}

export async function onRequestOptions({ env }) {
  return new Response(null, { status: 204, headers: CORS(env) });
}

export async function onRequestGet({ request, env }) {
  const headers = CORS(env);
  const detected = detectState(request);

  return new Response(
    JSON.stringify({
      detected: Boolean(detected.state),
      state: detected.state || null,
      country: detected.country || null,
      source: detected.source
    }),
    { status: 200, headers }
  );
}
