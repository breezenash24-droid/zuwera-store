/**
 * Reveal the store-credit option, but only where it can be honoured.
 *
 * ── WHY THIS IS A FILE AND NOT FOUR COPIES OF AN IF ─────────────────────────
 *
 * Four forms ask a customer how they want a return settled: the signed-in one
 * in account.html, the customer hub's, the guest form and the multi-step flow
 * in returns.html. They have asked the same question in four places for as long
 * as they have existed, and the last time store credit was on them it was
 * REMOVED from all four in one change — because a fix applied to three of them
 * is a fix that looks done and leaves one form promising money nobody could
 * find. Putting the option back the same way it came out is the only version of
 * this that stays true.
 *
 * ── THE GATE IS THE SAME SWITCH THE TILL READS ──────────────────────────────
 *
 * /api/stored-value answers "does this store run store credit at all", from the
 * one settings row the checkout reads and the refund panel refuses on. So a
 * customer cannot pick a settlement that a staff member is then told is
 * switched off — the two ends of that conversation are looking at the same
 * boolean.
 *
 * FAILING QUIETLY LEAVES IT HIDDEN. An unreachable endpoint, a blocked request,
 * a store mid-deploy: all of them mean the shopper sees the two choices they
 * saw yesterday. The direction that cannot promise anything is the direction a
 * failure should go.
 *
 * ── AND IT WATCHES, BECAUSE TWO OF THE FORMS ARE BUILT LATER ────────────────
 *
 * The hub form and the guest form are assembled from strings after this script
 * has run, so a single pass at load would reveal the option on two forms out of
 * four — which is exactly the failure mode described above, in a new costume.
 */
(function () {
  var ATTR = '[data-zw-needs-credit]';
  var answer = null;   // null = not asked yet, true/false = asked

  function reveal(root) {
    if (answer !== true) return;
    var scope = root && root.querySelectorAll ? root : document;
    var nodes = scope.querySelectorAll(ATTR);
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].removeAttribute('hidden');
      /* An <option> ignores [hidden] in some browsers and honours it in others,
         so the attribute alone is not a gate on a <select>. It is removed from
         the DOM instead and put back when the answer is yes — which is also why
         nothing here relies on CSS: a stylesheet that fails to load must not be
         what decides whether a promise is made. */
      nodes[i].style.display = '';
    }
    /* The node itself may BE the match rather than contain one. */
    if (root && root.matches && root.matches(ATTR)) {
      root.removeAttribute('hidden');
      root.style.display = '';
    }
  }

  function hideAll() {
    var nodes = document.querySelectorAll(ATTR);
    for (var i = 0; i < nodes.length; i++) nodes[i].style.display = 'none';
  }

  function ask() {
    if (answer !== null) return Promise.resolve(answer);
    return fetch('/api/stored-value')
      .then(function (r) { return r.json(); })
      .then(function (p) { answer = !!(p && p.enabled); return answer; })
      .catch(function () { answer = false; return answer; });
  }

  function start() {
    /* Hidden before the question is answered, not after. A form that flashes an
       option and takes it away has already offered it. */
    hideAll();
    ask().then(function (on) {
      if (!on) return;
      reveal(document);
      watch();
    });
  }

  function watch() {
    if (typeof MutationObserver !== 'function' || document.__zwCreditWatched) return;
    document.__zwCreditWatched = true;
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          if (added[j].nodeType === 1) reveal(added[j]);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  /* Exposed so a form built on demand can ask directly rather than waiting for
     the observer — and so anything else that needs the answer asks the same
     question once. */
  window.zwStoreCreditOffered = ask;
  window.zwRevealStoreCredit = function (root) { return ask().then(function () { reveal(root || document); }); };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
