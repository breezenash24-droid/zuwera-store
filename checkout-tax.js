(function () {
  'use strict';

  const STATE_NAME_TO_CODE = {
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

  const STATE_RATES = {
    AL: 0.04, AK: 0, AZ: 0.056, AR: 0.065, CA: 0.0725,
    CO: 0.029, CT: 0.0635, DE: 0, FL: 0.06, GA: 0.04,
    HI: 0.04, ID: 0.06, IL: 0.0625, IN: 0.07, IA: 0.06,
    KS: 0.065, KY: 0.06, LA: 0.0445, ME: 0.055, MD: 0.06,
    MA: 0.0625, MI: 0.06, MN: 0.06875, MS: 0.07, MO: 0.04225,
    MT: 0, NE: 0.055, NV: 0.0685, NH: 0, NJ: 0.06625,
    NM: 0.05125, NY: 0.04, NC: 0.0475, ND: 0.05, OH: 0.0575,
    OK: 0.045, OR: 0, PA: 0.06, RI: 0.07, SC: 0.06,
    SD: 0.042, TN: 0.07, TX: 0.0625, UT: 0.061, VT: 0.06,
    VA: 0.053, WA: 0.065, WV: 0.06, WI: 0.05, WY: 0.04,
    DC: 0.06,
  };

  function normalizeStateCode(value) {
    const upper = String(value || '').trim().toUpperCase().replace(/\./g, '');
    if (upper.length === 2) return upper;
    return STATE_NAME_TO_CODE[upper] || '';
  }

  function getRate(stateCode) {
    const normalized = normalizeStateCode(stateCode);
    return normalized && Object.prototype.hasOwnProperty.call(STATE_RATES, normalized)
      ? STATE_RATES[normalized]
      : 0;
  }

  function cents(subtotalCents, stateCode) {
    const amount = Number(subtotalCents) || 0;
    return amount > 0 ? Math.round(amount * getRate(stateCode)) : 0;
  }

  function dollars(subtotalDollars, stateCode) {
    const amount = Number(subtotalDollars) || 0;
    return amount > 0 ? amount * getRate(stateCode) : 0;
  }

  window.ZWCheckoutTax = {
    normalizeStateCode,
    rateForState: getRate,
    taxCents: cents,
    taxDollars: dollars,
  };
}());
