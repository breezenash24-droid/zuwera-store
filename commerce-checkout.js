(function () {
  const STATE = {
    config: null,
    promotion: null,
    code: '',
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
    // Respect the show_promo_code config flag (default: show)
    if (STATE.config && STATE.config.show_promo_code === false) return;

    const { host } = getSummaryNodes();
    if (!host || host.querySelector('#zw-promo-shell')) return;

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

    const totalRow = host.querySelector('.stotal, .total');
    if (totalRow) {
      totalRow.parentNode.insertBefore(shell, totalRow);
    } else {
      host.appendChild(shell);
    }

    const discountRow = document.createElement('div');
    discountRow.id = 'zw-promo-row';
    discountRow.className = totalRow?.className || 'srow';
    discountRow.style.display = 'none';
    discountRow.innerHTML = '<span>Discount</span><span id="zw-promo-discount">-$0.00</span>';
    if (totalRow) totalRow.parentNode.insertBefore(discountRow, totalRow);

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
    if (message) {
      message.textContent = STATE.promotion
        ? `${STATE.promotion.label || STATE.promotion.code} applied.`
        : (STATE.code ? 'Promo code not active for this cart.' : '');
    }
    nodes.tax.textContent = formatMoney(taxCents);
    nodes.total.textContent = subtotalCents ? formatMoney(totalCents) : '-';
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

  function wrapGlobalPost() {
    const original = window.post;
    if (typeof original !== 'function' || original.__zwPromoWrapped) return;
    const wrapped = async function (url, body) {
      const nextBody = url === '/api/create-payment-intent'
        ? { ...(body || {}), promoCode: currentPromoCode() }
        : body;
      return original.call(this, url, nextBody);
    };
    wrapped.__zwPromoWrapped = true;
    window.post = wrapped;
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

  function observeSummary() {
    const nodes = getSummaryNodes();
    [nodes.subtotal, nodes.shipping, nodes.tax].filter(Boolean).forEach((node) => {
      new MutationObserver(() => renderPromoSummary()).observe(node, { childList: true, subtree: true, characterData: true });
    });
  }

  function init() {
    wrapGlobalPost();
    wrapWalletHelpers();
    observeSummary();
    // Load config first — ensurePromoUi checks show_promo_code flag
    loadConfig().then(() => {
      ensurePromoUi();
      renderPromoSummary();
    }).catch(() => {
      ensurePromoUi(); // fallback: show promo UI even if config fails
      renderPromoSummary();
    });
  }

  window.zwGetActivePromoCode = currentPromoCode;
  window.zwGetPromoDiscountCents = function (subtotalCents, shippingCents) {
    return computeDiscountCents(STATE.promotion, Number(subtotalCents || 0), Number(shippingCents || 0));
  };

  document.addEventListener('DOMContentLoaded', init);
})();
