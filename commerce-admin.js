(function () {
  // ── Coupons / Promotions ──────────────────────────────────────────────────
  // The storefront's real discount engine. Promotions live in
  // site_settings.commerce_config.promotions — the exact record that
  // /api/validate-promo and the Stripe webhook (incrementPromoUsage) read.
  // This page edits ONLY that.
  //
  // It used to be an 8-tab "commerce hub" (orders, returns, inventory, CRM…),
  // but those tabs wrote to parallel settings blobs (commerce_order_ops,
  // commerce_returns, commerce_inventory) that the live store and fulfilment
  // never read — they duplicated the dedicated Receipts, Returns, Products, and
  // Users pages, which write to the real records. So it was narrowed to the one
  // feature that has no other home and actually drives checkout: coupons.

  const state = { config: { promotions: [], show_promo_code: true } };

  function $(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function ensureNavAndPage() {
    if ($('commerce')) return;
    const area = document.querySelector('.content-area');
    if (!area) return;
    const page = document.createElement('div');
    page.id = 'commerce';
    page.className = 'page';
    page.innerHTML = `
      <div class="products-header">
        <div>
          <h2>Coupons &amp; Promotions</h2>
          <p style="color:var(--text-secondary);font-size:14px;margin-top:4px;">Create percent-off, fixed-amount, or free-shipping codes that validate at checkout. Orders, returns, inventory, and customers each have their own page.</p>
        </div>
        <button class="btn btn-secondary" id="commerceRefreshBtn">Refresh</button>
      </div>
      <div id="commerceStatus" style="margin-bottom:18px;color:var(--text-secondary);font-size:13px;"></div>
      <div id="commerceMount"></div>
    `;
    area.appendChild(page);
  }

  function mountCommerceStyles() {
    if ($('commerce-admin-style')) return;
    const style = document.createElement('style');
    style.id = 'commerce-admin-style';
    style.textContent = `
      .commerce-card { background:var(--bg-secondary); border:1px solid var(--border); border-radius:10px; padding:20px; }
      .commerce-card h3 { margin-bottom:6px; }
      .commerce-muted { color:var(--text-secondary); font-size:13px; }
      .commerce-input-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
      .commerce-promo-item { background:var(--bg-secondary); border:1px solid var(--border); border-radius:10px; padding:16px; margin-bottom:14px; }
      .commerce-actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
    `;
    document.head.appendChild(style);
  }

  async function loadCommerceData() {
    if (!window.sb) throw new Error('Supabase client not available.');
    const { data, error } = await window.sb
      .from('site_settings').select('key,value').eq('key', 'commerce_config');
    if (error) throw error;
    const cfg = (data && data[0] && data[0].value) || {};
    // Preserve any other commerce_config fields so saving only touches promotions.
    state.config = {
      ...cfg,
      promotions: Array.isArray(cfg.promotions) ? cfg.promotions : [],
      show_promo_code: cfg.show_promo_code !== false,
    };
    renderCommerce();
  }

  function renderPromotions() {
    const promos = Array.isArray(state.config.promotions) ? state.config.promotions : [];
    const showPromo = state.config.show_promo_code !== false;
    return `
      <div class="commerce-card">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;">
          <div>
            <h3>Discount Engine</h3>
            <div class="commerce-muted">Create percent-off, fixed-dollar, or shipping promos that validate at checkout.</div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <label style="display:flex;align-items:center;gap:7px;font-size:.78rem;color:var(--text-muted);cursor:pointer;">
              <input type="checkbox" id="commerceShowPromoCode" ${showPromo ? 'checked' : ''}
                style="width:15px;height:15px;accent-color:var(--accent,#fff);cursor:pointer;">
              Show promo code field
            </label>
            <button class="btn btn-secondary btn-sm" id="commerceAddPromoBtn">+ Add Promo</button>
          </div>
        </div>
        <div id="commercePromoList" style="margin-top:14px;">
          ${promos.length ? promos.map((promo, index) => `
            <div class="commerce-promo-item" data-promo-index="${index}">
              <div class="commerce-input-grid">
                <div><label>Code</label><input class="form-input" data-field="code" value="${escapeHtml(promo.code || '')}"></div>
                <div><label>Label</label><input class="form-input" data-field="label" value="${escapeHtml(promo.label || '')}"></div>
                <div><label>Type</label>
                  <select class="form-select" data-field="type">
                    <option value="percent" ${promo.type === 'percent' ? 'selected' : ''}>Percent</option>
                    <option value="fixed" ${promo.type === 'fixed' ? 'selected' : ''}>Fixed amount</option>
                    <option value="shipping" ${promo.type === 'shipping' ? 'selected' : ''}>Shipping</option>
                  </select>
                </div>
                <div><label>Value</label><input class="form-input" data-field="value" type="number" value="${Number(promo.value || 0)}"></div>
                <div><label>Min subtotal</label><input class="form-input" data-field="minSubtotal" type="number" value="${Number(promo.minSubtotal || 0)}"></div>
                <div><label>Active</label>
                  <select class="form-select" data-field="active">
                    <option value="true" ${promo.active !== false ? 'selected' : ''}>Live</option>
                    <option value="false" ${promo.active === false ? 'selected' : ''}>Paused</option>
                  </select>
                </div>
              </div>
              <div style="margin-top:10px;">
                <label>Description</label>
                <input class="form-input" data-field="description" value="${escapeHtml(promo.description || '')}">
              </div>
              <div class="commerce-input-grid" style="margin-top:10px;">
                <div>
                  <label>Expiration Date</label>
                  <input class="form-input" data-field="expirationDate" type="date" value="${promo.expirationDate || ''}">
                </div>
                <div>
                  <label>Max Usage Limit</label>
                  <input class="form-input" data-field="maxUsage" type="number" placeholder="No limit" value="${promo.maxUsage !== undefined && promo.maxUsage !== null ? promo.maxUsage : ''}">
                </div>
                <div>
                  <label>Usage Count <span style="font-weight:400;opacity:.55;font-size:.8em">(Read-only)</span></label>
                  <input class="form-input" data-field="usageCount" type="number" readonly value="${promo.usageCount || 0}">
                </div>
              </div>
              <div class="commerce-input-grid" style="margin-top:10px;">
                <div>
                  <label>Target Product IDs <span style="font-weight:400;opacity:.55;font-size:.8em">(comma-separated — blank = all products)</span></label>
                  <input class="form-input" data-field="targetProductIds" value="${escapeHtml((Array.isArray(promo.targetProductIds) ? promo.targetProductIds : []).join(', '))}" placeholder="uuid1, uuid2, …">
                </div>
                <div>
                  <label>Target Collections <span style="font-weight:400;opacity:.55;font-size:.8em">(comma-separated — blank = all collections)</span></label>
                  <input class="form-input" data-field="targetCollectionIds" value="${escapeHtml((Array.isArray(promo.targetCollectionIds) ? promo.targetCollectionIds : []).join(', '))}" placeholder="drop001, jackets, …">
                </div>
              </div>
              <div class="commerce-actions"><button class="btn btn-danger btn-sm" data-remove-promo="${index}">Remove</button></div>
            </div>
          `).join('') : '<div class="commerce-muted">No promotions yet. Click "+ Add Promo" to create one.</div>'}
        </div>
        <div style="margin-top:16px;display:flex;justify-content:flex-end;">
          <button class="btn btn-primary" id="commerceSavePromosBtn">Save Promotions</button>
        </div>
      </div>
    `;
  }

  function renderCommerce() {
    mountCommerceStyles();
    const mount = $('commerceMount');
    if (!mount) return;
    mount.innerHTML = renderPromotions() + renderLocalDelivery();
    bindCommerceEvents();
  }

  function renderLocalDelivery() {
    const ld = (state.config && state.config.localDelivery) || {};
    const zips = Array.isArray(ld.zips) ? ld.zips.join(', ') : '';
    return `
      <div class="commerce-card" style="margin-top:16px;">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;">
          <div>
            <h3>🚶 Campus Hand-Delivery</h3>
            <div class="commerce-muted">Customers whose shipping ZIP is on this list can choose free in-person delivery instead of mail. Those orders skip the shipping label and tracking email.</div>
          </div>
          <label style="display:flex;align-items:center;gap:7px;font-size:.78rem;color:var(--text-muted);cursor:pointer;">
            <input type="checkbox" id="ldEnabled" ${ld.enabled ? 'checked' : ''} style="width:15px;height:15px;accent-color:var(--accent,#fff);cursor:pointer;">
            Enabled
          </label>
        </div>
        <div style="margin-top:14px;display:grid;gap:12px;">
          <div>
            <label class="commerce-muted" style="display:block;margin-bottom:5px;font-size:.75rem;">Eligible ZIP codes (comma or space separated, 5 digits each)</label>
            <textarea id="ldZips" rows="2" placeholder="45219, 45220, 45221, 45222, 45223" style="width:100%;box-sizing:border-box;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;padding:9px 12px;color:var(--text-primary);font-size:.85rem;font-family:'IBM Plex Mono',monospace;">${escapeHtml(zips)}</textarea>
          </div>
          <div>
            <label class="commerce-muted" style="display:block;margin-bottom:5px;font-size:.75rem;">Option label (shown at checkout)</label>
            <input id="ldLabel" type="text" value="${escapeAttr(ld.label || 'Campus hand-delivery')}" style="width:100%;box-sizing:border-box;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;padding:9px 12px;color:var(--text-primary);font-size:.85rem;">
          </div>
          <div>
            <label class="commerce-muted" style="display:block;margin-bottom:5px;font-size:.75rem;">Note to buyer (optional)</label>
            <input id="ldInstructions" type="text" value="${escapeAttr(ld.instructions || '')}" placeholder="You'll be contacted to arrange a campus drop-off." style="width:100%;box-sizing:border-box;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;padding:9px 12px;color:var(--text-primary);font-size:.85rem;">
          </div>
          <div style="display:flex;gap:10px;align-items:center;">
            <button class="btn btn-secondary btn-sm" id="ldSaveBtn">Save Campus Delivery</button>
            <span id="ldStatus" class="commerce-muted" style="font-size:.78rem;"></span>
          </div>
        </div>
      </div>`;
  }

  function readPromotionsFromDom() {
    return [...document.querySelectorAll('#commercePromoList .commerce-promo-item')].map((node) => {
      const maxUsageVal = node.querySelector('[data-field="maxUsage"]')?.value;
      return {
        code: node.querySelector('[data-field="code"]')?.value || '',
        label: node.querySelector('[data-field="label"]')?.value || '',
        type: node.querySelector('[data-field="type"]')?.value || 'percent',
        value: Number(node.querySelector('[data-field="value"]')?.value || 0),
        minSubtotal: Number(node.querySelector('[data-field="minSubtotal"]')?.value || 0),
        description: node.querySelector('[data-field="description"]')?.value || '',
        active: node.querySelector('[data-field="active"]')?.value !== 'false',
        expirationDate: node.querySelector('[data-field="expirationDate"]')?.value || '',
        maxUsage: maxUsageVal !== undefined && maxUsageVal !== null && maxUsageVal !== '' ? Number(maxUsageVal) : null,
        usageCount: Number(node.querySelector('[data-field="usageCount"]')?.value || 0),
        targetProductIds: String(node.querySelector('[data-field="targetProductIds"]')?.value || '').split(',').map((s) => s.trim()).filter(Boolean),
        targetCollectionIds: String(node.querySelector('[data-field="targetCollectionIds"]')?.value || '').split(',').map((s) => s.trim()).filter(Boolean),
      };
    }).filter((promo) => promo.code.trim());
  }

  // Returns an error string if any promo is invalid, or null if all are valid.
  function validatePromotions(promos) {
    for (const p of promos) {
      const code = (p.code || '').trim();
      if (p.value < 0) return `Promo "${code}" has a negative discount value.`;
      if (p.type === 'percent' && p.value > 100) return `Promo "${code}" is a percent discount over 100%.`;
      if ((p.type === 'percent' || p.type === 'fixed') && p.value === 0) return `Promo "${code}" has no discount value.`;
      if (p.minSubtotal < 0) return `Promo "${code}" has a negative minimum subtotal.`;
      if (p.maxUsage !== null && p.maxUsage < 0) return `Promo "${code}" has a negative usage limit.`;
    }
    return null;
  }

  function syncFromDom() {
    if ($('commercePromoList')) state.config.promotions = readPromotionsFromDom();
    const showPromoEl = $('commerceShowPromoCode');
    if (showPromoEl) state.config.show_promo_code = showPromoEl.checked;
    const ldEnabled = $('ldEnabled');
    if (ldEnabled) {
      state.config.localDelivery = {
        enabled: ldEnabled.checked,
        label: ($('ldLabel')?.value || 'Campus hand-delivery').trim(),
        instructions: ($('ldInstructions')?.value || '').trim(),
        zips: Array.from(new Set(String($('ldZips')?.value || '').split(/[\s,]+/).map((s) => s.trim()).filter((z) => /^\d{5}$/.test(z)))),
      };
    }
  }

  async function saveSettings(message) {
    const statusEl = $('commerceStatus');
    if (statusEl) statusEl.textContent = 'Saving…';
    syncFromDom();
    state.config.updatedAt = new Date().toISOString();
    const result = await window.sb
      .from('site_settings').upsert([{ key: 'commerce_config', value: state.config }], { onConflict: 'key' });
    if (result.error) {
      if (statusEl) statusEl.textContent = result.error.message || 'Could not save promotions.';
      return false;
    }
    if (statusEl) statusEl.textContent = message || 'Promotions saved.';
    return true;
  }

  function bindCommerceEvents() {
    $('ldSaveBtn')?.addEventListener('click', async () => {
      const st = $('ldStatus');
      if (st) st.textContent = 'Saving…';
      const ok = await saveSettings('Campus delivery saved.');
      if (st) st.textContent = ok ? 'Saved.' : 'Could not save.';
    });
    $('commerceAddPromoBtn')?.addEventListener('click', () => {
      syncFromDom();
      state.config.promotions = [
        ...(state.config.promotions || []),
        { code: '', label: '', type: 'percent', value: 10, minSubtotal: 0, description: '', active: true, expirationDate: '', maxUsage: null, usageCount: 0 },
      ];
      renderCommerce();
    });

    $('commerceSavePromosBtn')?.addEventListener('click', async () => {
      const btn = $('commerceSavePromosBtn');
      const orig = btn.textContent;
      syncFromDom();
      const promoErr = validatePromotions(state.config.promotions || []);
      if (promoErr) {
        const status = $('commerceStatus');
        if (status) status.textContent = promoErr;
        btn.textContent = 'Fix errors first';
        setTimeout(() => { btn.textContent = orig; }, 2600);
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Saving…';
      const ok = await saveSettings('Promotions saved.');
      btn.textContent = ok ? 'Saved ✓' : 'Error — try again';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2200);
    });

    document.querySelectorAll('[data-remove-promo]').forEach((button) => {
      button.addEventListener('click', () => {
        syncFromDom();
        state.config.promotions.splice(Number(button.dataset.removePromo), 1);
        renderCommerce();
      });
    });
  }

  function installNavigationHook() {
    const originalNavigateTo = window.navigateTo;
    if (typeof originalNavigateTo !== 'function' || originalNavigateTo.__commerceWrapped) return;
    window.navigateTo = function (page) {
      if (page === 'commerce') {
        document.querySelectorAll('.page').forEach((node) => node.classList.remove('active'));
        $('commerce')?.classList.add('active');
        document.querySelectorAll('.nav-link').forEach((node) => node.classList.remove('active'));
        document.querySelector('[data-page="commerce"]')?.classList.add('active');
        if ($('pageTitle')) $('pageTitle').textContent = 'Coupons';
        loadCommerceData().catch((error) => {
          const s = $('commerceStatus');
          if (s) s.textContent = error?.message || 'Could not load coupons.';
        });
        return;
      }
      return originalNavigateTo(page);
    };
    window.navigateTo.__commerceWrapped = true;
  }

  function bindGlobalButtons() {
    $('commerceRefreshBtn')?.addEventListener('click', () => loadCommerceData().catch((error) => {
      const s = $('commerceStatus');
      if (s) s.textContent = error?.message || 'Could not refresh coupons.';
    }));
  }

  document.addEventListener('DOMContentLoaded', () => {
    ensureNavAndPage();
    mountCommerceStyles();
    installNavigationHook();
    bindGlobalButtons();
  });
})();
