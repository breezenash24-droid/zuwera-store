/* zw-turnstile.js — one invisible bot check the storefront can ask for a token.
 *
 * The admin sign-in screen has had Turnstile for a while. Nothing on the
 * storefront did, which is why /api/subscribe could be posted to in a loop by
 * anything that could open a socket.
 *
 * WHAT THIS IS. `window.zwHumanToken()` returns a promise for a Turnstile
 * token, loading the script and rendering an invisible widget the first time it
 * is asked and reusing them after. A form calls it in its submit handler and
 * puts the result in the body; the endpoint verifies it server-side.
 *
 * IT RESOLVES TO '' RATHER THAN REJECTING. A blocked script, an offline
 * network, a Turnstile outage — all of them come back as an empty string, and
 * the SERVER decides what an empty token means. That decision does not belong
 * in the browser: a page that could decide it had passed the check would be a
 * check anybody could pass by editing a variable.
 *
 * THE SITE KEY IS PUBLIC. It is in the widget markup on every site that uses
 * Turnstile. The secret, which is the half that matters, is a Cloudflare
 * environment variable the browser never sees.
 *
 * ONE DEFINITION. admin-main.js has its own copy of this key for the admin
 * login widget, which loads before this file could and must not depend on it.
 * tests/bot-check-covers-the-endpoints.test.js asserts the two are the same
 * string, so a rotated key cannot half-land.
 */
(function () {
  'use strict';

  var SITEKEY = '0x4AAAAAADRcULYsa0xJEyZH';
  var SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

  var scriptPromise = null;
  var widgetId = null;
  var host = null;

  function loadScript() {
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise(function (resolve) {
      if (window.turnstile) { resolve(true); return; }
      var existing = document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]');
      if (existing) {
        /* Another module (the admin panel) already asked for it. Wait for the
           global rather than adding a second copy — two loads of the same
           script is how a widget ends up rendered twice. */
        var tries = 0;
        var tick = setInterval(function () {
          if (window.turnstile || ++tries > 100) { clearInterval(tick); resolve(!!window.turnstile); }
        }, 100);
        return;
      }
      var s = document.createElement('script');
      s.src = SCRIPT;
      s.async = true;
      s.defer = true;
      s.onload = function () { resolve(!!window.turnstile); };
      s.onerror = function () { resolve(false); };
      document.head.appendChild(s);
    });
    return scriptPromise;
  }

  function ensureHost() {
    if (host && document.body.contains(host)) return host;
    host = document.createElement('div');
    host.id = 'zw-turnstile-host';
    /* Off-screen rather than display:none — an invisible Turnstile widget still
       has to be in the layout for the challenge to run, and `display:none` is
       the usual reason a token never arrives. */
    host.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;overflow:hidden';
    document.body.appendChild(host);
    return host;
  }

  /* The widget's callbacks are bound once, at render, and every later call
     re-enters those same closures. So the thing that changes per call is not
     the callback — it is who is waiting. One slot, handed to whichever call is
     outstanding, because a second widget per submit would be a second challenge
     and a second cost. */
  var pending = null;
  function settle(token) {
    var p = pending;
    pending = null;
    if (p) p(token || '');
  }

  /**
   * A token, or '' if one could not be obtained.
   * @param {number} [timeoutMs] how long to wait before giving up.
   */
  window.zwHumanToken = function (timeoutMs) {
    var wait = typeof timeoutMs === 'number' ? timeoutMs : 8000;
    return loadScript().then(function (ready) {
      if (!ready || !window.turnstile) return '';
      return new Promise(function (resolve) {
        var settled = false;
        function done(v) { if (!settled) { settled = true; resolve(v || ''); } }
        /* Whoever was waiting before loses their slot to a timeout rather than
           to silence — two submits in flight is unusual, and hanging is worse
           than an empty token the server will reject. */
        settle('');
        pending = done;
        setTimeout(function () { if (pending === done) settle(''); else done(''); }, wait);
        try {
          if (widgetId === null) {
            widgetId = window.turnstile.render(ensureHost(), {
              sitekey: SITEKEY,
              size: 'invisible',
              callback: settle,
              'error-callback': function () { settle(''); },
              'timeout-callback': function () { settle(''); },
            });
          } else {
            window.turnstile.reset(widgetId);
          }
          /* render() on an invisible widget does not run the challenge;
             execute() does, and the callback above is where the token lands. */
          window.turnstile.execute(widgetId);
        } catch (_) {
          settle('');
        }
      });
    }).catch(function () { return ''; });
  };
}());
