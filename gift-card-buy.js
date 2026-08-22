/* gift-card-buy.js — everything it takes to BUY a gift card, in one place.
 *
 * ── WHY THIS IS A MODULE AND NOT TWO COPIES ─────────────────────────────────
 *
 * A gift card needs two answers before it can go in a bag: an amount, and
 * somebody to send it to. Two surfaces have to ask for them — the product page
 * and the quick-add panel — and everything that could differ between two copies
 * is something that decides money or where an email goes:
 *
 *   - which amounts are offered, and whether a typed one is allowed
 *   - the floor and the ceiling on a typed one
 *   - that the chosen figure becomes BOTH the price and the face value
 *   - that a card with no recipient is refused rather than sent to the buyer
 *   - the caps on a name, an address and a note
 *
 * The panel used to sidestep this by refusing to sell gift cards at all and
 * sending shoppers to the product page. That was honest and it was worse: the
 * one surface a shopper meets on the collection grid could not sell the thing
 * it was showing them.
 *
 * ── WHAT IT OWNS AND WHAT IT DOES NOT ───────────────────────────────────────
 *
 * It owns the markup, the styles, the validation and the shape of the cart
 * line. It does NOT own the price: the server makes the chosen amount both the
 * price and the face value from one input, and this file sends that one input
 * and never a face value beside it. See functions/api/_cart-pricing.js.
 *
 * The styles are injected rather than living in a stylesheet because the hosts
 * do not share one — product.html carries its own inline CSS, and the panel
 * appears on four pages that do not. Every colour is a site token with a
 * fallback, so the block follows the theme on all of them.
 */
(function (w, d) {
  'use strict';
  if (w.ZWGiftCardBuy) return;

  var CAPS = { first: 50, last: 50, email: 120, message: 250 };
  /* The same shape functions/api/_cart-pricing.js accepts, and deliberately
     loose: this is an address a stranger typed for a friend, and a clever regex
     that refuses a valid unusual address costs a sale to prove a point. */
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function money(cents) {
    return '$' + (Math.max(0, Number(cents) || 0) / 100).toFixed(2);
  }
  /* Chips say $25, not $25.00 — a row of trailing zeroes is noise on a control
     whose whole job is to be scanned. The full figure is printed as the price. */
  function moneyShort(cents) {
    var n = Math.max(0, Number(cents) || 0) / 100;
    return '$' + (Number.isInteger(n) ? String(n) : n.toFixed(2));
  }

  function is(product) {
    return Number(product && (product.gift_card_cents || product.giftCardCents)) > 0;
  }

  /* Whether a buyer may name their own figure, and between what. Store-wide,
     delivered on /api/stock beside the wording it governs. Defaults matter: an
     unread setting must never become permission for a customer to name a
     price. */
  function policy() {
    var cfg = (w.ZWCommerceConfig && w.ZWCommerceConfig.giftCards) || {};
    var min = Math.round(Number(cfg.minCents));
    var max = Math.round(Number(cfg.maxCents));
    return {
      customAmounts: cfg.customAmounts === true,
      minCents: Number.isFinite(min) && min > 0 ? min : 1000,
      maxCents: Number.isFinite(max) && max > 0 ? max : 50000,
    };
  }

  /* The amounts THIS card is sold in — per product, set in the admin product
     form. Empty is the ordinary state and means the card sells at its listed
     price, which is also what a store sees before migration 0035 has run. */
  function denominations(product) {
    var raw = product && (product.gift_card_denominations || product.giftCardDenominations);
    var out = [];
    (Array.isArray(raw) ? raw : []).forEach(function (v) {
      var cents = Math.round(Number(v));
      if (Number.isFinite(cents) && cents > 0 && out.indexOf(cents) === -1) out.push(cents);
    });
    out.sort(function (a, b) { return a - b; });
    /* Eight is a row that still reads as a row; the twenty-first would be off
       the bottom of a phone. */
    return out.slice(0, 8);
  }

  function msg(key) {
    try { return (w.ZWMessages && w.ZWMessages.get(key)) || ''; } catch (_) { return ''; }
  }

  var STYLE_ID = 'zwgc-styles';
  function mountStyles() {
    if (d.getElementById(STYLE_ID)) return;
    var css = [
      /* ── THE ONE PAIR A HOST HAS TO SUPPLY ──────────────────────────────
         A filled chip needs the surface's own ink and paper, and only the host
         knows what those are. The defaults here are the PAGE's pair, which is
         right on the product page and right in every built-in theme — but the
         quick-add panel paints itself from --ink/--paper, and the note beside
         that panel's alpha ladder is explicit that an imported theme is free to
         set those apart from the page. That is the same class of mistake
         theme-tokens.test.js catches: a value keyed to the page, used on a
         panel, resolving against the wrong foreground.

         So the pair is a variable the panels override, and everything else in
         this file stays keyed to `currentColor` — which is always whatever
         surface the block was actually dropped onto. */
      '.zwgc{display:block;',
      '  --zwgc-on-fg:rgb(var(--fg-rgb,244 241 235));',
      '  --zwgc-on-bg:rgb(var(--bg-rgb,9 9 11))}',
      '.zwgc-sec{margin:0 0 1.4rem}',
      '.zwgc-sec:last-child{margin-bottom:0}',
      '.zwgc-label{font-family:var(--fm,monospace);font-size:.62rem;letter-spacing:.14em;',
      '  text-transform:uppercase;opacity:.72;margin:0 0 .7rem}',
      '.zwgc-copy{font-size:.85rem;line-height:1.7;opacity:.7;max-width:46ch;margin:-.3rem 0 1rem}',

      /* The chips. Bordered, filled when chosen — the same treatment the size
         buttons get, written out here because the hosts do not share a
         stylesheet and .size-btn only exists on one of them. */
      '.zwgc-amounts{display:flex;flex-wrap:wrap;gap:.5rem}',
      '.zwgc-amt{flex:0 0 auto;min-width:88px;min-height:44px;display:inline-flex;',
      '  align-items:center;justify-content:center;padding:.5rem .85rem;cursor:pointer;',
      '  background:none;color:inherit;border:1px solid color-mix(in srgb, currentColor 22%, transparent);',
      '  font-family:var(--fm,monospace);font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;',
      '  font-variant-numeric:tabular-nums;transition:border-color .18s,background .18s,color .18s}',
      '.zwgc-amt:hover{border-color:color-mix(in srgb, currentColor 55%, transparent)}',
      /* ── THE SELECTED CHIP, AND WHY IT WAS BLANK ────────────────────────
         This was `background:currentColor` with the label inverted by
         `filter:invert(1); mix-blend-mode:difference`. Both halves worked
         exactly as specified and cancelled each other out: white text inverted
         to black, then differenced against the now-white background, came back
         white. A filled chip with an invisible label.

         Being clever here was the mistake. The site already has one honest
         answer for "the page's ink and the page's paper" — --fg-rgb and
         --bg-rgb, the pair theme-engine stamps and .zwf-modal already fills
         from — so the chip uses it: ink for the fill, paper for the label,
         correct in dark, light and super-light with no branch and nothing to
         cancel out. */
      '.zwgc-amt.is-on{background:var(--zwgc-on-fg);',
      '  border-color:var(--zwgc-on-fg);color:var(--zwgc-on-bg)}',
      '.zwgc-amt.is-on:hover{opacity:.9}',

      /* NOTHING HERE SIZES THE DIALOG THIS BLOCK IS SITTING IN. That was tried
         from this file — a marker class stamped on the nearest panel shell and
         an !important width injected alongside these rules — and half of it
         silently did nothing while the other half only moved the empty space
         around. A form asking for more than the pane beside it is what a
         scrolling pane is for, and each panel sets that up in its own
         stylesheet, where every other rule about its shape already lives. */

      '.zwgc-custom{margin-top:.8rem}',
      '.zwgc-custom[hidden]{display:none}',
      '.zwgc-money{display:flex;align-items:center;gap:.45rem}',
      '.zwgc-money-sym{font-family:var(--fm,monospace);font-size:.95rem;opacity:.55;flex:0 0 auto}',

      '.zwgc-field{display:flex;flex-direction:column;gap:.4rem;margin-bottom:.85rem;min-width:0}',
      '.zwgc-grid{display:grid;grid-template-columns:1fr 1fr;gap:.85rem}',
      '@media(max-width:560px){.zwgc-grid{grid-template-columns:1fr;gap:0}}',
      '.zwgc-flabel{font-family:var(--fm,monospace);font-size:.58rem;letter-spacing:.12em;',
      '  text-transform:uppercase;opacity:.65}',
      '.zwgc-opt{opacity:.6;letter-spacing:.06em}',
      '.zwgc-in{width:100%;box-sizing:border-box;background:color-mix(in srgb, currentColor 5%, transparent);',
      '  border:1px solid color-mix(in srgb, currentColor 20%, transparent);color:inherit;',
      '  padding:.72rem .8rem;font-family:var(--fb,inherit);font-size:max(16px,.88rem);',
      '  border-radius:2px;outline:none;transition:border-color .2s,background .2s;-webkit-appearance:none;appearance:none}',
      '.zwgc-in:focus{border-color:color-mix(in srgb, currentColor 60%, transparent);',
      '  background:color-mix(in srgb, currentColor 9%, transparent)}',
      '.zwgc-in::placeholder{opacity:.4}',
      '.zwgc-ta{min-height:5.2rem;resize:vertical;line-height:1.6}',
      /* The spinners crowd a money field and add nothing a keyboard does not. */
      '.zwgc-in[type=number]::-webkit-outer-spin-button,',
      '.zwgc-in[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}',
      '.zwgc-in[type=number]{-moz-appearance:textfield;appearance:textfield}',

      '.zwgc-count{display:flex;justify-content:space-between;gap:1rem;margin:.1rem 0 0;',
      '  font-family:var(--fm,monospace);font-size:.58rem;letter-spacing:.06em;opacity:.55}',
      '.zwgc-count b{font-weight:400;font-variant-numeric:tabular-nums;flex:0 0 auto}',
      '.zwgc-err{font-family:var(--fb,inherit);font-size:.82rem;line-height:1.5;margin:.3rem 0 0;',
      '  color:var(--zw-accent,#F891A5)}',
      '.zwgc-err:empty{display:none}',
    ].join('');
    var el = d.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    d.head.appendChild(el);
  }

  /* ── THE ONE PLACE A RECIPIENT IS READ AND JUDGED ─────────────────────────
     Capped here and again on the server, which is the one that counts — this
     copy exists so the refusal lands beside the field instead of at the till. */
  function readRecipient(root) {
    var val = function (sel, cap) {
      var el = root.querySelector(sel);
      return String((el && el.value) || '').trim().slice(0, cap);
    };
    var first = val('[data-zwgc="first"]', CAPS.first);
    var last = val('[data-zwgc="last"]', CAPS.last);
    var email = val('[data-zwgc="email"]', CAPS.email);
    var message = val('[data-zwgc="message"]', CAPS.message);
    if (!email && !first && !last && !message) return null;
    return { first: first, last: last, email: email, message: message };
  }

  function problemWith(to) {
    if (!to || !to.email) return { text: msg('giftCardNeedEmail'), focus: 'email' };
    if (!EMAIL_RE.test(to.email)) return { text: msg('giftCardBadEmail'), focus: 'email' };
    if (!to.first) return { text: msg('giftCardNeedName'), focus: 'first' };
    return null;
  }

  /**
   * Draw the block into `host` and return a controller.
   *
   * opts.onCustom — called instead of showing the inline amount field, for a
   *   host that has its own way of asking (the product page's dialog). It is
   *   handed a `commit(cents)` so the BOUNDS still live here: a host that both
   *   collected the number and judged it would be the second implementation
   *   this module exists to prevent.
   * opts.onChange — fired whenever the chosen amount changes, so a host can
   *   repaint its own price.
   */
  function mount(host, product, opts) {
    if (!host) return null;
    mountStyles();
    var options = opts || {};
    var list = denominations(product);
    var pol = policy();
    var faceCents = Math.round(Number(product && (product.current_price || product.price)) * 100) || 0;
    var chosen = 0;

    /* The hook each host's own stylesheet sizes itself off, via :has(.zwgc). */
    host.classList.add('zwgc');
    host.innerHTML =
      (list.length || pol.customAmounts ? (
        '<div class="zwgc-sec">'
        + '<p class="zwgc-label">Amount</p>'
        + '<div class="zwgc-amounts" role="group" aria-label="Gift card amount">'
        + list.map(function (c) {
          return '<button type="button" class="zwgc-amt" data-cents="' + c + '"><span>'
            + esc(moneyShort(c)) + '</span></button>';
        }).join('')
        + (pol.customAmounts
          ? '<button type="button" class="zwgc-amt" data-zwgc="custom"><span>Custom</span></button>'
          : '')
        + '</div>'
        + '<div class="zwgc-custom" data-zwgc="custombox" hidden>'
        + '<div class="zwgc-money">'
        + '<span class="zwgc-money-sym" aria-hidden="true">$</span>'
        + '<input type="number" class="zwgc-in" data-zwgc="customamount" inputmode="decimal" step="1"'
        + ' aria-label="Gift card amount" placeholder="' + esc(String(Math.round(pol.minCents / 100))) + '">'
        + '</div>'
        + '<p class="zwgc-count"><span>Any amount between ' + esc(money(pol.minCents))
        + ' and ' + esc(money(pol.maxCents)) + '.</span></p>'
        + '</div>'
        + '</div>'
      ) : '')
      + '<div class="zwgc-sec">'
      + '<p class="zwgc-label">Send to</p>'
      + '<p class="zwgc-copy" data-zwgc="intro"></p>'
      + '<div class="zwgc-grid">'
      + '<div class="zwgc-field"><label class="zwgc-flabel">First name</label>'
      + '<input type="text" class="zwgc-in" data-zwgc="first" maxlength="' + CAPS.first + '" autocomplete="given-name"></div>'
      + '<div class="zwgc-field"><label class="zwgc-flabel">Last name</label>'
      + '<input type="text" class="zwgc-in" data-zwgc="last" maxlength="' + CAPS.last + '" autocomplete="family-name"></div>'
      + '</div>'
      + '<div class="zwgc-field"><label class="zwgc-flabel">Their email</label>'
      + '<input type="email" class="zwgc-in" data-zwgc="email" maxlength="' + CAPS.email + '" inputmode="email" autocomplete="off"></div>'
      + '<div class="zwgc-field"><label class="zwgc-flabel">Add a message <span class="zwgc-opt">optional</span></label>'
      + '<textarea class="zwgc-in zwgc-ta" data-zwgc="message" maxlength="' + CAPS.message + '" rows="3"></textarea>'
      + '<p class="zwgc-count"><span data-zwgc="hint"></span><b><span data-zwgc="count">0</span>/' + CAPS.message + '</b></p>'
      + '</div>'
      + '<p class="zwgc-err" data-zwgc="error" role="alert"></p>'
      + '</div>';

    var q = function (sel) { return host.querySelector('[data-zwgc="' + sel + '"]'); };
    var customBtn = q('custom');
    var customBox = q('custombox');
    var customInput = q('customamount');
    var errEl = q('error');

    function paintCopy() {
      var intro = q('intro');
      var hint = q('hint');
      if (intro) intro.textContent = msg('giftCardSendTo');
      if (hint) hint.textContent = msg('giftCardMessageHint');
    }

    function paint() {
      var onAChip = false;
      host.querySelectorAll('.zwgc-amt[data-cents]').forEach(function (b) {
        var c = Number(b.dataset.cents) || 0;
        var on = c > 0 && c === chosen;
        if (on) onAChip = true;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      if (customBtn) {
        var customOn = chosen > 0 && !onAChip;
        customBtn.classList.toggle('is-on', customOn);
        customBtn.setAttribute('aria-pressed', customOn ? 'true' : 'false');
        var lbl = customBtn.querySelector('span');
        if (lbl) lbl.textContent = customOn ? moneyShort(chosen) : 'Custom';
      }
      if (typeof options.onChange === 'function') options.onChange(chosen);
    }

    /* THE BOUNDS LIVE HERE, whoever collected the number. Refused rather than
       clamped up: quietly raising somebody's figure charges more than the page
       showed, which the server's price guard then rejects as a price change —
       telling a shopper their price moved when what happened is that we
       rewrote their instruction. */
    function commit(cents) {
      var c = Math.round(Number(cents) || 0);
      if (!Number.isFinite(c) || c <= 0) return { ok: false, error: 'Enter an amount.' };
      if (c < pol.minCents || c > pol.maxCents) {
        return { ok: false, error: 'Please choose between ' + money(pol.minCents) + ' and ' + money(pol.maxCents) + '.' };
      }
      chosen = c;
      paint();
      return { ok: true, cents: c };
    }

    host.querySelectorAll('.zwgc-amt[data-cents]').forEach(function (b) {
      b.addEventListener('click', function () {
        chosen = Number(b.dataset.cents) || 0;
        if (customBox) customBox.hidden = true;
        paint();
      });
    });

    if (customBtn) {
      customBtn.addEventListener('click', function () {
        /* A host with its own dialog gets to use it; everyone else gets the
           inline field. Either way `commit` is the only thing that decides
           whether a number is allowed. */
        if (typeof options.onCustom === 'function') { options.onCustom(commit, pol, chosen || faceCents); return; }
        if (!customBox) return;
        customBox.hidden = false;
        if (customInput) {
          if (!customInput.value) customInput.value = String(Math.round((chosen || faceCents) / 100));
          customInput.focus();
          customInput.select();
        }
      });
    }

    if (customInput) {
      customInput.addEventListener('input', function () {
        var dollars = parseFloat(customInput.value);
        if (!Number.isFinite(dollars) || dollars <= 0) return;
        var r = commit(Math.round(dollars * 100));
        /* Said as they type, and not as a refusal that only appears after they
           have committed to a number. */
        if (errEl) errEl.textContent = r.ok ? '' : r.error;
      });
    }

    /* Typing anywhere clears a refusal about this block: leaving it up while
       somebody fixes the thing it names reads as a second, unfixed problem. */
    host.addEventListener('input', function (e) {
      var t = e.target;
      if (t && t.dataset && t.dataset.zwgc === 'message') {
        var c = q('count');
        if (c) c.textContent = String((t.value || '').length);
      }
      if (errEl && t !== customInput) errEl.textContent = '';
    });

    /* SOMETHING IS ALWAYS CHOSEN once chips exist — otherwise the line goes in
       at the catalogue price while the row shows nothing selected, and the
       shopper is charged a figure that appears on none of the buttons. */
    if (list.length) chosen = list.indexOf(faceCents) > -1 ? faceCents : list[0];
    paintCopy();
    paint();
    try {
      if (w.ZWMessages && w.ZWMessages.subscribe) w.ZWMessages.subscribe(paintCopy);
    } catch (_) {}

    return {
      amountCents: function () { return chosen; },
      recipient: function () { return readRecipient(host); },
      /** The refusal, or null. Focuses the box it names. */
      problem: function () {
        var p = problemWith(readRecipient(host));
        if (!p) { if (errEl) errEl.textContent = ''; return null; }
        if (errEl) errEl.textContent = p.text;
        var el = q(p.focus);
        if (el) { el.focus(); try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {} }
        return p;
      },
      /** The gift-card half of a cart line. Never a face value — see the header. */
      applyTo: function (line) {
        var to = readRecipient(host);
        line.giftCardCents = Number(product.gift_card_cents || product.giftCardCents) || 0;
        /* A gift card is a code in an email. Half a pound of parcel weight on
           one is a real USPS rate quoted against something that does not ship. */
        line.weightLb = 0;
        line.size = '';
        if (chosen > 0) {
          line.customAmountCents = chosen;
          /* The displayed price follows the choice, because the till refuses to
             charge more than the cart says it showed. */
          line.price = chosen / 100;
        }
        if (to) line.giftCardTo = to;
        return line;
      },
      setAmount: function (cents) { return commit(cents); },
      destroy: function () { host.innerHTML = ''; host.classList.remove('zwgc'); },
    };
  }

  w.ZWGiftCardBuy = {
    is: is,
    policy: policy,
    denominations: denominations,
    money: money,
    moneyShort: moneyShort,
    mount: mount,
    CAPS: CAPS,
  };
})(window, document);
