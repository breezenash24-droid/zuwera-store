/* stock-rules.js — "how many of this size, in this colour, are there?" for the
   storefront, answered the same way the server answers it.
 *
 * This question was being answered by four different pieces of code:
 * product.html's sizeStockForColor, fetchSizeStockQty in the payment path,
 * notify-restock's matcher, and a stale stockQty snapshot kept on each bag
 * line. They disagreed, and the disagreement reached customers — the product
 * page offered "Only 1 left in stock" and checkout answered "is out of stock",
 * because one matched colour case-sensitively and the other did not.
 *
 * So this is the storefront's copy, written to mirror
 * functions/api/_cart-pricing.js exactly: same size folding, same colour
 * normalisation, same null-colour fallback, same summing. If one changes the
 * other has to, and the parity tests exist to say so.
 *
 * IMPORTANT: this is display and input-limiting only. It runs in the browser
 * on data the browser was handed, so it is a courtesy to the shopper, never the
 * thing standing between the store and an oversell — the payment path re-checks
 * every line server-side before taking money, and it is the one that counts.
 */
(function (w) {
  'use strict';

  /* Size labels are written inconsistently: a button renders "XXL" where the
     inventory row says "2XL". Fold both to one form before comparing. */
  function canonSize(value) {
    var s = String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, '');
    var m = s.match(/^([2-5])x(s|l)$/);        // 2xl → xxl
    if (m) return new Array(Number(m[1]) + 1).join('x') + m[2];
    var r = s.match(/^(x{2,5})(s|l)$/);        // already xxl form
    if (r) return r[1] + r[2];
    return s;
  }

  function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

  /**
   * @param rows      product_sizes rows: { product_id, size, color_name, stock_quantity }
   * @param productId the product being asked about
   * @param size      display size label
   * @param colorName selected colourway name, or falsy for none
   * @returns number of units, or null when availability is UNKNOWN.
   *
   * null and 0 are different answers and callers must treat them differently:
   * null means this product has no inventory configured, which the product page
   * treats as freely buyable, so a cap here would block a sale the store never
   * said was limited. 0 means rows exist and none match — genuinely none.
   */
  function stockFor(rows, productId, size, colorName) {
    if (!Array.isArray(rows) || !productId) return null;
    var pid = String(productId);
    var mine = rows.filter(function (r) { return r && String(r.product_id) === pid; });
    if (!mine.length) return null;                       // nothing configured

    var wanted = canonSize(size);
    var sized = mine.filter(function (r) { return canonSize(r.size) === wanted; });
    if (!sized.length) return 0;                         // configured, not this size

    var sum = function (list) {
      return list.reduce(function (s, r) { return s + (Number(r.stock_quantity) || 0); }, 0);
    };

    if (colorName) {
      var c = norm(colorName);
      var colored = sized.filter(function (r) { return norm(r.color_name) === c; });
      if (colored.length) return sum(colored);
      /* Legacy products save stock colour-agnostically (color_name NULL). Those
         rows cover every colourway, so they are the right fallback — another
         COLOUR's rows are not, they describe a different garment. */
      var anon = sized.filter(function (r) { return !r.color_name; });
      return anon.length ? sum(anon) : 0;
    }
    var anonOnly = sized.filter(function (r) { return !r.color_name; });
    return anonOnly.length ? sum(anonOnly) : sum(sized);
  }

  /* One in-flight request per page, shared by every caller. The bag re-renders
     on each quantity change and must not refetch each time. */
  var _cache = null;
  var _resolved = null;
  function load(force) {
    if (_cache && !force) return _cache;
    _cache = fetch('/api/stock', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        _resolved = {
          rows: (d && Array.isArray(d.sizes)) ? d.sizes : [],
          /* Whether the storefront should stop a shopper exceeding stock, set
             in Admin → Commerce. Delivered on this response rather than fetched
             separately because it is read at exactly the moments stock is, and
             a second round trip would let the two arrive out of step.
             Defaults to ON: a store that never touches the setting should not
             be able to accept orders it cannot fill. */
          limitToStock: !(d && d.limitToStock === false),
        };
        return _resolved;
      })
      .catch(function () {
        /* Unreachable. No rows, so stockFor answers null — unknown, not zero.
           Failing to load stock must never empty the shop. */
        _resolved = { rows: [], limitToStock: true };
        return _resolved;
      });
    return _cache;
  }

  /* The already-loaded answer, or null if it has not arrived yet. Click
     handlers are synchronous and cannot await; they get this, and the async
     pass that decorates the list afterwards is what corrects anything they
     waved through in the meantime. */
  function peek() { return _resolved; }

  /* ── Back-in-stock, in one place ──────────────────────────────────────────
     The "email me when it's back" prompt appears on the product page, in the
     quick-add modal and now in the bag. Its on/off switch, its session prefill
     and its write all live here so the three cannot drift apart — a shopper
     turning it off in admin and still meeting it in the bag is the same class
     of bug as the stock mismatch above, and it is how that one started. */

  /* Permissive by design: only an EXPLICIT enabled:false suppresses it. Flags
     load asynchronously, so treating "not loaded yet" as off would hide the
     prompt from whoever arrived first. */
  function restockEnabled() {
    try {
      var f = w.__zwFlags && w.__zwFlags.feature_back_in_stock;
      return !(f && f.enabled === false);
    } catch (_) { return true; }
  }

  /* Someone signed in should never be asked to type an address we already
     hold. Two sources because they populate at different times: the cached
     session user is there immediately on a warm page, the Supabase call
     resolves shortly after on a cold one. */
  function prefillEmail(input) {
    if (!input || input.value.trim()) return;
    try {
      var u = w.__zwSessionUser;
      if (u && u.email) { input.value = u.email; return; }
      if (w.sb && w.sb.auth) {
        w.sb.auth.getSession().then(function (r) {
          var e = r && r.data && r.data.session && r.data.session.user && r.data.session.user.email;
          if (e && input && !input.value.trim()) input.value = e;
        }).catch(function () {});
      }
    } catch (_) {}
  }

  /* Resolves to a message to show the shopper. A duplicate is not an error to
     them — they asked twice for the same thing and the answer is still yes. */
  function joinWaitlist(req) {
    var email = String((req && req.email) || '').trim();
    if (!email || email.indexOf('@') === -1) {
      return Promise.resolve({ ok: false, message: 'Enter a valid email.' });
    }
    if (!w.sb || !req || !req.productId) {
      return Promise.resolve({ ok: false, message: 'Could not save that — try again.' });
    }
    return w.sb.from('restock_requests').insert({
      product_id: req.productId,
      size: req.size || null,
      color_name: req.colorName || null,
      email: email,
    }).then(function (res) {
      var err = res && res.error;
      if (!err) return { ok: true, message: '✓ We’ll email you when it’s back.' };
      // 23505 = unique violation: already on the list.
      if (String(err.code) === '23505') return { ok: true, message: 'You’re already on the list for this one.' };
      return { ok: false, message: err.message || 'Could not save that — try again.' };
    }).catch(function (e) {
      return { ok: false, message: (e && e.message) || 'Could not save that — try again.' };
    });
  }

  w.ZWStock = {
    canonSize: canonSize,
    stockFor: stockFor,
    load: load,
    peek: peek,
    restockEnabled: restockEnabled,
    prefillEmail: prefillEmail,
    joinWaitlist: joinWaitlist,
  };
})(window);
