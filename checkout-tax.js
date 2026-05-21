(function () {
  'use strict';

  // ── Flat-rate states (no county or local add-ons) ─────────────────────────
  // KY and IN have statewide uniform rates — no ZIP lookup needed.
  const FLAT = { KY: 0.06, IN: 0.07 };

  // ── Ohio county combined rates (state 5.75% + county levy) ────────────────
  // Source: Ohio Department of Taxation — verify at tax.ohio.gov before filing.
  // Some ZIP3 prefixes straddle county lines; the dominant county is used.
  const OH_COUNTY = {
    Adams: 0.0725, Allen: 0.0675, Ashland: 0.07, Ashtabula: 0.07,
    Athens: 0.07, Auglaize: 0.0725, Belmont: 0.0725, Brown: 0.0725,
    Butler: 0.07, Carroll: 0.0725, Champaign: 0.0725, Clark: 0.0725,
    Clermont: 0.07, Clinton: 0.0725, Columbiana: 0.0725, Coshocton: 0.0725,
    Crawford: 0.0725, Cuyahoga: 0.08, Darke: 0.0725, Defiance: 0.0725,
    Delaware: 0.07, Erie: 0.0675, Fairfield: 0.0675, Fayette: 0.0725,
    Franklin: 0.075, Fulton: 0.0725, Gallia: 0.0725, Geauga: 0.07,
    Greene: 0.0675, Guernsey: 0.0725, Hamilton: 0.07, Hancock: 0.0675,
    Hardin: 0.0725, Harrison: 0.0725, Henry: 0.0725, Highland: 0.0725,
    Hocking: 0.0725, Holmes: 0.0725, Huron: 0.0725, Jackson: 0.0725,
    Jefferson: 0.0725, Knox: 0.0725, Lake: 0.0725, Lawrence: 0.0725,
    Licking: 0.0725, Logan: 0.0725, Lorain: 0.065, Lucas: 0.0725,
    Madison: 0.07, Mahoning: 0.0725, Marion: 0.0725, Medina: 0.0675,
    Meigs: 0.0725, Mercer: 0.0725, Miami: 0.0675, Monroe: 0.0725,
    Montgomery: 0.075, Morgan: 0.0725, Morrow: 0.0725, Muskingum: 0.0725,
    Noble: 0.0725, Ottawa: 0.07, Paulding: 0.0725, Perry: 0.0725,
    Pickaway: 0.0725, Pike: 0.0725, Portage: 0.0725, Preble: 0.07,
    Putnam: 0.0725, Richland: 0.0725, Ross: 0.0725, Sandusky: 0.0725,
    Scioto: 0.0725, Seneca: 0.0725, Shelby: 0.0725, Stark: 0.065,
    Summit: 0.0675, Trumbull: 0.0725, Tuscarawas: 0.0725, Union: 0.07,
    VanWert: 0.0725, Vinton: 0.0725, Warren: 0.0675, Washington: 0.0725,
    Wayne: 0.0675, Williams: 0.0725, Wood: 0.0675, Wyandot: 0.0725,
  };

  // ZIP3 (first 3 digits of ZIP code) → Ohio county name
  const OH_ZIP3 = {
    '430': 'Franklin', '431': 'Franklin', '432': 'Franklin', // Columbus
    '433': 'Marion',   '434': 'Wood',                        // Marion / NW Ohio
    '435': 'Defiance', '436': 'Lucas',                       // NW corner / Toledo
    '437': 'Muskingum','438': 'Coshocton',                   // East-central
    '440': 'Lorain',   '441': 'Cuyahoga',                    // Cleveland metro
    '442': 'Summit',   '443': 'Summit',                      // Akron
    '444': 'Mahoning', '445': 'Mahoning',                    // Youngstown
    '446': 'Stark',    '447': 'Stark', '448': 'Stark',       // Canton
    '449': 'Richland',                                        // Mansfield
    '450': 'Hamilton', '451': 'Clermont', '452': 'Hamilton', // Cincinnati area
    '453': 'Miami',    '454': 'Montgomery',                   // Dayton metro
    '455': 'Clark',    '456': 'Ross',                        // Springfield / Chillicothe
    '457': 'Athens',   '458': 'Allen',   '459': 'Allen',     // SE / Lima
  };

  function ohioRate(zip5) {
    const county = OH_ZIP3[zip5.slice(0, 3)];
    return OH_COUNTY[county] ?? 0.0725; // 7.25% is the most common OH county rate
  }

  // ── Illinois ZIP3 combined rates ───────────────────────────────────────────
  // Illinois has complex city/district layering — these are county-level base
  // rates. Individual municipalities (especially Chicago suburbs) may be higher.
  const IL_ZIP3 = {
    '600': 0.0825, '601': 0.0725, '602': 0.0725,            // Cook suburbs / DuPage
    '603': 0.07,   '604': 0.0825, '605': 0.0725,            // Lake IL / Cook SW
    '606': 0.1025, '607': 0.1025,                            // Chicago city
    '608': 0.0825, '609': 0.075,                             // Cook SE / Kankakee
    '610': 0.0825, '611': 0.08,   '612': 0.0825,            // Rockford / Rock Island
    '613': 0.0625,                                            // LaSalle (no local tax)
    '614': 0.085,  '615': 0.085,                             // Peoria
    '616': 0.0825,                                            // Bloomington / McLean
    '617': 0.0625,                                            // Knox / Galesburg
    '618': 0.0725, '619': 0.0725,                            // S Illinois / Quincy
    '620': 0.0835, '621': 0.0725, '622': 0.0625,            // St. Clair / Madison / Effingham
    '623': 0.085,  '624': 0.085,  '625': 0.09,              // Springfield / Vermilion / Champaign
    '626': 0.085,  '627': 0.085,  '628': 0.0625, '629': 0.0725,
  };

  // ── State base rates (fallback when no county/ZIP lookup exists) ───────────
  const STATE_RATES = {
    AL: 0.04,  AK: 0,      AZ: 0.056,  AR: 0.065,  CA: 0.0725,
    CO: 0.029, CT: 0.0635, DE: 0,      FL: 0.06,   GA: 0.04,
    HI: 0.04,  ID: 0.06,   IL: 0.0625, IN: 0.07,   IA: 0.06,
    KS: 0.065, KY: 0.06,   LA: 0.0445, ME: 0.055,  MD: 0.06,
    MA: 0.0625,MI: 0.06,   MN: 0.06875,MS: 0.07,   MO: 0.04225,
    MT: 0,     NE: 0.055,  NV: 0.0685, NH: 0,      NJ: 0.06625,
    NM: 0.05125,NY: 0.04,  NC: 0.0475, ND: 0.05,   OH: 0.0575,
    OK: 0.045, OR: 0,      PA: 0.06,   RI: 0.07,   SC: 0.06,
    SD: 0.042, TN: 0.07,   TX: 0.0625, UT: 0.061,  VT: 0.06,
    VA: 0.053, WA: 0.065,  WV: 0.06,   WI: 0.05,   WY: 0.04,
    DC: 0.06,
  };

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

  function normalizeStateCode(value) {
    const upper = String(value || '').trim().toUpperCase().replace(/\./g, '');
    if (upper.length === 2) return upper;
    return STATE_NAME_TO_CODE[upper] || '';
  }

  function getRate(stateCode, zip) {
    const s = normalizeStateCode(stateCode);
    if (!s) return 0;
    if (FLAT[s] !== undefined) return FLAT[s];
    const z = String(zip || '').replace(/\D/g, '');
    if (s === 'OH' && z.length >= 3) return ohioRate(z);
    if (s === 'IL' && z.length >= 3) return IL_ZIP3[z.slice(0, 3)] ?? (STATE_RATES.IL || 0.0625);
    return STATE_RATES[s] || 0;
  }

  function cents(subtotalCents, stateCode, zip) {
    const amount = Number(subtotalCents) || 0;
    return amount > 0 ? Math.round(amount * getRate(stateCode, zip)) : 0;
  }

  function dollars(subtotalDollars, stateCode, zip) {
    const amount = Number(subtotalDollars) || 0;
    return amount > 0 ? amount * getRate(stateCode, zip) : 0;
  }

  window.ZWCheckoutTax = {
    normalizeStateCode,
    rateForState: getRate,
    taxCents:   cents,
    taxDollars: dollars,
  };
}());
