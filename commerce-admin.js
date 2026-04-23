(function () {
  const SETTINGS_KEYS = ['commerce_config', 'commerce_returns', 'commerce_order_ops', 'commerce_customer_profiles', 'commerce_inventory'];
  const DEFAULT_INVENTORY = {
    locations: [
      { id: 'main', name: 'Main Warehouse', code: 'MAIN', type: 'warehouse', priority: 1, active: true },
    ],
    variantOverrides: {},
    history: [],
    automation: {
      enabled: true,
      defaultThreshold: 8,
      alertEmail: '',
      alertSms: '',
      alertWebhook: '',
      autoReserveAtCheckout: true,
    },
  };
  const state = {
    config: {
      promotions: [],
      integrations: {},
      shippingAutomation: {},
      customerExperience: {},
      returnsPolicy: {},
      loyalty: {},
      subscriptions: {},
      affiliates: {},
      merchandising: {},
    },
    returnsState: { requests: [] },
    orderOps: {},
    customerProfiles: {},
    inventory: structuredClone(DEFAULT_INVENTORY),
    orders: [],
    profiles: [],
    products: [],
    productSizes: [],
    edgeMetrics: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function money(value) {
    return '$' + (Number(value || 0)).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function numberOr(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function defaultInventoryState() {
    return structuredClone(DEFAULT_INVENTORY);
  }

  function sanitizeInventoryState(rawInventory) {
    const inventory = rawInventory && typeof rawInventory === 'object' ? rawInventory : {};
    const defaults = defaultInventoryState();
    const locations = Array.isArray(inventory.locations) ? inventory.locations : [];
    const normalizedLocations = locations
      .filter((location) => location && (location.id || location.name || location.code))
      .map((location, index) => ({
        id: String(location.id || `location-${index + 1}`).trim(),
        name: String(location.name || location.code || `Location ${index + 1}`).trim(),
        code: String(location.code || location.name || `LOC${index + 1}`).trim().toUpperCase(),
        type: String(location.type || 'warehouse').trim(),
        priority: numberOr(location.priority, index + 1),
        active: location.active !== false,
      }));

    return {
      locations: normalizedLocations.length ? normalizedLocations : defaults.locations,
      variantOverrides: inventory.variantOverrides && typeof inventory.variantOverrides === 'object' ? inventory.variantOverrides : {},
      history: Array.isArray(inventory.history) ? inventory.history.slice(0, 250) : [],
      automation: {
        ...defaults.automation,
        ...(inventory.automation && typeof inventory.automation === 'object' ? inventory.automation : {}),
      },
    };
  }

  function orderTotal(order) {
    return Number(order.total || order.total_amount || 0);
  }

  function parseOrderItems(order) {
    if (!order?.items) return [];
    if (Array.isArray(order.items)) return order.items;
    try {
      return JSON.parse(order.items);
    } catch (_) {
      return [];
    }
  }

  function getSettingValue(rows, key, fallback) {
    return rows.find((row) => row.key === key)?.value ?? fallback;
  }

  function ensureNavAndPage() {
    if ($('commerce')) return;
    const analyticsLink = document.querySelector('[data-page="analytics"]');
    if (analyticsLink?.parentNode && !document.querySelector('[data-page="commerce"]')) {
      const link = document.createElement('a');
      link.className = 'nav-link';
      link.dataset.page = 'commerce';
      link.textContent = 'Commerce';
      link.onclick = function () { navigateTo('commerce'); };
      analyticsLink.parentNode.insertBefore(link, analyticsLink.nextSibling);
    }

    const area = document.querySelector('.content-area');
    if (!area) return;
    const page = document.createElement('div');
    page.id = 'commerce';
    page.className = 'page';
    page.innerHTML = `
      <div class="products-header">
        <div>
          <h2>Commerce Hub</h2>
          <p style="color:var(--text-secondary);font-size:14px;margin-top:4px;">Discount engine, returns portal, order workflow, CRM, integrations, shipping automation, conversion analytics, and inventory depth.</p>
        </div>
        <div style="display:flex;gap:10px;">
          <button class="btn btn-secondary" id="commerceRefreshBtn">Refresh</button>
          <button class="btn btn-primary" id="commerceSaveBtn">Save Commerce Settings</button>
        </div>
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
      .commerce-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:16px; margin-bottom:24px; }
      .commerce-card { background:var(--bg-secondary); border:1px solid var(--border); border-radius:10px; padding:20px; }
      .commerce-card h3 { margin-bottom:10px; }
      .commerce-row { display:flex; justify-content:space-between; gap:12px; padding:10px 0; border-bottom:1px solid var(--border); }
      .commerce-row:last-child { border-bottom:none; }
      .commerce-muted { color:var(--text-secondary); font-size:13px; }
      .commerce-input-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
      .commerce-promo-item, .commerce-return-item, .commerce-order-item, .commerce-customer-item, .commerce-location-item { background:var(--bg-secondary); border:1px solid var(--border); border-radius:10px; padding:16px; margin-bottom:14px; }
      .commerce-chip { display:inline-flex; align-items:center; padding:4px 10px; border-radius:999px; background:rgba(248,145,165,0.14); color:var(--accent); font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; }
      .commerce-section-title { margin:26px 0 14px; padding-bottom:8px; border-bottom:1px solid var(--border); }
      .commerce-actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
      .commerce-mini-table { width:100%; border-collapse:collapse; }
      .commerce-mini-table th, .commerce-mini-table td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--border); font-size:13px; vertical-align:top; }
      .commerce-location-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:14px; margin-top:14px; }
      .commerce-note { font-size:12px; color:var(--text-secondary); margin-top:6px; }
      .commerce-loc-inputs { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:8px; }
    `;
    document.head.appendChild(style);
  }

  async function loadCommerceData() {
    if (!window.sb) throw new Error('Supabase client not available.');
    const [settingsResult, ordersResult, profilesResult, productsResult, productSizesResult, edgeResult] = await Promise.all([
      window.sb.from('site_settings').select('key,value').in('key', SETTINGS_KEYS),
      window.sb.from('orders').select('*').order('created_at', { ascending: false }).limit(200),
      window.sb.from('profiles').select('*').order('created_at', { ascending: false }).limit(200),
      window.sb.from('products').select('id,title,sku,status,low_stock_threshold').order('created_at', { ascending: false }).limit(300),
      window.sb.from('product_sizes').select('*').order('created_at', { ascending: false }).limit(1500),
      fetch('/api/cloudflare-analytics').then((resp) => resp.json().catch(() => ({}))).catch(() => ({})),
    ]);
    if (settingsResult.error) throw settingsResult.error;
    if (ordersResult.error) throw ordersResult.error;
    if (profilesResult.error) throw profilesResult.error;
    if (productsResult.error) throw productsResult.error;
    if (productSizesResult.error) throw productSizesResult.error;

    const settings = settingsResult.data || [];
    state.config = {
      ...state.config,
      ...(getSettingValue(settings, 'commerce_config', {}) || {}),
    };
    state.returnsState = getSettingValue(settings, 'commerce_returns', { requests: [] }) || { requests: [] };
    state.orderOps = getSettingValue(settings, 'commerce_order_ops', {}) || {};
    state.customerProfiles = getSettingValue(settings, 'commerce_customer_profiles', {}) || {};
    state.inventory = sanitizeInventoryState(getSettingValue(settings, 'commerce_inventory', defaultInventoryState()));
    state.orders = ordersResult.data || [];
    state.profiles = profilesResult.data || [];
    state.products = productsResult.data || [];
    state.productSizes = productSizesResult.data || [];
    state.edgeMetrics = edgeResult?.metrics || null;
    renderCommerce();
  }

  function computeCustomerRows() {
    const byCustomer = new Map();
    state.orders.forEach((order) => {
      const key = String(order.email || order.customer_name || order.user_id || order.id).toLowerCase();
      if (!byCustomer.has(key)) {
        byCustomer.set(key, {
          key,
          email: order.email || 'Unknown',
          name: order.customer_name || order.email || 'Unknown',
          orders: 0,
          revenue: 0,
          lastOrderAt: order.created_at,
          firstOrderAt: order.created_at,
          userId: order.user_id || '',
        });
      }
      const current = byCustomer.get(key);
      current.orders += 1;
      current.revenue += orderTotal(order);
      current.lastOrderAt = new Date(current.lastOrderAt || 0) > new Date(order.created_at || 0) ? current.lastOrderAt : order.created_at;
      current.firstOrderAt = new Date(current.firstOrderAt || 0) < new Date(order.created_at || 0) ? current.firstOrderAt : order.created_at;
    });

    return [...byCustomer.values()].map((row) => {
      const profile = row.userId ? (state.customerProfiles[row.userId] || {}) : {};
      const segment = row.revenue >= 500 ? 'vip' : row.orders >= 2 ? 'repeat' : 'new';
      return {
        ...row,
        segment: profile.segment || segment,
        marketingConsent: Boolean(profile.marketingConsent),
        smsConsent: Boolean(profile.smsConsent),
        addressesCount: Array.isArray(profile.savedAddresses) ? profile.savedAddresses.length : 0,
      };
    }).sort((left, right) => right.revenue - left.revenue);
  }

  function computeTopProducts() {
    const counts = new Map();
    state.orders.forEach((order) => {
      parseOrderItems(order).forEach((item) => {
        const key = item.product_id || item.name || 'Unknown Product';
        const current = counts.get(key) || { label: item.name || item.product_id || 'Unknown Product', orders: 0, revenue: 0 };
        current.orders += Number(item.quantity || item.qty || 1);
        current.revenue += Number(item.amount || item.price || 0) * Number(item.quantity || item.qty || 1);
        counts.set(key, current);
      });
    });
    return [...counts.values()].sort((left, right) => right.orders - left.orders).slice(0, 6);
  }

  function computeConversionMetrics() {
    const orders = state.orders;
    const uniqueCustomers = new Set(orders.map((order) => String(order.email || order.user_id || order.id).toLowerCase()));
    const repeatCustomers = computeCustomerRows().filter((row) => row.orders > 1).length;
    const totalRevenue = orders.reduce((sum, order) => sum + orderTotal(order), 0);
    const pageViews = Number(state.edgeMetrics?.pageViews || 0);
    const topProducts = computeTopProducts();
    return {
      totalOrders: orders.length,
      revenue: totalRevenue,
      aov: orders.length ? totalRevenue / orders.length : 0,
      repeatRate: uniqueCustomers.size ? (repeatCustomers / uniqueCustomers.size) * 100 : 0,
      newCustomers: uniqueCustomers.size - repeatCustomers,
      repeatCustomers,
      conversionProxy: pageViews ? (orders.length / pageViews) * 100 : 0,
      pageViews,
      topProducts,
    };
  }

  function getLocationList() {
    const locations = Array.isArray(state.inventory.locations) ? [...state.inventory.locations] : [];
    const activeLocations = locations
      .sort((left, right) => numberOr(left.priority, 999) - numberOr(right.priority, 999))
      .filter((location) => location.active !== false);
    return activeLocations.length ? activeLocations : defaultInventoryState().locations;
  }

  function getVariantLocationMap(sizeId, onHand) {
    const override = state.inventory.variantOverrides?.[sizeId] || {};
    const locations = getLocationList();
    const saved = override.locations && typeof override.locations === 'object' ? override.locations : {};
    const map = {};
    locations.forEach((location, index) => {
      if (saved[location.id] != null) {
        map[location.id] = numberOr(saved[location.id], 0);
      } else if (index === 0) {
        map[location.id] = numberOr(onHand, 0);
      } else {
        map[location.id] = 0;
      }
    });
    return map;
  }

  function computeInventoryRows() {
    const productsById = new Map((state.products || []).map((product) => [product.id, product]));
    return (state.productSizes || []).map((size) => {
      const product = productsById.get(size.product_id) || {};
      const override = state.inventory.variantOverrides?.[size.id] || {};
      const onHand = numberOr(size.stock_quantity, 0);
      const reserved = Math.max(0, numberOr(override.reserved, 0));
      const reorderPoint = Math.max(
        0,
        numberOr(
          override.reorderPoint,
          numberOr(product.low_stock_threshold, numberOr(state.inventory.automation?.defaultThreshold, 8))
        )
      );
      const locationMap = getVariantLocationMap(size.id, onHand);
      const allocated = Object.values(locationMap).reduce((sum, value) => sum + numberOr(value, 0), 0);
      const available = Math.max(0, onHand - reserved);
      const lowStock = available <= reorderPoint;
      return {
        sizeId: size.id,
        productId: size.product_id,
        productTitle: product.title || 'Untitled Product',
        productSku: product.sku || '',
        variantLabel: size.size || 'Default',
        onHand,
        reserved,
        available,
        reorderPoint,
        lowStock,
        status: product.status || 'draft',
        locationMap,
        allocated,
        allocationOk: allocated === onHand,
      };
    }).sort((left, right) => {
      if (left.lowStock !== right.lowStock) return left.lowStock ? -1 : 1;
      return left.available - right.available;
    });
  }

  function computeInventoryMetrics() {
    const rows = computeInventoryRows();
    return {
      rows,
      locations: getLocationList(),
      totalReserved: rows.reduce((sum, row) => sum + row.reserved, 0),
      totalAvailable: rows.reduce((sum, row) => sum + row.available, 0),
      lowStockCount: rows.filter((row) => row.lowStock).length,
      historyCount: Array.isArray(state.inventory.history) ? state.inventory.history.length : 0,
    };
  }

  function renderPromotions() {
    const promos = Array.isArray(state.config.promotions) ? state.config.promotions : [];
    return `
      <div class="commerce-card">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;">
          <div>
            <h3>Discount Engine</h3>
            <div class="commerce-muted">Create percent-off, fixed-dollar, or shipping promos that validate at checkout.</div>
          </div>
          <button class="btn btn-secondary btn-sm" id="commerceAddPromoBtn">+ Add Promo</button>
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
              <div class="commerce-actions"><button class="btn btn-danger btn-sm" data-remove-promo="${index}">Remove</button></div>
            </div>
          `).join('') : '<div class="commerce-muted">No promotions yet.</div>'}
        </div>
      </div>
    `;
  }

  function renderReturns() {
    const requests = Array.isArray(state.returnsState.requests) ? state.returnsState.requests : [];
    return `
      <div class="commerce-card">
        <h3>Returns & Exchanges Portal</h3>
        <div class="commerce-muted">Customer-submitted self-serve requests land here for approval, refund, or exchange handling.</div>
        <div style="margin-top:14px;">
          ${requests.length ? requests.slice(0, 20).map((request) => `
            <div class="commerce-return-item" data-return-id="${escapeHtml(request.id)}">
              <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;">
                <div>
                  <strong>${escapeHtml(request.orderLabel || request.orderId || 'Order')}</strong>
                  <div class="commerce-muted">${escapeHtml(request.reason || '')}</div>
                </div>
                <span class="commerce-chip">${escapeHtml(request.status || 'requested')}</span>
              </div>
              <div class="commerce-input-grid" style="margin-top:12px;">
                <div><label>Status</label>
                  <select class="form-select" data-return-field="status">
                    <option value="requested" ${request.status === 'requested' ? 'selected' : ''}>Requested</option>
                    <option value="approved" ${request.status === 'approved' ? 'selected' : ''}>Approved</option>
                    <option value="exchange_in_progress" ${request.status === 'exchange_in_progress' ? 'selected' : ''}>Exchange in progress</option>
                    <option value="refunded" ${request.status === 'refunded' ? 'selected' : ''}>Refunded</option>
                    <option value="closed" ${request.status === 'closed' ? 'selected' : ''}>Closed</option>
                  </select>
                </div>
                <div><label>Resolution</label><input class="form-input" data-return-field="resolution" value="${escapeHtml(request.resolution || '')}"></div>
              </div>
              <div style="margin-top:10px;"><label>Notes</label><input class="form-input" data-return-field="notes" value="${escapeHtml(request.notes || '')}"></div>
              <div class="commerce-muted" style="margin-top:10px;">${escapeHtml(request.userId || '')} - ${new Date(request.createdAt || Date.now()).toLocaleString()}</div>
              <div class="commerce-actions"><button class="btn btn-secondary btn-sm" data-save-return="${escapeHtml(request.id)}">Save Request</button></div>
            </div>
          `).join('') : '<div class="commerce-muted" style="margin-top:12px;">No return requests yet.</div>'}
        </div>
      </div>
    `;
  }

  function renderOrderWorkflow() {
    return `
      <div class="commerce-card">
        <h3>Order Management Workflow</h3>
        <div class="commerce-muted">Track fulfillment state, fraud review, notes, tags, cancellations, refunds, and tracking from one place.</div>
        <div style="margin-top:14px;">
          ${state.orders.slice(0, 15).map((order) => {
            const override = state.orderOps[order.id] || {};
            const total = orderTotal(order);
            return `
              <div class="commerce-order-item" data-order-id="${escapeHtml(order.id)}">
                <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;">
                  <div>
                    <strong>#${escapeHtml(String(order.id || '').slice(-8).toUpperCase())}</strong>
                    <div class="commerce-muted">${escapeHtml(order.email || order.customer_name || 'Unknown customer')} - ${money(total)}</div>
                  </div>
                  <span class="commerce-chip">${escapeHtml(override.fulfillmentStatus || order.fulfillment_status || 'unfulfilled')}</span>
                </div>
                <div class="commerce-input-grid" style="margin-top:12px;">
                  <div><label>Fulfillment</label>
                    <select class="form-select" data-order-field="fulfillmentStatus">
                      ${['unfulfilled', 'picking', 'packed', 'shipped', 'delivered', 'returned'].map((value) => `<option value="${value}" ${(override.fulfillmentStatus || 'unfulfilled') === value ? 'selected' : ''}>${value}</option>`).join('')}
                    </select>
                  </div>
                  <div><label>Fraud</label>
                    <select class="form-select" data-order-field="fraudStatus">
                      ${['clear', 'review', 'high_risk', 'blocked'].map((value) => `<option value="${value}" ${(override.fraudStatus || 'clear') === value ? 'selected' : ''}>${value}</option>`).join('')}
                    </select>
                  </div>
                  <div><label>Tracking #</label><input class="form-input" data-order-field="trackingNumber" value="${escapeHtml(override.trackingNumber || order.tracking_number || '')}"></div>
                  <div><label>Tracking URL</label><input class="form-input" data-order-field="trackingUrl" value="${escapeHtml(override.trackingUrl || order.tracking_url || '')}"></div>
                </div>
                <div class="commerce-input-grid" style="margin-top:10px;">
                  <div><label>Tags</label><input class="form-input" data-order-field="tags" value="${escapeHtml(Array.isArray(override.tags) ? override.tags.join(', ') : '')}" placeholder="vip, launch-day, wholesale"></div>
                  <div><label>Internal notes</label><input class="form-input" data-order-field="notes" value="${escapeHtml(override.notes || '')}" placeholder="Refund approved, size swap pending"></div>
                </div>
                <div class="commerce-actions"><button class="btn btn-secondary btn-sm" data-save-order="${escapeHtml(order.id)}">Save Workflow</button></div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  function renderCustomerCrm() {
    const rows = computeCustomerRows().slice(0, 12);
    return `
      <div class="commerce-card">
        <h3>Customer Accounts & CRM</h3>
        <div class="commerce-muted">Order history, saved addresses, customer segments, lifetime value, and marketing consent at a glance.</div>
        <table class="commerce-mini-table" style="margin-top:14px;">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Segment</th>
              <th>Orders</th>
              <th>LTV</th>
              <th>Consent</th>
              <th>Addresses</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr>
                <td><strong>${escapeHtml(row.name)}</strong><div class="commerce-muted">${escapeHtml(row.email)}</div></td>
                <td>${escapeHtml(row.segment)}</td>
                <td>${row.orders}</td>
                <td>${money(row.revenue)}</td>
                <td>${row.marketingConsent ? 'Email' : 'No'} / ${row.smsConsent ? 'SMS' : 'No'}</td>
                <td>${row.addressesCount}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderIntegrations() {
    const integrations = state.config.integrations || {};
    const shippingAutomation = state.config.shippingAutomation || {};
    const customerExperience = state.config.customerExperience || {};
    return `
      <div class="commerce-card">
        <h3>App & Integration Ecosystem</h3>
        <div class="commerce-muted">Configure the Shopify-style operational stack your store needs next.</div>
        <div class="commerce-input-grid" style="margin-top:14px;">
          <div><label>Email / SMS</label><input class="form-input" id="commerce-email-provider" value="${escapeHtml(integrations.emailProvider || '')}" placeholder="Klaviyo, Postscript"></div>
          <div><label>Reviews</label><input class="form-input" id="commerce-reviews-provider" value="${escapeHtml(integrations.reviewsProvider || 'Native reviews')}" placeholder="Judge.me, Loox"></div>
          <div><label>Subscriptions</label><input class="form-input" id="commerce-subscriptions-provider" value="${escapeHtml((state.config.subscriptions || {}).provider || '')}" placeholder="Recharge, native"></div>
          <div><label>Affiliates</label><input class="form-input" id="commerce-affiliates-provider" value="${escapeHtml((state.config.affiliates || {}).provider || '')}" placeholder="Social Snowball"></div>
          <div><label>Bundles & Upsells</label><input class="form-input" id="commerce-merch-provider" value="${escapeHtml((state.config.merchandising || {}).provider || '')}" placeholder="Native merchandising"></div>
          <div><label>Accounting sync</label><input class="form-input" id="commerce-accounting-provider" value="${escapeHtml(integrations.accountingProvider || '')}" placeholder="QuickBooks, Xero"></div>
        </div>
        <div class="commerce-input-grid" style="margin-top:14px;">
          <div><label>Live carrier rates</label><select class="form-select" id="commerce-live-rates"><option value="true" ${shippingAutomation.liveRates !== false ? 'selected' : ''}>Enabled</option><option value="false" ${shippingAutomation.liveRates === false ? 'selected' : ''}>Disabled</option></select></div>
          <div><label>Label generation</label><select class="form-select" id="commerce-labels"><option value="true" ${shippingAutomation.labelGeneration ? 'selected' : ''}>Enabled</option><option value="false" ${!shippingAutomation.labelGeneration ? 'selected' : ''}>Disabled</option></select></div>
          <div><label>Tracking updates</label><select class="form-select" id="commerce-tracking-updates"><option value="true" ${shippingAutomation.trackingUpdates !== false ? 'selected' : ''}>Enabled</option><option value="false" ${shippingAutomation.trackingUpdates === false ? 'selected' : ''}>Disabled</option></select></div>
          <div><label>Split shipments</label><select class="form-select" id="commerce-split-shipments"><option value="true" ${shippingAutomation.splitShipments ? 'selected' : ''}>Enabled</option><option value="false" ${!shippingAutomation.splitShipments ? 'selected' : ''}>Disabled</option></select></div>
          <div><label>Saved addresses</label><select class="form-select" id="commerce-saved-addresses"><option value="true" ${customerExperience.savedAddresses !== false ? 'selected' : ''}>Enabled</option><option value="false" ${customerExperience.savedAddresses === false ? 'selected' : ''}>Disabled</option></select></div>
          <div><label>Marketing consent capture</label><select class="form-select" id="commerce-marketing-consent"><option value="true" ${customerExperience.marketingConsent !== false ? 'selected' : ''}>Enabled</option><option value="false" ${customerExperience.marketingConsent === false ? 'selected' : ''}>Disabled</option></select></div>
        </div>
      </div>
    `;
  }

  function renderInventoryDepth() {
    const metrics = computeInventoryMetrics();
    const automation = state.inventory.automation || {};
    const locations = Array.isArray(state.inventory.locations) ? state.inventory.locations : [];
    const history = Array.isArray(state.inventory.history) ? state.inventory.history.slice(0, 20) : [];
    const rows = metrics.rows.slice(0, 18);
    const atRisk = metrics.rows.filter((row) => row.lowStock).slice(0, 8);

    return `
      <div class="commerce-card">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;">
          <div>
            <h3>Inventory Depth</h3>
            <div class="commerce-muted">Reserved stock, low-stock automations, variant-level controls, inventory history, and multi-location allocation layered on top of your current inventory tables.</div>
          </div>
          <button class="btn btn-secondary btn-sm" id="commerceAddLocationBtn">+ Add Location</button>
        </div>

        <div class="commerce-grid" style="margin-top:14px;">
          <div class="commerce-card"><div class="commerce-muted">Locations</div><div style="font-size:26px;font-weight:700;">${metrics.locations.length}</div></div>
          <div class="commerce-card"><div class="commerce-muted">Reserved Units</div><div style="font-size:26px;font-weight:700;">${metrics.totalReserved}</div></div>
          <div class="commerce-card"><div class="commerce-muted">Available Units</div><div style="font-size:26px;font-weight:700;">${metrics.totalAvailable}</div></div>
          <div class="commerce-card"><div class="commerce-muted">Low-Stock Variants</div><div style="font-size:26px;font-weight:700;">${metrics.lowStockCount}</div></div>
        </div>

        <div class="commerce-section-title">Multi-Location Inventory</div>
        <div id="commerceInventoryLocations" class="commerce-location-grid">
          ${locations.map((location, index) => `
            <div class="commerce-location-item" data-location-id="${escapeHtml(location.id)}">
              <div class="commerce-input-grid">
                <div><label>Name</label><input class="form-input" data-location-field="name" value="${escapeHtml(location.name || '')}"></div>
                <div><label>Code</label><input class="form-input" data-location-field="code" value="${escapeHtml(location.code || '')}"></div>
                <div><label>Type</label><input class="form-input" data-location-field="type" value="${escapeHtml(location.type || 'warehouse')}"></div>
                <div><label>Priority</label><input class="form-input" data-location-field="priority" type="number" value="${numberOr(location.priority, index + 1)}"></div>
                <div><label>Active</label>
                  <select class="form-select" data-location-field="active">
                    <option value="true" ${location.active !== false ? 'selected' : ''}>Active</option>
                    <option value="false" ${location.active === false ? 'selected' : ''}>Paused</option>
                  </select>
                </div>
              </div>
              <div class="commerce-note">Use locations to split inventory across warehouse, studio, retail, or fulfillment partners.</div>
              <div class="commerce-actions">
                <button class="btn btn-danger btn-sm" data-remove-location="${escapeHtml(location.id)}">Remove</button>
              </div>
            </div>
          `).join('')}
        </div>

        <div class="commerce-section-title">Low-Stock Automation</div>
        <div class="commerce-input-grid">
          <div><label>Automation status</label><select class="form-select" id="commerce-inventory-enabled"><option value="true" ${automation.enabled !== false ? 'selected' : ''}>Enabled</option><option value="false" ${automation.enabled === false ? 'selected' : ''}>Paused</option></select></div>
          <div><label>Default reorder point</label><input class="form-input" id="commerce-inventory-threshold" type="number" value="${numberOr(automation.defaultThreshold, 8)}"></div>
          <div><label>Alert email</label><input class="form-input" id="commerce-inventory-alert-email" value="${escapeHtml(automation.alertEmail || '')}" placeholder="ops@zuwera.store"></div>
          <div><label>Alert SMS</label><input class="form-input" id="commerce-inventory-alert-sms" value="${escapeHtml(automation.alertSms || '')}" placeholder="+1 555 555 5555"></div>
          <div><label>Webhook / Slack</label><input class="form-input" id="commerce-inventory-alert-webhook" value="${escapeHtml(automation.alertWebhook || '')}" placeholder="Slack webhook or ops channel URL"></div>
          <div><label>Auto-reserve at checkout</label><select class="form-select" id="commerce-inventory-auto-reserve"><option value="true" ${automation.autoReserveAtCheckout !== false ? 'selected' : ''}>Enabled</option><option value="false" ${automation.autoReserveAtCheckout === false ? 'selected' : ''}>Disabled</option></select></div>
        </div>
        <table class="commerce-mini-table" style="margin-top:14px;">
          <thead><tr><th>At-Risk Variant</th><th>Available</th><th>Reorder Point</th><th>Status</th></tr></thead>
          <tbody>
            ${atRisk.length ? atRisk.map((row) => `
              <tr>
                <td><strong>${escapeHtml(row.productTitle)}</strong><div class="commerce-muted">${escapeHtml(row.variantLabel)}${row.productSku ? ` - ${escapeHtml(row.productSku)}` : ''}</div></td>
                <td>${row.available}</td>
                <td>${row.reorderPoint}</td>
                <td>${automation.enabled === false ? 'Monitoring paused' : 'Queue alert / replenish'}</td>
              </tr>
            `).join('') : '<tr><td colspan="4" class="commerce-muted">No low-stock variants at the moment.</td></tr>'}
          </tbody>
        </table>

        <div class="commerce-section-title">Variant-Level Inventory Controls</div>
        <table class="commerce-mini-table" id="commerceInventoryVariantTable">
          <thead>
            <tr>
              <th>Variant</th>
              <th>On Hand</th>
              <th>Reserved</th>
              <th>Available</th>
              <th>Reorder Point</th>
              <th>Location Allocation</th>
              <th>Save</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length ? rows.map((row) => `
              <tr data-size-id="${escapeHtml(row.sizeId)}">
                <td>
                  <strong>${escapeHtml(row.productTitle)}</strong>
                  <div class="commerce-muted">${escapeHtml(row.variantLabel)}${row.productSku ? ` - ${escapeHtml(row.productSku)}` : ''}</div>
                </td>
                <td>${row.onHand}</td>
                <td><input class="form-input" data-variant-field="reserved" type="number" value="${row.reserved}" min="0"></td>
                <td>${row.available}${row.lowStock ? '<div class="commerce-note">Low stock</div>' : ''}</td>
                <td><input class="form-input" data-variant-field="reorderPoint" type="number" value="${row.reorderPoint}" min="0"></td>
                <td>
                  <div class="commerce-loc-inputs">
                    ${metrics.locations.map((location) => `
                      <div>
                        <label>${escapeHtml(location.code)}</label>
                        <input class="form-input" data-location-stock="${escapeHtml(location.id)}" type="number" value="${numberOr(row.locationMap[location.id], 0)}" min="0">
                      </div>
                    `).join('')}
                  </div>
                  <div class="commerce-note">${row.allocationOk ? `Allocated ${row.allocated}/${row.onHand}` : `Allocation mismatch ${row.allocated}/${row.onHand}`}</div>
                </td>
                <td>
                  <input class="form-input" data-variant-field="note" placeholder="Adjustment note">
                  <div class="commerce-actions"><button class="btn btn-secondary btn-sm" data-save-variant="${escapeHtml(row.sizeId)}">Save</button></div>
                </td>
              </tr>
            `).join('') : '<tr><td colspan="7" class="commerce-muted">No product sizes found yet. Add size inventory in Products to unlock advanced controls here.</td></tr>'}
          </tbody>
        </table>

        <div class="commerce-section-title">Inventory History</div>
        <table class="commerce-mini-table">
          <thead><tr><th>When</th><th>Variant</th><th>Event</th><th>Change</th><th>Note</th></tr></thead>
          <tbody>
            ${history.length ? history.map((entry) => `
              <tr>
                <td>${new Date(entry.at || Date.now()).toLocaleString()}</td>
                <td><strong>${escapeHtml(entry.productTitle || 'Variant')}</strong><div class="commerce-muted">${escapeHtml(entry.variantLabel || '')}</div></td>
                <td>${escapeHtml(entry.eventType || 'adjustment')}</td>
                <td>${escapeHtml(entry.changeSummary || 'Updated')}</td>
                <td>${escapeHtml(entry.note || '')}</td>
              </tr>
            `).join('') : '<tr><td colspan="5" class="commerce-muted">Inventory history starts populating as soon as you save variant or location changes here.</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderAnalytics() {
    const metrics = computeConversionMetrics();
    return `
      <div class="commerce-card">
        <h3>Conversion-Focused Analytics</h3>
        <div class="commerce-grid" style="margin-top:14px;">
          <div class="commerce-card"><div class="commerce-muted">Average Order Value</div><div style="font-size:26px;font-weight:700;">${money(metrics.aov)}</div></div>
          <div class="commerce-card"><div class="commerce-muted">Returning vs New</div><div style="font-size:26px;font-weight:700;">${metrics.repeatCustomers} / ${metrics.newCustomers}</div></div>
          <div class="commerce-card"><div class="commerce-muted">Repeat Purchase Rate</div><div style="font-size:26px;font-weight:700;">${metrics.repeatRate.toFixed(1)}%</div></div>
          <div class="commerce-card"><div class="commerce-muted">Conversion Proxy</div><div style="font-size:26px;font-weight:700;">${metrics.pageViews ? metrics.conversionProxy.toFixed(2) + '%' : 'Waiting on edge analytics'}</div></div>
        </div>
        <div class="commerce-section-title">Top Products by Demand</div>
        <table class="commerce-mini-table">
          <thead><tr><th>Product</th><th>Units</th><th>Revenue</th></tr></thead>
          <tbody>
            ${metrics.topProducts.length ? metrics.topProducts.map((product) => `<tr><td>${escapeHtml(product.label)}</td><td>${product.orders}</td><td>${money(product.revenue)}</td></tr>`).join('') : '<tr><td colspan="3" class="commerce-muted">No item-level order data yet.</td></tr>'}
          </tbody>
        </table>
        <div class="commerce-muted" style="margin-top:12px;">Top landing pages and checkout drop-off will become more precise once the Cloudflare edge analytics endpoint is healthy again.</div>
      </div>
    `;
  }

  function renderCommerce() {
    mountCommerceStyles();
    const mount = $('commerceMount');
    if (!mount) return;
    const metrics = computeConversionMetrics();
    const inventoryMetrics = computeInventoryMetrics();
    mount.innerHTML = `
      <div class="commerce-grid">
        <div class="stat-card"><div class="stat-card-title">Live Promotions</div><div class="stat-card-value">${(state.config.promotions || []).filter((promo) => promo.active !== false).length}</div></div>
        <div class="stat-card"><div class="stat-card-title">Open Return Requests</div><div class="stat-card-value">${(state.returnsState.requests || []).filter((request) => !['closed', 'refunded'].includes(request.status)).length}</div></div>
        <div class="stat-card"><div class="stat-card-title">Tracked Customers</div><div class="stat-card-value">${computeCustomerRows().length}</div></div>
        <div class="stat-card"><div class="stat-card-title">Commerce Revenue</div><div class="stat-card-value">${money(metrics.revenue)}</div></div>
        <div class="stat-card"><div class="stat-card-title">Reserved Units</div><div class="stat-card-value">${inventoryMetrics.totalReserved}</div></div>
        <div class="stat-card"><div class="stat-card-title">Low-Stock Variants</div><div class="stat-card-value">${inventoryMetrics.lowStockCount}</div></div>
      </div>
      ${renderPromotions()}
      <div class="commerce-section-title">Post-Purchase Operations</div>
      <div class="commerce-grid">
        ${renderReturns()}
        ${renderOrderWorkflow()}
      </div>
      <div class="commerce-section-title">Customer Growth</div>
      <div class="commerce-grid">
        ${renderCustomerCrm()}
        ${renderIntegrations()}
      </div>
      <div class="commerce-section-title">Merchandising & Analytics</div>
      <div class="commerce-grid">
        ${renderInventoryDepth()}
        ${renderAnalytics()}
      </div>
    `;
    bindCommerceEvents();
  }

  function readPromotionsFromDom() {
    return [...document.querySelectorAll('#commercePromoList .commerce-promo-item')].map((node) => ({
      code: node.querySelector('[data-field="code"]')?.value || '',
      label: node.querySelector('[data-field="label"]')?.value || '',
      type: node.querySelector('[data-field="type"]')?.value || 'percent',
      value: Number(node.querySelector('[data-field="value"]')?.value || 0),
      minSubtotal: Number(node.querySelector('[data-field="minSubtotal"]')?.value || 0),
      description: node.querySelector('[data-field="description"]')?.value || '',
      active: node.querySelector('[data-field="active"]')?.value !== 'false',
    })).filter((promo) => promo.code.trim());
  }

  function slugifyLocation(value, fallback) {
    const cleaned = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return cleaned || fallback;
  }

  function readInventoryFromDom() {
    const base = sanitizeInventoryState(state.inventory);
    const locationNodes = [...document.querySelectorAll('#commerceInventoryLocations .commerce-location-item')];
    const locations = locationNodes.map((node, index) => {
      const name = node.querySelector('[data-location-field="name"]')?.value || '';
      const code = node.querySelector('[data-location-field="code"]')?.value || '';
      const fallbackId = `location-${index + 1}`;
      return {
        id: node.dataset.locationId || slugifyLocation(code || name, fallbackId),
        name: name || `Location ${index + 1}`,
        code: (code || name || `LOC${index + 1}`).trim().toUpperCase(),
        type: node.querySelector('[data-location-field="type"]')?.value || 'warehouse',
        priority: numberOr(node.querySelector('[data-location-field="priority"]')?.value, index + 1),
        active: node.querySelector('[data-location-field="active"]')?.value !== 'false',
      };
    }).filter((location) => location.name.trim());

    const variantOverrides = { ...(base.variantOverrides || {}) };
    document.querySelectorAll('#commerceInventoryVariantTable tbody tr[data-size-id]').forEach((row) => {
      const sizeId = row.dataset.sizeId;
      if (!sizeId) return;
      const locationMap = {};
      [...row.querySelectorAll('[data-location-stock]')].forEach((input) => {
        const locationId = input.getAttribute('data-location-stock');
        if (!locationId) return;
        locationMap[locationId] = Math.max(0, numberOr(input.value, 0));
      });
      variantOverrides[sizeId] = {
        ...(base.variantOverrides?.[sizeId] || {}),
        reserved: Math.max(0, numberOr(row.querySelector('[data-variant-field="reserved"]')?.value, 0)),
        reorderPoint: Math.max(0, numberOr(row.querySelector('[data-variant-field="reorderPoint"]')?.value, numberOr(base.automation?.defaultThreshold, 8))),
        locations: locationMap,
        updatedAt: new Date().toISOString(),
      };
    });

    return sanitizeInventoryState({
      ...base,
      locations: locations.length ? locations : defaultInventoryState().locations,
      variantOverrides,
      automation: {
        ...base.automation,
        enabled: $('commerce-inventory-enabled')?.value !== 'false',
        defaultThreshold: Math.max(0, numberOr($('commerce-inventory-threshold')?.value, 8)),
        alertEmail: $('commerce-inventory-alert-email')?.value || '',
        alertSms: $('commerce-inventory-alert-sms')?.value || '',
        alertWebhook: $('commerce-inventory-alert-webhook')?.value || '',
        autoReserveAtCheckout: $('commerce-inventory-auto-reserve')?.value !== 'false',
      },
    });
  }

  function appendInventoryHistory(entry) {
    const current = Array.isArray(state.inventory.history) ? [...state.inventory.history] : [];
    current.unshift({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      ...entry,
    });
    state.inventory.history = current.slice(0, 250);
  }

  function saveVariantControl(sizeId) {
    const row = document.querySelector(`#commerceInventoryVariantTable tbody tr[data-size-id="${sizeId}"]`);
    if (!row) return;
    const currentInventory = readInventoryFromDom();
    const previous = state.inventory.variantOverrides?.[sizeId] || {};
    const next = currentInventory.variantOverrides?.[sizeId] || {};
    const variant = computeInventoryRows().find((item) => String(item.sizeId) === String(sizeId));
    const changes = [];
    if (numberOr(previous.reserved, 0) !== numberOr(next.reserved, 0)) {
      changes.push(`reserved ${numberOr(previous.reserved, 0)} -> ${numberOr(next.reserved, 0)}`);
    }
    if (numberOr(previous.reorderPoint, variant?.reorderPoint ?? 0) !== numberOr(next.reorderPoint, variant?.reorderPoint ?? 0)) {
      changes.push(`reorder ${numberOr(previous.reorderPoint, variant?.reorderPoint ?? 0)} -> ${numberOr(next.reorderPoint, variant?.reorderPoint ?? 0)}`);
    }
    const previousLocations = previous.locations && typeof previous.locations === 'object' ? previous.locations : {};
    const nextLocations = next.locations && typeof next.locations === 'object' ? next.locations : {};
    const locationChanged = JSON.stringify(previousLocations) !== JSON.stringify(nextLocations);
    if (locationChanged) {
      changes.push('location allocation updated');
    }

    state.inventory = currentInventory;
    appendInventoryHistory({
      eventType: 'variant_adjustment',
      productTitle: variant?.productTitle || 'Variant',
      variantLabel: variant?.variantLabel || '',
      changeSummary: changes.join(', ') || 'No material change',
      note: row.querySelector('[data-variant-field="note"]')?.value || '',
      sizeId,
    });
  }

  function bindCommerceEvents() {
    $('commerceAddPromoBtn')?.addEventListener('click', () => {
      state.config.promotions = [...(state.config.promotions || []), { code: '', label: '', type: 'percent', value: 10, minSubtotal: 0, description: '', active: true }];
      renderCommerce();
    });

    document.querySelectorAll('[data-remove-promo]').forEach((button) => {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.removePromo);
        state.config.promotions.splice(index, 1);
        renderCommerce();
      });
    });

    document.querySelectorAll('[data-save-return]').forEach((button) => {
      button.addEventListener('click', async () => {
        const requestId = button.dataset.saveReturn;
        const card = button.closest('.commerce-return-item');
        const requests = Array.isArray(state.returnsState.requests) ? [...state.returnsState.requests] : [];
        const idx = requests.findIndex((request) => request.id === requestId);
        if (idx === -1 || !card) return;
        requests[idx] = {
          ...requests[idx],
          status: card.querySelector('[data-return-field="status"]')?.value || requests[idx].status,
          resolution: card.querySelector('[data-return-field="resolution"]')?.value || requests[idx].resolution,
          notes: card.querySelector('[data-return-field="notes"]')?.value || requests[idx].notes,
          updatedAt: new Date().toISOString(),
        };
        state.returnsState.requests = requests;
        await saveSettings('Return request updated.');
      });
    });

    document.querySelectorAll('[data-save-order]').forEach((button) => {
      button.addEventListener('click', async () => {
        const orderId = button.dataset.saveOrder;
        const card = button.closest('.commerce-order-item');
        if (!card) return;
        const current = state.orderOps[orderId] || {};
        state.orderOps[orderId] = {
          ...current,
          fulfillmentStatus: card.querySelector('[data-order-field="fulfillmentStatus"]')?.value || current.fulfillmentStatus || 'unfulfilled',
          fraudStatus: card.querySelector('[data-order-field="fraudStatus"]')?.value || current.fraudStatus || 'clear',
          trackingNumber: card.querySelector('[data-order-field="trackingNumber"]')?.value || '',
          trackingUrl: card.querySelector('[data-order-field="trackingUrl"]')?.value || '',
          tags: String(card.querySelector('[data-order-field="tags"]')?.value || '').split(',').map((value) => value.trim()).filter(Boolean),
          notes: card.querySelector('[data-order-field="notes"]')?.value || '',
          updatedAt: new Date().toISOString(),
        };
        await saveSettings('Order workflow saved.');
      });
    });

    $('commerceAddLocationBtn')?.addEventListener('click', () => {
      const nextIndex = (state.inventory.locations || []).length + 1;
      state.inventory.locations = [
        ...(state.inventory.locations || []),
        {
          id: `location-${Date.now()}`,
          name: `Location ${nextIndex}`,
          code: `LOC${nextIndex}`,
          type: 'warehouse',
          priority: nextIndex,
          active: true,
        },
      ];
      renderCommerce();
    });

    document.querySelectorAll('[data-remove-location]').forEach((button) => {
      button.addEventListener('click', () => {
        const locationId = button.dataset.removeLocation;
        const nextLocations = (state.inventory.locations || []).filter((location) => location.id !== locationId);
        state.inventory.locations = nextLocations.length ? nextLocations : defaultInventoryState().locations;
        Object.keys(state.inventory.variantOverrides || {}).forEach((sizeId) => {
          const override = state.inventory.variantOverrides[sizeId];
          if (override?.locations && typeof override.locations === 'object') {
            delete override.locations[locationId];
          }
        });
        appendInventoryHistory({
          eventType: 'location_removed',
          productTitle: 'Inventory Network',
          variantLabel: '',
          changeSummary: `Removed location ${locationId}`,
          note: '',
        });
        renderCommerce();
      });
    });

    document.querySelectorAll('[data-save-variant]').forEach((button) => {
      button.addEventListener('click', async () => {
        const sizeId = button.dataset.saveVariant;
        saveVariantControl(sizeId);
        await saveSettings('Inventory control saved.');
      });
    });
  }

  async function saveSettings(message) {
    $('commerceStatus').textContent = 'Saving commerce settings...';
    state.config.promotions = readPromotionsFromDom();
    if ($('commerceInventoryVariantTable') || $('commerceInventoryLocations')) {
      state.inventory = readInventoryFromDom();
    }
    state.config.integrations = {
      ...(state.config.integrations || {}),
      emailProvider: $('commerce-email-provider')?.value || '',
      reviewsProvider: $('commerce-reviews-provider')?.value || '',
      accountingProvider: $('commerce-accounting-provider')?.value || '',
    };
    state.config.subscriptions = {
      ...(state.config.subscriptions || {}),
      provider: $('commerce-subscriptions-provider')?.value || '',
    };
    state.config.affiliates = {
      ...(state.config.affiliates || {}),
      provider: $('commerce-affiliates-provider')?.value || '',
    };
    state.config.merchandising = {
      ...(state.config.merchandising || {}),
      provider: $('commerce-merch-provider')?.value || '',
    };
    state.config.shippingAutomation = {
      ...(state.config.shippingAutomation || {}),
      liveRates: $('commerce-live-rates')?.value !== 'false',
      labelGeneration: $('commerce-labels')?.value === 'true',
      trackingUpdates: $('commerce-tracking-updates')?.value !== 'false',
      splitShipments: $('commerce-split-shipments')?.value === 'true',
    };
    state.config.customerExperience = {
      ...(state.config.customerExperience || {}),
      savedAddresses: $('commerce-saved-addresses')?.value !== 'false',
      marketingConsent: $('commerce-marketing-consent')?.value !== 'false',
    };
    state.config.updatedAt = new Date().toISOString();

    const payload = [
      { key: 'commerce_config', value: state.config },
      { key: 'commerce_returns', value: state.returnsState },
      { key: 'commerce_order_ops', value: state.orderOps },
      { key: 'commerce_customer_profiles', value: state.customerProfiles },
      { key: 'commerce_inventory', value: state.inventory },
    ];
    const result = await window.sb.from('site_settings').upsert(payload, { onConflict: 'key' });
    if (result.error) {
      $('commerceStatus').textContent = result.error.message || 'Could not save commerce settings.';
      return;
    }
    $('commerceStatus').textContent = message || 'Commerce settings saved.';
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
        $('pageTitle').textContent = 'Commerce Hub';
        loadCommerceData().catch((error) => {
          $('commerceStatus').textContent = error?.message || 'Could not load commerce hub.';
        });
        return;
      }
      return originalNavigateTo(page);
    };
    window.navigateTo.__commerceWrapped = true;
  }

  function bindGlobalButtons() {
    $('commerceRefreshBtn')?.addEventListener('click', () => loadCommerceData().catch((error) => {
      $('commerceStatus').textContent = error?.message || 'Could not refresh commerce hub.';
    }));
    $('commerceSaveBtn')?.addEventListener('click', () => saveSettings('Commerce settings saved.'));
  }

  document.addEventListener('DOMContentLoaded', () => {
    ensureNavAndPage();
    mountCommerceStyles();
    installNavigationHook();
    bindGlobalButtons();
  });
})();
