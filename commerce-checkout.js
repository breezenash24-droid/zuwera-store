(function () {
  const STATE = {
    config: null,
    promotion: null,
    code: '',
    autoRef: '',       // referral code from a /?ref= link, auto-applied when the summary is ready
    autoApplying: false,
  };

  function parseMoney(text) {
    const normalized = String(text || '').trim();
    if (/^free$/i.test(normalized)) return 0;
    return Math.round((parseFloat(normalized.replace(/[^0-9.]/g, '')) || 0) * 100);
  }

  function formatMoney(cents) {
    return `$${(Math.max(0, Number(cents || 0)) / 100).toFixed(2)}`;
  }

  function currentPromoCode() {
    return String(STATE.code || '').trim().toUpperCase();
  }

  // Prefill a friend's referral code (captured to localStorage from /?ref=CODE by
  // nav-menu.js) into the promo box and arm the auto-apply. MUST run for the STATIC
  // promo box too (checkout.html / bag.html): those pages ship the box in their
  // HTML, so ensurePromoUi() takes the early-return branch and never reached the
  // injected-only prefill — the code never followed the shopper to checkout.
  function prefillRef(root) {
    try {
      const ref = localStorage.getItem('zw_ref');
      if (!ref) return;
      const input = (root || document).querySelector('#zw-promo-input');
      if (input && !input.value) { input.value = ref; STATE.autoRef = String(ref).trim().toUpperCase(); }
    } catch (_) {}
  }

  function getSummaryNodes() {
    return {
      subtotal: document.getElementById('summary-subtotal'),
      shipping: document.getElementById('summary-shipping'),
      tax: document.getElementById('summary-tax'),
      total: document.getElementById('summary-total'),
      host: document.querySelector('.csummary') || document.querySelector('.cart-summary'),
    };
  }

  function ensurePromoUi() {
    if (STATE.config && STATE.config.show_promo_code === false) {
      const shell = document.getElementById('zw-promo-shell');
      if (shell) shell.style.display = 'none';
      return;
    }

    // If the shell is already in the DOM (static HTML or previously injected), just wire the button.
    const existing = document.getElementById('zw-promo-shell');
    if (existing) {
      const btn = document.getElementById('zw-promo-apply');
      if (btn && !btn.__zwWired) {
        btn.addEventListener('click', applyPromoFromInput);
        btn.__zwWired = true;
      }
      prefillRef();   // static promo box (checkout.html/bag.html) — carry the referral code here too
      return;
    }

    // Injection fallback for pages that don't have static promo HTML.
    const { host } = getSummaryNodes();
    if (!host) return;

    const shell = document.createElement('div');
    shell.id = 'zw-promo-shell';
    shell.style.cssText = 'margin:0.8rem 0 0.2rem;display:flex;flex-direction:column;gap:0.4rem;';
    shell.innerHTML = `
      <div style="display:flex;gap:0.5rem;align-items:stretch;">
        <input id="zw-promo-input" type="text" placeholder="PROMO CODE"
          style="flex:1;background:rgba(244,241,235,.04);border:1px solid rgba(244,241,235,.1);color:inherit;padding:.5rem .75rem;font-family:var(--fm,inherit);font-size:.66rem;letter-spacing:.1em;text-transform:uppercase;outline:none;transition:border-color .2s;">
        <button id="zw-promo-apply" type="button"
          style="border:1px solid rgba(244,241,235,.2);background:transparent;color:inherit;padding:.5rem .9rem;font-family:var(--fm,inherit);font-size:.6rem;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;white-space:nowrap;transition:border-color .2s,opacity .2s;">Apply</button>
      </div>
      <div id="zw-promo-message" style="font-family:var(--fm,inherit);font-size:.62rem;color:rgba(244,241,235,.5);letter-spacing:.03em;min-height:.9rem;"></div>
    `;

    // Arrived from a friend's referral link (?ref=CODE)? Prefill from the shell we
    // just built (before it's in the DOM) — still validated server-side like any
    // other promo; this only saves typing.
    prefillRef(shell);

    const summary = host.closest('.cart-summary') || document.querySelector('.cart-summary');
    const totalRow = host.querySelector('.stotal, .total')
      || summary?.querySelector('.stotal, .summary-row.total, .total');
    if (totalRow) {
      totalRow.parentNode.insertBefore(shell, totalRow);
    } else {
      host.appendChild(shell);
    }

    const discountRow = document.createElement('div');
    discountRow.id = 'zw-promo-row';
    discountRow.className = totalRow?.className?.replace(/\btotal\b/g, '').trim()
      || (summary ? 'summary-row' : 'srow');
    discountRow.style.display = 'none';
    discountRow.innerHTML = '<span>Discount</span><span id="zw-promo-discount">-$0.00</span>';
    if (totalRow) {
      totalRow.parentNode.insertBefore(discountRow, totalRow);
    } else {
      host.appendChild(discountRow);
    }

    document.getElementById('zw-promo-apply')?.addEventListener('click', applyPromoFromInput);
  }

  async function loadConfig() {
    if (STATE.config) return STATE.config;
    const resp = await fetch('/api/commerce-config').catch(() => null);
    const payload = await resp?.json().catch(() => ({}));
    STATE.config = payload?.config || { promotions: [] };
    return STATE.config;
  }

  function findPromotion(code, subtotalCents, shippingCents) {
    const promotions = Array.isArray(STATE.config?.promotions) ? STATE.config.promotions : [];
    const normalized = String(code || '').trim().toUpperCase();
    return promotions.find((promotion) => {
      if (String(promotion.code || '').toUpperCase() !== normalized) return false;
      const minSubtotalCents = Math.round(Number(promotion.minSubtotal || 0) * 100);
      if (subtotalCents < minSubtotalCents) return false;
      if (promotion.type === 'shipping' && shippingCents <= 0) return false;
      return true;
    }) || null;
  }

  function computeDiscountCents(promotion, subtotalCents, shippingCents) {
    if (!promotion) return 0;
    const value = Number(promotion.value || 0);
    if (promotion.type === 'percent') return Math.max(0, Math.min(subtotalCents, Math.round(subtotalCents * (value / 100))));
    if (promotion.type === 'fixed') return Math.max(0, Math.min(subtotalCents, Math.round(value * 100)));
    if (promotion.type === 'shipping') return Math.max(0, Math.min(shippingCents, Math.round(value * 100) || shippingCents));
    return 0;
  }

  function getCheckoutStateCode() {
    const stateField = document.getElementById('pay-state');
    const fallback = String(stateField?.value || '').trim().toUpperCase();
    if (typeof window.getCheckoutTaxStateCode === 'function') {
      return window.getCheckoutTaxStateCode(fallback) || '';
    }
    return fallback;
  }

  function getSummaryTaxCents(subtotalCents, discountCents, fallbackTaxCents) {
    const discountedSubtotalCents = Math.max(0, subtotalCents - discountCents);
    if (typeof window.getWalletTaxCents === 'function') {
      return Math.max(0, Number(window.getWalletTaxCents(discountedSubtotalCents, getCheckoutStateCode()) || 0));
    }
    return Math.max(0, Number(fallbackTaxCents || 0));
  }

  function renderPromoSummary() {
    ensurePromoUi();
    const nodes = getSummaryNodes();
    if (!nodes.subtotal || !nodes.tax || !nodes.total) return;

    const subtotalCents = parseMoney(nodes.subtotal.textContent);
    const shippingCents = parseMoney(nodes.shipping?.textContent || '');
    const discountCents = computeDiscountCents(STATE.promotion, subtotalCents, shippingCents);
    const taxCents = getSummaryTaxCents(subtotalCents, discountCents, parseMoney(nodes.tax.textContent));
    const totalCents = Math.max(0, Math.max(0, subtotalCents - discountCents) + shippingCents + taxCents);

    const row = document.getElementById('zw-promo-row');
    const value = document.getElementById('zw-promo-discount');
    const message = document.getElementById('zw-promo-message');
    if (row && value) {
      row.style.display = discountCents > 0 ? 'flex' : 'none';
      value.textContent = `-${formatMoney(discountCents)}`;
    }
    // Bag page has its own visible summary card; the checkout modal's #zw-promo-row
    // isn't shown there, so a referral/promo discount was a silent total change.
    // Populate a dedicated bag-card row (labelled with the code) so it's obvious.
    const bagRow = document.getElementById('bag-discount-row');
    if (bagRow) {
      const bagVal = document.getElementById('bag-discount-value');
      const bagLbl = document.getElementById('bag-discount-label');
      bagRow.style.display = discountCents > 0 ? '' : 'none';
      if (bagVal) bagVal.textContent = `-${formatMoney(discountCents)}`;
      if (bagLbl) bagLbl.textContent = (discountCents > 0 && currentPromoCode()) ? `Discount · ${currentPromoCode()}` : 'Discount';
    }
    if (message) {
      message.textContent = STATE.promotion
        ? `${STATE.promotion.label || STATE.promotion.code} applied.`
        : (STATE.code ? 'Promo code not active for this cart.' : '');
    }
    const nextTaxText = formatMoney(taxCents);
    const nextTotalText = subtotalCents ? formatMoney(totalCents) : '-';
    if (nodes.tax.textContent !== nextTaxText) nodes.tax.textContent = nextTaxText;
    if (nodes.total.textContent !== nextTotalText) nodes.total.textContent = nextTotalText;
  }

  // A friend arriving from /?ref=CODE gets the code prefilled — but prefilling the
  // input does NOT set STATE.code, so without this the referral discount was never
  // sent to create-payment-intent and they paid full price (the "link doesn't apply
  // the discount" bug). Auto-apply it once the summary has a subtotal (findPromotion
  // needs one to clear the minimum), retrying via the summary observer as the cart
  // loads. Stops as soon as a promotion is applied or the shopper edits the field.
  function tryAutoApplyRef() {
    if (STATE.promotion || STATE.autoApplying || !STATE.autoRef) return;
    const input = document.getElementById('zw-promo-input');
    if (!input || String(input.value || '').trim().toUpperCase() !== STATE.autoRef) return;
    const nodes = getSummaryNodes();
    if (parseMoney(nodes.subtotal?.textContent || '') <= 0) return; // summary not ready yet
    STATE.autoApplying = true;
    applyPromoFromInput().finally(() => { STATE.autoApplying = false; });
  }

  async function applyPromoFromInput() {
    const input = document.getElementById('zw-promo-input');
    const message = document.getElementById('zw-promo-message');
    if (!input) return;
    await loadConfig();
    const nodes = getSummaryNodes();
    const subtotalCents = parseMoney(nodes.subtotal?.textContent || '');
    const shippingCents = parseMoney(nodes.shipping?.textContent || '');
    const promotion = findPromotion(input.value, subtotalCents, shippingCents);
    STATE.code = String(input.value || '').trim().toUpperCase();
    STATE.promotion = promotion;
    if (message && !promotion && STATE.code) {
      message.textContent = 'That promo is not available for this cart yet.';
    }
    renderPromoSummary();
  }

  /* Every endpoint that prices a cart, not just the Stripe one.
     The wrapper below used to test `url === '/api/create-payment-intent'`, and
     a literal like that is a decision made once about a world with one payment
     processor in it. Adding PayPal put a second endpoint on the other side of
     that comparison: a shopper with a promo code applied would get the discount
     on a card and not in the PayPal window, which is the sort of difference
     that reads as the code being invalid rather than as a bug here. */
  const PRICED_ENDPOINTS = [
    '/api/create-payment-intent',
    '/api/paypal-create-order',
    /* Capture re-quotes the cart and refuses if the total has moved, so it has
       to be handed the same promo the order was created with — otherwise the
       re-quote comes back higher than the approved amount and the buyer is
       told the price changed while they were paying. */
    '/api/paypal-capture',
  ];

  function wrapGlobalPost() {
    // Wrap BOTH checkout POST helpers: bag.html's inline `post` AND checkout.js's
    // global `postJSON` (the one that actually sends /api/create-payment-intent).
    // The original wrapper only covered `post`, which checkout.html doesn't even
    // define — so promoCode/featureFlags/deliveryMethod were never injected on
    // the card-payment path and campus hand-delivery charged normal shipping.
    ['post', 'postJSON'].forEach((name) => {
      const original = window[name];
      if (typeof original !== 'function' || original.__zwPromoWrapped) return;
      const wrapped = async function (url, body) {
        const nextBody = PRICED_ENDPOINTS.includes(url)
          ? { ...(body || {}),
              promoCode: currentPromoCode(),
              /* Only the CODE travels, never an amount — see the note above
                 SV. And only to the Stripe route: PayPal prices from
                 quoteCart() but has no hold, no capture and no release, so a
                 code sent there would be quoted against and then never spent.
                 The express buttons are hidden while a card is applied for the
                 same reason; when PayPal learns to hold, this gate and that one
                 come off together. */
              storedValueCode: url === '/api/create-payment-intent' ? SV.code : undefined,
              featureFlags: (typeof window.zwActiveFlags === 'function' ? window.zwActiveFlags() : undefined),
              deliveryMethod: (typeof window.zwDeliveryMethod === 'function' ? window.zwDeliveryMethod() : undefined),
              /* Where this order came from. Injected here rather than at each
                 call site because there are four of them — card, wallet, PayPal
                 create, PayPal capture — and the one that gets forgotten is the
                 one whose orders quietly look organic. That is exactly how
                 promoCode was broken before this wrapper covered postJSON.

                 Returns null when consent was declined; the server treats a
                 null the same as an absent field. */
              attribution: (window.zwAttribution ? window.zwAttribution.forOrder() : undefined) }
          : body;
        return original.call(this, url, nextBody);
      };
      wrapped.__zwPromoWrapped = true;
      window[name] = wrapped;
    });
  }

  function wrapWalletHelpers() {
    const totalFn = window.getWalletTotalCents;
    if (typeof totalFn === 'function' && !totalFn.__zwPromoWrapped) {
      const wrappedTotal = function (subtotalCents, shippingCents, stateCode) {
        const discountCents = computeDiscountCents(STATE.promotion, subtotalCents, shippingCents);
        const discountedSubtotal = Math.max(0, subtotalCents - discountCents);
        if (typeof window.getWalletTaxCents === 'function') {
          return Math.max(0, discountedSubtotal + Math.max(0, shippingCents || 0) + window.getWalletTaxCents(discountedSubtotal, stateCode));
        }
        const base = totalFn.call(this, subtotalCents, shippingCents, stateCode);
        return Math.max(0, base - discountCents);
      };
      wrappedTotal.__zwPromoWrapped = true;
      window.getWalletTotalCents = wrappedTotal;
    }

    const displayFn = window.getWalletDisplayItems;
    if (typeof displayFn === 'function' && !displayFn.__zwPromoWrapped) {
      const wrappedDisplay = function (subtotalCents, shippingCents, stateCode) {
        const discountCents = computeDiscountCents(STATE.promotion, subtotalCents, shippingCents);
        const discountedSubtotal = Math.max(0, subtotalCents - discountCents);
        if (typeof window.getWalletTaxCents === 'function') {
          const items = [
            { label: 'Subtotal', amount: Math.max(0, subtotalCents || 0) },
            { label: 'Shipping', amount: Math.max(0, shippingCents || 0) },
          ];
          if (discountCents > 0) items.splice(1, 0, { label: `Discount (${currentPromoCode()})`, amount: -discountCents });
          items.push({ label: 'Tax', amount: window.getWalletTaxCents(discountedSubtotal, stateCode) });
          return items;
        }
        const items = displayFn.call(this, subtotalCents, shippingCents, stateCode) || [];
        if (discountCents > 0) items.splice(1, 0, { label: `Discount (${currentPromoCode()})`, amount: -discountCents });
        return items;
      };
      wrappedDisplay.__zwPromoWrapped = true;
      window.getWalletDisplayItems = wrappedDisplay;
    }
  }

  /* ── GIFT CARDS AND STORE CREDIT ──────────────────────────────────────────
     One instrument, two names, and NOT a discount. A promo reduces what the
     order is worth; a gift card pays part of what it is worth. That difference
     is the whole reason this is a separate block rather than another branch in
     computeDiscountCents(): the total keeps its value, the tax keeps its base,
     and what changes is the amount due underneath.

     THE NUMBER SHOWN HERE IS AN ESTIMATE AND THE SERVER'S IS THE ONE THAT
     COUNTS. The balance came from /api/stored-value a moment ago; between then
     and the charge the same card can be spent in another tab. So the browser
     shows min(balance, total) and quoteCart() decides for real — and when the
     two disagree, create-payment-intent charges the card MORE, never less. The
     rule that keeps that safe lives on the server; this only has to avoid
     promising something it cannot deliver, which is why nothing here is ever
     sent as an amount. Only the code is sent. */
  const SV = { enabled: false, code: '', balanceCents: 0, kind: '', probed: false };

  function svNodes() {
    return {
      shell: document.getElementById('zw-sv-shell'),
      input: document.getElementById('zw-sv-input'),
      apply: document.getElementById('zw-sv-apply'),
      message: document.getElementById('zw-sv-message'),
      rows: document.getElementById('zw-sv-rows'),
      label: document.getElementById('zw-sv-row-label'),
      applied: document.getElementById('zw-sv-applied'),
      dueRow: document.getElementById('zw-sv-due-row'),
      due: document.getElementById('zw-sv-due'),
    };
  }

  /* checkout.html does NOT use the #summary-* ids getSummaryNodes() looks for —
     it has its own summary with #pm-* ids and its own three writers for them.
     Reading the wrong element here would have shown a $0 total, hidden the
     gift-card lines, and made a working card look like it did nothing. So the
     total is found by asking for both, in the order that puts the checkout
     page's own first. */
  function svTotalEl() {
    return document.getElementById('pm-total') || getSummaryNodes().total || null;
  }

  /* A total that is still waiting on tax or shipping is written as an em dash
     and marked `.dash` by checkout.js. parseMoney() reads that as zero, which
     is a number, and a gift card sized against it would claim to cover nothing.
     Waiting is the right answer until every part has arrived. */
  function svTotalCents() {
    const el = svTotalEl();
    if (!el || el.classList.contains('dash')) return 0;
    return parseMoney(el.textContent || '');
  }

  function svAppliedCents() {
    if (!SV.code || SV.balanceCents <= 0) return 0;
    const totalCents = svTotalCents();
    if (totalCents <= 0) return 0;
    return Math.min(SV.balanceCents, totalCents);
  }

  /* Applying a gift card takes the express buttons away, and says so.
     /api/create-payment-intent knows about stored value; PayPal and the wallet
     sheet do not. A shopper who applied a card and then tapped Apple Pay would
     be shown one total by the sheet and charged another by the intent — or,
     if the card covered everything, handed a payment sheet for an order the
     server had already completed. Hiding a control that would take the wrong
     amount is the honest version of "not built yet"; leaving it there and
     hoping is how a shopper pays twice. */
  const EXPRESS_IDS = ['payment-request-btn', 'express-checkout-btn', 'wallet-methods', 'paypal-button', 'pay-divider'];

  function svToggleExpress(hidden) {
    EXPRESS_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (hidden) {
        if (el.__zwSvHidden) return;
        /* Remembers what it was, because most of these are hidden already for
           their own reasons — an unconfigured PayPal, a browser with no wallet.
           Restoring them all to visible would show buttons that were never
           meant to be there. */
        el.__zwSvHidden = true;
        el.__zwSvPrev = el.style.display;
        el.style.display = 'none';
      } else if (el.__zwSvHidden) {
        el.style.display = el.__zwSvPrev || '';
        el.__zwSvHidden = false;
      }
    });
    let note = document.getElementById('zw-sv-express-note');
    if (hidden && !note) {
      const anchor = document.getElementById('pay-divider') || document.getElementById('paypal-button');
      if (anchor && anchor.parentNode) {
        note = document.createElement('p');
        note.id = 'zw-sv-express-note';
        note.style.cssText = 'font-size:.72rem;line-height:1.5;color:var(--sub,#8a8a8a);margin:0 0 1.2rem';
        note.textContent = 'Gift cards and store credit are paid with a card. Remove the card below to use PayPal or a wallet instead.';
        anchor.parentNode.insertBefore(note, anchor);
      }
    } else if (!hidden && note) {
      note.remove();
    }
  }

  function renderStoredValue() {
    const n = svNodes();
    if (!n.shell) return;
    n.shell.style.display = SV.enabled ? '' : 'none';
    if (!SV.enabled) return;

    const appliedCents = svAppliedCents();
    const totalCents = svTotalCents();

    /* ── APPLIED IS APPLIED, EVEN BEFORE THE TOTAL IS KNOWN ──────────────────
       These rows were shown only once appliedCents was above zero — and that is
       zero until shipping resolves, because a total still being worked out is
       written as an em dash and read as unknown rather than as nothing.

       So a shopper applied a card, saw the summary not mention it, and
       concluded it had not worked. Which is the reasonable conclusion: the one
       place a customer looks to check whether something took effect said
       nothing at all.

       The rows now appear the moment a code is accepted, and carry the same
       em dash the rest of the summary uses while it is waiting. Pending is a
       state this page already knows how to say. */
    const known = totalCents > 0;
    const applying = !!SV.code;

    if (n.rows) n.rows.style.display = applying ? '' : 'none';
    if (n.label) n.label.textContent = SV.kind === 'store_credit' ? 'Store credit' : 'Gift card';
    if (n.applied) n.applied.textContent = known ? `-${formatMoney(appliedCents)}` : '—';
    if (n.dueRow) n.dueRow.style.display = applying ? '' : 'none';
    if (n.due) n.due.textContent = known ? formatMoney(Math.max(0, totalCents - appliedCents)) : '—';
    if (n.apply) n.apply.textContent = SV.code ? 'Remove' : 'Apply';
    if (n.input) n.input.disabled = !!SV.code;

    /* Hidden as soon as a card is APPLIED, not once it covers something. PayPal
       and the wallet sheet cannot honour one at any amount, so the moment the
       shopper has committed to using it those buttons would charge the wrong
       number — whether or not the total has finished loading. */
    svToggleExpress(applying);

    if (n.message && SV.code) {
      /* ── "$0.00 OF IT COVERS THIS ORDER" WAS TRUE AND USELESS ──────────────
         A total still waiting on shipping is written as an em dash, and
         svTotalCents() correctly reports that as unknown rather than as zero.
         The message then did the arithmetic anyway and announced that a $50
         card covers nothing — which reads as a broken card, not as a total
         that has not finished loading. It was the single most confident
         sentence on the page about the one number nobody knew yet.

         So an unknown total gets said out loud. The balance is real and worth
         confirming — the code was checked against the server to get it — and
         what happens next is a promise the till will keep, not a figure. */
      if (totalCents <= 0) {
        n.message.textContent = `${formatMoney(SV.balanceCents)} on the card. It comes off once your total is worked out.`;
      } else {
        const left = Math.max(0, SV.balanceCents - appliedCents);
        n.message.textContent = left > 0
          ? `${formatMoney(SV.balanceCents)} on the card — ${formatMoney(appliedCents)} of it covers this order, ${formatMoney(left)} left over.`
          : `${formatMoney(SV.balanceCents)} on the card, all of it going to this order.`;
      }
      n.message.style.color = 'rgba(110,210,130,.9)';
    }
  }

  function svClear(message) {
    SV.code = '';
    SV.balanceCents = 0;
    SV.kind = '';
    const n = svNodes();
    if (n.input) { n.input.disabled = false; n.input.value = ''; }
    if (n.message) { n.message.textContent = message || ''; n.message.style.color = ''; }
    renderStoredValue();
  }

  async function applyStoredValueFromInput() {
    const n = svNodes();
    if (!n.input) return;
    if (SV.code) { svClear(''); return; }

    const code = String(n.input.value || '').trim().toUpperCase();
    if (!code) { if (n.message) { n.message.textContent = 'Enter the code from your gift card.'; n.message.style.color = ''; } return; }

    if (n.apply) n.apply.disabled = true;
    if (n.message) { n.message.textContent = 'Checking…'; n.message.style.color = ''; }
    try {
      const resp = await fetch('/api/stored-value', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const payload = await resp.json().catch(() => ({}));
      if (!payload || !payload.ok) {
        svClear(payload && payload.error ? payload.error : 'We could not check that just now. Please try again in a moment.');
        return;
      }
      SV.code = payload.code || code;
      SV.balanceCents = Number(payload.balanceCents) || 0;
      SV.kind = payload.kind || 'gift_card';
      renderStoredValue();
    } catch (_) {
      svClear('We could not check that just now. Please try again in a moment.');
    } finally {
      if (n.apply) n.apply.disabled = false;
    }
  }

  async function initStoredValue() {
    const n = svNodes();
    if (!n.shell || SV.probed) return;
    SV.probed = true;
    try {
      /* GET, not POST. The POST is rate limited at twenty an hour because it
         answers a question about a secret; spending those on "should this field
         exist" would lock a shopper out of checking their own balance after a
         few reloads. */
      const resp = await fetch('/api/stored-value');
      const payload = await resp.json().catch(() => ({}));
      SV.enabled = !!(payload && payload.enabled);
    } catch (_) {
      SV.enabled = false;
    }
    if (n.apply && !n.apply.__zwWired) {
      n.apply.addEventListener('click', applyStoredValueFromInput);
      n.apply.__zwWired = true;
    }
    if (n.input && !n.input.__zwWired) {
      n.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyStoredValueFromInput(); } });
      n.input.__zwWired = true;
    }
    renderStoredValue();
  }

  function observeSummary() {
    const nodes = getSummaryNodes();
    [nodes.subtotal, nodes.shipping, nodes.tax].filter(Boolean).forEach((node) => {
      new MutationObserver(() => { renderPromoSummary(); tryAutoApplyRef(); }).observe(node, { childList: true, subtree: true, characterData: true });
    });
    /* The total is watched separately: renderPromoSummary WRITES it, so a
       stored-value redraw hung off the same observers as the promo would either
       miss the change or chase its own tail. This one only reads. */
    const totalEl = svTotalEl();
    if (totalEl) {
      new MutationObserver(() => renderStoredValue())
        .observe(totalEl, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    }
  }

  function init() {
    wrapGlobalPost();
    wrapWalletHelpers();
    observeSummary();
    initStoredValue();
    // Load config first — ensurePromoUi checks show_promo_code flag
    loadConfig().then(() => {
      ensurePromoUi();
      renderPromoSummary();
      tryAutoApplyRef();
    }).catch(() => {
      ensurePromoUi(); // fallback: show promo UI even if config fails
      renderPromoSummary();
      tryAutoApplyRef();
    });
  }

  // Campus hand-delivery config (ZIP allow-list) for checkout.js.
  window.zwLocalDelivery = function () {
    const ld = STATE.config && STATE.config.localDelivery;
    return (ld && typeof ld === 'object') ? ld : { enabled: false, zips: [] };
  };

  window.zwGetActivePromoCode = currentPromoCode;
  /* checkout.js reads this to decide whether the order might come back already
     paid. It is the code, not the amount — the amount is the server's. */
  window.zwGetStoredValueCode = function () { return SV.code || ''; };
  window.zwClearStoredValue = function () { svClear(''); };
  window.zwGetPromoDiscountCents = function (subtotalCents, shippingCents) {
    return computeDiscountCents(STATE.promotion, Number(subtotalCents || 0), Number(shippingCents || 0));
  };

  document.addEventListener('DOMContentLoaded', init);
})();
