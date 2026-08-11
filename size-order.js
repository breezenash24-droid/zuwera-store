/* ────────────────────────────────────────────────────────────────────────────
   size-order.js — what order sizes go in.

   The quick-add modal listed XS, S, L, XL, 2XL, M — with M last, because it
   asked the database for `order=created_at.asc` and that row happened to be
   written last. Creation order is not size order and never was; it only looked
   right while nobody had re-added a size.

   product.html already had a real comparator for this and the modal did not
   use it, which is the fault this codebase keeps producing: the answer exists
   once and a second screen invents its own.

   Ranks rather than an index, so 2XL, XXL and 4XL all land somewhere sensible
   without needing to be listed. Anything unrecognised sorts to the END and
   then alphabetically among its own kind — "One Size", "Youth L", a size
   somebody typed by hand — because pushing an unknown to the front would put
   it above the sizes people actually shop by.
   ──────────────────────────────────────────────────────────────────────────── */
(function (w) {
  'use strict';

  /* Spaced out so anything derived can be slotted between without renumbering. */
  var BASE = {
    xxs: 10, xs: 20, s: 30, m: 40, l: 50, xl: 60, xxl: 70, xxxl: 80,
    'one size': 45, os: 45, 'onesize': 45,
  };

  function rank(label) {
    var t = String(label == null ? '' : label).trim().toLowerCase().replace(/[\s._-]+/g, '');
    if (!t) return null;
    if (BASE[t] !== undefined) return BASE[t];

    /* 2XL, 3XL … and 2XS, 3XS. The same shape from both ends, which is why
       they are read rather than listed: a store selling 5XL should not need a
       code change to have it sort after 4XL. */
    /* 50 + n, not 60 + n: 2XL and XXL are the same garment, so 2 has to land
       on XXL's 70 rather than a step past it. Off by one step, it would have
       sorted a catalogue that spells it both ways into two groups. */
    var big = t.match(/^(\d+)x?l$/);
    if (big) return 50 + Number(big[1]) * 10;
    var small = t.match(/^(\d+)x?s$/);
    if (small) return 30 - Number(small[1]) * 10;

    /* XXL / XXXL written out. */
    var xs = t.match(/^(x+)s$/);
    if (xs) return 30 - xs[1].length * 10;
    var xl = t.match(/^(x+)l$/);
    if (xl) return 50 + xl[1].length * 10;

    /* Numeric sizes — waist, shoe, age. Kept well clear of the letters so a
       catalogue mixing both does not interleave them. */
    if (/^\d+(\.\d+)?$/.test(t)) return 1000 + Number(t);

    return null;
  }

  function compare(a, b) {
    var ra = rank(a);
    var rb = rank(b);
    if (ra !== null || rb !== null) {
      if (ra === null) return 1;          // unknown goes last
      if (rb === null) return -1;
      if (ra !== rb) return ra - rb;
    }
    return String(a || '').localeCompare(String(b || ''), undefined,
      { numeric: true, sensitivity: 'base' });
  }

  /* Sorts a COPY. Sorting in place has bitten this codebase before, where the
     array handed in was also the one something else was reading. */
  function sort(list, pick) {
    var get = typeof pick === 'function' ? pick : function (x) { return x; };
    return (Array.isArray(list) ? list.slice() : []).sort(function (x, y) {
      return compare(get(x), get(y));
    });
  }

  w.ZWSizeOrder = { rank: rank, compare: compare, sort: sort };
})(typeof window !== 'undefined' ? window : this);
