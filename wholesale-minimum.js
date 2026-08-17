/* The trade minimum, said while there is still time to act on it.
 *
 * The minimum was enforced at the till and announced nowhere else. A trade
 * buyer filled a bag, went to pay, and was refused after choosing everything —
 * a correct refusal arriving at the worst possible moment, which is the
 * difference between a rule and an ambush.
 *
 * This does NOT move the enforcement. _cart-pricing.js still refuses the order,
 * because the browser can be told and only the till can refuse. What this adds
 * is the telling: how far off you are, while you are still shopping.
 *
 * ── ONE ANSWER, ASKED ONCE ──────────────────────────────────────────────────
 *
 * The figure comes from /api/my-wholesale, which reads it through the same
 * wholesaleMinimumCents() the till uses. A second copy of "what is my minimum"
 * computed in the browser is how a page comes to promise $250 while checkout
 * enforces $500 — and the shopper is told, at the end, that the thing they were
 * shown was wrong.
 *
 * Cached for the page's lifetime rather than per call: several surfaces ask,
 * and the answer cannot change while somebody is looking at their bag.
 */
(function () {
  'use strict';

  var _promise = null;

  /* The signed-in shopper's own terms, or a shape meaning "no minimum".
     Never throws: a bag that fails to render because a trade lookup failed
     would be a retail shopper's checkout broken by a wholesale feature. */
  function terms() {
    if (_promise) return _promise;
    _promise = (function () {
      try {
        var sb = window.sb || window.supabaseClient;
        if (!sb || !sb.auth) return Promise.resolve(null);
        return sb.auth.getSession().then(function (res) {
          var t = res && res.data && res.data.session && res.data.session.access_token;
          if (!t) return null;
          return fetch('/api/my-wholesale', { headers: { Authorization: 'Bearer ' + t } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) { return (d && d.ok && d.isWholesale) ? d : null; })
            .catch(function () { return null; });
        }).catch(function () { return null; });
      } catch (_) { return Promise.resolve(null); }
    }());
    return _promise;
  }

  var money = function (cents) { return '$' + (Number(cents || 0) / 100).toFixed(2); };

  /**
   * Paint the minimum into `host`, given the goods subtotal in CENTS.
   *
   * Cents, not dollars, and the caller converts. The till compares cents, and a
   * float subtotal rounded differently on the way in is how a bag says "you
   * have reached it" about an order the server then refuses by one penny.
   */
  function paint(host, subtotalCents) {
    if (!host) return;
    terms().then(function (w) {
      if (!w || !(w.minOrderCents > 0)) { host.innerHTML = ''; host.hidden = true; return; }
      host.hidden = false;
      var need = w.minOrderCents - Math.round(Number(subtotalCents) || 0);
      var met = need <= 0;
      var pct = Math.max(0, Math.min(100, Math.round(
        (Math.round(Number(subtotalCents) || 0) / w.minOrderCents) * 100)));

      host.innerHTML =
        '<div style="border:1px solid ' + (met ? 'rgba(34,197,94,.45)' : 'rgba(251,191,36,.45)')
        + ';background:' + (met ? 'rgba(34,197,94,.08)' : 'rgba(251,191,36,.08)')
        + ';border-radius:8px;padding:.7rem .85rem;margin:.75rem 0;font-size:.8rem;line-height:1.55;">'
        + '<div style="display:flex;justify-content:space-between;gap:.6rem;">'
        + '<span>Trade minimum ' + money(w.minOrderCents) + '</span>'
        + '<span style="font-variant-numeric:tabular-nums;">' + money(subtotalCents) + '</span>'
        + '</div>'
        /* A bar, because "how much further" is a quantity and reads faster as a
           length than as a sentence. */
        + '<div style="height:4px;border-radius:2px;background:rgba(127,127,127,.25);margin:.5rem 0 .4rem;">'
        + '<div style="height:100%;border-radius:2px;width:' + pct + '%;background:'
        + (met ? '#22c55e' : '#fbbf24') + ';"></div></div>'
        + '<div style="opacity:.85;">'
        + (met
            ? 'Minimum reached — this order can be placed.'
            : 'Add ' + money(need) + ' more of goods to place this order.')
        + '</div>'
        /* Named so the figure is not mistaken for the order total: shipping,
           tax and a promo code all move that and none of them count here. */
        + (met ? '' : '<div style="opacity:.6;margin-top:.25rem;">Counted on goods only — '
            + 'shipping, tax and discount codes do not go towards it.</div>')
        + '</div>';
    });
  }

  window.ZWWholesaleMinimum = { terms: terms, paint: paint };
}());
