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
    activeTab: 'overview',
    orderSearch: '',
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
          <h2>Commerce</h2>
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
      /* ── Layout ── */
      .commerce-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:16px; margin-bottom:24px; }
      .commerce-card { background:var(--bg-secondary); border:1px solid var(--border); border-radius:10px; padding:20px; }
      .commerce-card h3 { margin-bottom:10px; }
      .commerce-row { display:flex; justify-content:space-between; gap:12px; padding:10px 0; border-bottom:1px solid var(--border); }
      .commerce-row:last-child { border-bottom:none; }
      .commerce-muted { color:var(--text-secondary); font-size:13px; }
      .commerce-input-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
      .commerce-promo-item, .commerce-return-item, .commerce-order-item, .commerce-customer-item, .commerce-location-item { background:var(--bg-secondary); border:1px solid var(--border); border-radius:10px; padding:16px; margin-bottom:14px; }
      .commerce-section-title { margin:26px 0 14px; padding-bottom:8px; border-bottom:1px solid var(--border); }
      .commerce-actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
      .commerce-mini-table { width:100%; border-collapse:collapse; }
      .commerce-mini-table th, .commerce-mini-table td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--border); font-size:13px; vertical-align:top; }
      .commerce-location-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:14px; margin-top:14px; }
      .commerce-note { font-size:12px; color:var(--text-secondary); margin-top:6px; }
      .commerce-loc-inputs { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:8px; }

      /* ── Tabs ── */
      .cz-tabs { display:flex; gap:2px; border-bottom:2px solid var(--border); margin-bottom:22px; overflow-x:auto; scrollbar-width:none; }
      .cz-tabs::-webkit-scrollbar { display:none; }
      .cz-tab { padding:10px 18px; font-size:13px; font-weight:600; color:var(--text-secondary); background:none; border:none; border-bottom:2px solid transparent; margin-bottom:-2px; cursor:pointer; white-space:nowrap; transition:color .15s,border-color .15s; border-radius:0; }
      .cz-tab:hover { color:var(--text-primary,#fff); }
      .cz-tab.active { color:var(--accent,#f891a5); border-bottom-color:var(--accent,#f891a5); }

      /* ── Status chips ── */
      .commerce-chip { display:inline-flex; align-items:center; padding:3px 9px; border-radius:4px; font-size:10px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; }
      .cz-chip-unfulfilled { background:rgba(255,200,60,.13); color:#f5c842; }
      .cz-chip-picking, .cz-chip-packed { background:rgba(100,160,255,.13); color:#7ab4ff; }
      .cz-chip-shipped { background:rgba(80,190,255,.14); color:#50bfff; }
      .cz-chip-delivered { background:rgba(80,220,140,.14); color:#50dc8c; }
      .cz-chip-returned { background:rgba(180,120,255,.14); color:#b478ff; }
      .cz-chip-cancelled { background:rgba(224,80,80,.13); color:#e05050; }
      .cz-chip-refunded { background:rgba(180,120,255,.14); color:#b478ff; }
      .cz-chip-paid, .cz-chip-clear { background:rgba(80,220,140,.12); color:#50dc8c; }
      .cz-chip-review { background:rgba(255,200,60,.13); color:#f5c842; }
      .cz-chip-high_risk { background:rgba(224,80,80,.15); color:#e05050; }
      .cz-chip-blocked { background:rgba(180,30,30,.2); color:#ff6060; }
      .cz-chip-default { background:rgba(248,145,165,0.14); color:var(--accent,#f891a5); }

      /* ── Stat cards ── */
      .cz-stat-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:14px; margin-bottom:24px; }
      .cz-stat { background:var(--bg-secondary); border:1px solid var(--border); border-radius:10px; padding:18px 20px; }
      .cz-stat-label { font-size:11px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--text-secondary); margin-bottom:8px; }
      .cz-stat-value { font-size:28px; font-weight:800; line-height:1; }
      .cz-stat-sub { font-size:11px; color:var(--text-secondary); margin-top:6px; }

      /* ── Order search ── */
      .cz-order-search { position:relative; margin-bottom:16px; }
      .cz-order-search input { width:100%; padding:9px 14px 9px 36px; background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; color:var(--text-primary,#fff); font-size:13px; box-sizing:border-box; }
      .cz-order-search input:focus { outline:none; border-color:var(--accent,#f891a5); }
      .cz-order-search::before { content:"⌕"; position:absolute; left:11px; top:50%; transform:translateY(-50%); color:var(--text-secondary); font-size:16px; pointer-events:none; }
      .cz-order-meta { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
      .cz-order-date { font-size:11px; color:var(--text-secondary); }
      .cz-order-total { font-size:13px; font-weight:700; }
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

  function statusChipClass(status) {
    const s = String(status || '').toLowerCase().replace(/\s+/g, '_');
    const known = ['unfulfilled','picking','packed','shipped','delivered','returned','cancelled','refunded','paid','clear','review','high_risk','blocked'];
    return known.includes(s) ? `commerce-chip cz-chip-${s}` : 'commerce-chip cz-chip-default';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' })
      + ' · ' + d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
  }

  const TABS = [
    { id:'overview',   label:'Overview' },
    { id:'orders',     label:'Orders' },
    { id:'cancelled',  label:'Cancelled & Refunded' },
    { id:'returns',    label:'Returns' },
    { id:'promotions', label:'Promotions' },
    { id:'inventory',  label:'Inventory' },
    { id:'customers',  label:'Customers' },
    { id:'settings',   label:'Settings' },
  ];

  function renderTabs() {
    return `<div class="cz-tabs" id="czTabBar">
      ${TABS.map(t => `<button class="cz-tab${state.activeTab === t.id ? ' active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}
    </div>`;
  }

  function renderOverview() {
    const metrics = computeConversionMetrics();
    const invMetrics = computeInventoryMetrics();
    const openReturns = (state.returnsState.requests || []).filter(r => !['closed','refunded'].includes(r.status)).length;
    const livePromos = (state.config.promotions || []).filter(p => p.active !== false).length;
    const recentOrders = state.orders.slice(0, 8);

    return `
      <div class="cz-stat-grid">
        <div class="cz-stat"><div class="cz-stat-label">Total Revenue</div><div class="cz-stat-value">${money(metrics.revenue)}</div><div class="cz-stat-sub">${metrics.totalOrders} orders</div></div>
        <div class="cz-stat"><div class="cz-stat-label">Avg Order Value</div><div class="cz-stat-value">${money(metrics.aov)}</div><div class="cz-stat-sub">per transaction</div></div>
        <div class="cz-stat"><div class="cz-stat-label">Repeat Rate</div><div class="cz-stat-value">${metrics.repeatRate.toFixed(1)}%</div><div class="cz-stat-sub">${metrics.repeatCustomers} repeat buyers</div></div>
        <div class="cz-stat"><div class="cz-stat-label">Open Returns</div><div class="cz-stat-value">${openReturns}</div><div class="cz-stat-sub">awaiting action</div></div>
        <div class="cz-stat"><div class="cz-stat-label">Low-Stock Variants</div><div class="cz-stat-value">${invMetrics.lowStockCount}</div><div class="cz-stat-sub">below reorder point</div></div>
        <div class="cz-stat"><div class="cz-stat-label">Live Promotions</div><div class="cz-stat-value">${livePromos}</div><div class="cz-stat-sub">active discount codes</div></div>
      </div>

      <div class="commerce-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <h3 style="margin:0">Recent Orders</h3>
          <button class="btn btn-secondary btn-sm" data-tab="orders">View All</button>
        </div>
        <table class="commerce-mini-table">
          <thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Total</th><th>Status</th></tr></thead>
          <tbody>
            ${recentOrders.length ? recentOrders.map(order => {
              const override = state.orderOps[order.id] || {};
              const status = override.fulfillmentStatus || order.fulfillment_status || 'unfulfilled';
              return `<tr>
                <td><strong>${escapeHtml(order.order_number || '#' + String(order.id||'').slice(-8).toUpperCase())}</strong></td>
                <td>${escapeHtml(order.email || order.customer_name || 'Unknown')}</td>
                <td class="cz-order-date">${fmtDate(order.created_at)}</td>
                <td class="cz-order-total">${money(orderTotal(order))}</td>
                <td><span class="${statusChipClass(status)}">${escapeHtml(status)}</span></td>
              </tr>`;
            }).join('') : '<tr><td colspan="5" class="commerce-muted">No orders yet.</td></tr>'}
          </tbody>
        </table>
      </div>

      ${invMetrics.lowStockCount > 0 ? `
      <div class="commerce-card" style="margin-top:16px;border-color:rgba(255,200,60,.25);">
        <h3 style="color:#f5c842;margin-bottom:12px">⚠ Low-Stock Alert</h3>
        <table class="commerce-mini-table">
          <thead><tr><th>Product</th><th>Variant</th><th>Available</th><th>Reorder at</th></tr></thead>
          <tbody>
            ${invMetrics.rows.filter(r => r.lowStock).slice(0, 6).map(r => `
              <tr>
                <td><strong>${escapeHtml(r.productTitle)}</strong></td>
                <td>${escapeHtml(r.variantLabel)}</td>
                <td style="color:#f5c842;font-weight:700">${r.available}</td>
                <td>${r.reorderPoint}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>` : ''}
    `;
  }

  function renderCancelledOrders() {
    const cancelled = state.orders.filter(o =>
      ['cancelled', 'refunded'].includes(String(o.status || '').toLowerCase()) ||
      String(o.fulfillment_status || '').toLowerCase() === 'cancelled'
    );

    const totalRefunded = cancelled
      .filter(o => String(o.status || '').toLowerCase() === 'refunded')
      .reduce((sum, o) => sum + orderTotal(o), 0);

    const totalCancelled = cancelled
      .filter(o => String(o.status || '').toLowerCase() === 'cancelled')
      .length;

    const totalRefundedCount = cancelled
      .filter(o => String(o.status || '').toLowerCase() === 'refunded')
      .length;

    return `
      <div class="cz-stat-grid" style="margin-bottom:20px;">
        <div class="cz-stat"><div class="cz-stat-label">Cancelled Orders</div><div class="cz-stat-value">${totalCancelled}</div><div class="cz-stat-sub">no payment returned</div></div>
        <div class="cz-stat"><div class="cz-stat-label">Refunded Orders</div><div class="cz-stat-value">${totalRefundedCount}</div><div class="cz-stat-sub">money returned to customer</div></div>
        <div class="cz-stat"><div class="cz-stat-label">Total Refunded</div><div class="cz-stat-value">${money(totalRefunded)}</div><div class="cz-stat-sub">across all refunded orders</div></div>
      </div>

      <div class="commerce-card">
        <h3 style="margin-bottom:14px;">Cancelled & Refunded Orders</h3>
        ${cancelled.length ? `
          <table class="commerce-mini-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Date</th>
                <th>Total</th>
                <th>Status</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              ${cancelled.map(order => {
                const status = String(order.status || '').toLowerCase();
                const ops = state.orderOps[order.id] || {};
                return `<tr>
                  <td><strong>${escapeHtml(order.order_number || '#' + String(order.id||'').slice(-8).toUpperCase())}</strong></td>
                  <td>
                    ${escapeHtml(order.email || order.customer_name || 'Unknown')}
                  </td>
                  <td class="cz-order-date">${fmtDate(order.created_at)}</td>
                  <td class="cz-order-total">${money(orderTotal(order))}</td>
                  <td><span class="${statusChipClass(status)}">${escapeHtml(status)}</span></td>
                  <td class="commerce-muted">${escapeHtml(ops.notes || '—')}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        ` : `<div class="commerce-muted">No cancelled or refunded orders yet.</div>`}
      </div>
    `;
  }

  function renderPromotions() {
    const promos = Array.isArray(state.config.promotions) ? state.config.promotions : [];
    const showPromo = state.config.show_promo_code !== false;
    return `
      <div class="commerce-card">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;">
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

  function renderReturns() {
    const requests = Array.isArray(state.returnsState.requests) ? state.returnsState.requests : [];
    const rp = state.config.returnsPolicy || {};
    return `
      <div class="commerce-card" style="margin-bottom:16px;">
        <h3>Return Policy</h3>
        <div class="commerce-muted" style="margin-bottom:14px;">This policy text appears on your storefront returns page and is shown to customers before they submit a request.</div>
        <div class="commerce-input-grid">
          <div>
            <label>Return window (days)</label>
            <input class="form-input" id="rp-window" type="number" min="1" max="365" value="${Number(rp.windowDays || 30)}">
          </div>
          <div>
            <label>Item eligibility</label>
            <select class="form-select" id="rp-eligibility">
              <option value="all" ${(rp.eligibility || 'all') === 'all' ? 'selected' : ''}>All items</option>
              <option value="no_sale" ${rp.eligibility === 'no_sale' ? 'selected' : ''}>Exclude sale items</option>
              <option value="none" ${rp.eligibility === 'none' ? 'selected' : ''}>All sales final (no returns)</option>
            </select>
          </div>
          <div>
            <label>Return shipping paid by</label>
            <select class="form-select" id="rp-shipping">
              <option value="store" ${(rp.shippingPaidBy || 'store') === 'store' ? 'selected' : ''}>Store (free returns)</option>
              <option value="customer" ${rp.shippingPaidBy === 'customer' ? 'selected' : ''}>Customer</option>
            </select>
          </div>
        </div>
        <div style="margin-top:12px;">
          <label>Policy description (shown to customers)</label>
          <textarea class="form-input" id="rp-text" rows="4" style="resize:vertical;margin-top:4px;">${escapeHtml(rp.policyText || 'We want you to love your Zuwera piece. If something isn\'t right, you can return it within 30 days of delivery for a full refund or exchange. Items must be unworn, unwashed, and in their original packaging with tags attached.')}</textarea>
        </div>
      </div>

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
              <div class="commerce-muted" style="margin-top:10px;">${escapeHtml(request.userEmail || request.userId || '')} &middot; ${new Date(request.createdAt || Date.now()).toLocaleString()}</div>
              ${request.labelUrl ? `
                <div style="margin-top:10px;padding:10px 12px;background:rgba(100,220,140,.06);border:1px solid rgba(100,220,140,.15);font-size:13px;">
                  <strong style="color:rgba(100,220,140,.9)">Label generated</strong>
                  <div class="commerce-muted" style="margin-top:4px;">Tracking: ${escapeHtml(request.trackingNumber || '')} (${escapeHtml(request.carrier || '')})</div>
                  <a href="${escapeHtml(request.labelUrl)}" target="_blank" style="font-size:12px;color:var(--accent,#a0e0b0);text-decoration:underline;display:inline-block;margin-top:4px;">View / Download Label PDF</a>
                </div>` : ''}
              <div class="commerce-actions" style="flex-wrap:wrap;gap:8px;">
                <button class="btn btn-secondary btn-sm" data-save-return="${escapeHtml(request.id)}">Save</button>
                ${(request.status === 'approved' || request.status === 'label_sent') && !request.labelUrl ? `
                  <button class="btn btn-primary btn-sm" data-gen-label="${escapeHtml(request.id)}" data-order-id="${escapeHtml(request.orderId || '')}" data-resolution="${escapeHtml(request.resolution || 'return')}">
                    Generate Return Label
                  </button>` : ''}
                ${request.status === 'label_sent' && request.labelUrl ? `
                  <button class="btn btn-secondary btn-sm" data-gen-label="${escapeHtml(request.id)}" data-order-id="${escapeHtml(request.orderId || '')}" data-resolution="${escapeHtml(request.resolution || 'return')}" style="opacity:.6">
                    Regenerate Label
                  </button>` : ''}
                <span class="commerce-muted" id="label-status-${escapeHtml(request.id)}" style="font-size:12px;align-self:center;"></span>
              </div>
            </div>
          `).join('') : '<div class="commerce-muted" style="margin-top:12px;">No return requests yet.</div>'}
        </div>
      </div>
    `;
  }

  function readReturnsPolicyFromDom() {
    return {
      windowDays: parseInt($('rp-window')?.value || '30', 10) || 30,
      eligibility: $('rp-eligibility')?.value || 'all',
      shippingPaidBy: $('rp-shipping')?.value || 'store',
      policyText: $('rp-text')?.value?.trim() || '',
    };
  }

  function renderOrderWorkflow() {
    const q = state.orderSearch.toLowerCase().trim();
    const filtered = q
      ? state.orders.filter(o =>
          String(o.id||'').toLowerCase().includes(q) ||
          String(o.email||'').toLowerCase().includes(q) ||
          String(o.customer_name||'').toLowerCase().includes(q) ||
          String(o.status||'').toLowerCase().includes(q) ||
          String(o.fulfillment_status||'').toLowerCase().includes(q)
        )
      : state.orders;
    const visible = filtered.slice(0, 50);

    return `
      <div class="cz-order-search">
        <input id="czOrderSearch" type="text" placeholder="Search by order ID, email, or status…" value="${escapeHtml(state.orderSearch)}">
      </div>
      <div class="commerce-muted" style="margin-bottom:12px;">Showing ${visible.length} of ${filtered.length} orders${q ? ` matching "${escapeHtml(q)}"` : ''}</div>
      <div>
        ${visible.map((order) => {
          const override = state.orderOps[order.id] || {};
          const total = orderTotal(order);
          const fulfillStatus = override.fulfillmentStatus || order.fulfillment_status || 'unfulfilled';
          const fraudStatus = override.fraudStatus || 'clear';
          const orderStatus = order.status || 'pending';
          return `
            <div class="commerce-order-item" data-order-id="${escapeHtml(order.id)}">
              <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;">
                <div>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <strong>${escapeHtml(order.order_number || '#' + String(order.id || '').slice(-8).toUpperCase())}</strong>
                    <span class="${statusChipClass(fulfillStatus)}">${escapeHtml(fulfillStatus)}</span>
                    ${orderStatus !== 'active' ? `<span class="${statusChipClass(orderStatus)}">${escapeHtml(orderStatus)}</span>` : ''}
                    ${fraudStatus !== 'clear' ? `<span class="${statusChipClass(fraudStatus)}">${escapeHtml(fraudStatus)}</span>` : ''}
                  </div>
                  <div class="cz-order-meta" style="margin-top:5px;">
                    <span>${escapeHtml(order.email || order.customer_name || 'Unknown customer')}</span>
                    <span class="cz-order-date">${fmtDate(order.created_at)}</span>
                    <span class="cz-order-total">${money(total)}</span>
                  </div>
                </div>
              </div>
              ${(() => { try { const its = parseOrderItems(order); if (its.length) return `<div style="margin:8px 0 4px;font-size:12px;color:var(--text-secondary,#888);line-height:1.6">${its.map((it) => `${escapeHtml(it.name || it.title || 'Item')} ×${it.quantity || 1}${it.size ? ` · ${escapeHtml(it.size)}` : ''}`).join(' &nbsp;·&nbsp; ')}</div>`; } catch {} return ''; })()}
              <div class="commerce-input-grid" style="margin-top:12px;">
                <div><label>Fulfillment</label>
                  <select class="form-select" data-order-field="fulfillmentStatus">
                    ${['unfulfilled', 'picking', 'packed', 'shipped', 'delivered', 'returned'].map((value) => `<option value="${value}" ${fulfillStatus === value ? 'selected' : ''}>${value}</option>`).join('')}
                  </select>
                </div>
                <div><label>Fraud</label>
                  <select class="form-select" data-order-field="fraudStatus">
                    ${['clear', 'review', 'high_risk', 'blocked'].map((value) => `<option value="${value}" ${fraudStatus === value ? 'selected' : ''}>${value}</option>`).join('')}
                  </select>
                </div>
                <div><label>Tracking #</label><input class="form-input" data-order-field="trackingNumber" value="${escapeHtml(override.trackingNumber || order.tracking_number || '')}"></div>
                <div><label>Tracking URL</label><input class="form-input" data-order-field="trackingUrl" value="${escapeHtml(override.trackingUrl || order.tracking_url || '')}"></div>
              </div>
              <div class="commerce-input-grid" style="margin-top:10px;">
                <div><label>Tags</label><input class="form-input" data-order-field="tags" value="${escapeHtml(Array.isArray(override.tags) ? override.tags.join(', ') : '')}" placeholder="vip, launch-day, wholesale"></div>
                <div><label>Internal notes</label><input class="form-input" data-order-field="notes" value="${escapeHtml(override.notes || '')}" placeholder="Refund approved, size swap pending"></div>
              </div>
              <div class="commerce-actions">
                <button class="btn btn-secondary btn-sm" data-save-order="${escapeHtml(order.id)}">Save</button>
                <button class="btn btn-danger btn-sm" data-order-action="cancel-refund" data-order-id="${escapeHtml(order.id)}" data-order-label="${escapeHtml(order.order_number || '#' + String(order.id||'').slice(-8).toUpperCase())}" data-order-total="${total}" data-order-email="${escapeHtml(order.email || '')}">Cancel / Refund</button>
              </div>
            </div>
          `;
        }).join('')}
        ${visible.length === 0 ? '<div class="commerce-muted">No orders match your search.</div>' : ''}
      </div>
    `;
  }

  // ── Refund / Cancel modal ────────────────────────────────────────────────────
  let _zwRefOrderId = null;
  let _zwRefTotal   = 0;

  function mountRefundModal() {
    if (document.getElementById('zw-refund-overlay')) return;
    const el = document.createElement('div');
    el.id = 'zw-refund-overlay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.84);align-items:center;justify-content:center;padding:1rem';
    el.innerHTML = `
      <div style="background:var(--bg-primary,#141414);border:1px solid var(--border,rgba(255,255,255,.12));border-top:3px solid #e05050;border-radius:14px;padding:2rem 2rem 1.6rem;max-width:500px;width:100%;max-height:90dvh;overflow-y:auto">
        <h3 style="margin:0 0 4px;font-size:1.1rem;font-weight:700">Cancel / Refund Order</h3>
        <div id="zw-ref-summary" style="font-size:13px;color:var(--text-secondary,#888);padding-bottom:1rem;border-bottom:1px solid var(--border,rgba(255,255,255,.08));margin-bottom:1.4rem"></div>

        <div style="margin-bottom:1.3rem">
          <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px">Action</div>
          <label style="display:flex;gap:10px;margin-bottom:10px;cursor:pointer;font-size:13px;line-height:1.45">
            <input type="radio" name="zw-ref-act" value="cancel" style="margin-top:3px;accent-color:#e05050;flex-shrink:0">
            <span><strong>Cancel only</strong> — no money returned<br><span style="color:var(--text-secondary,#888);font-size:12px">Use when payment never succeeded or was already voided.</span></span>
          </label>
          <label style="display:flex;gap:10px;margin-bottom:10px;cursor:pointer;font-size:13px;line-height:1.45">
            <input type="radio" name="zw-ref-act" value="cancel_refund" checked style="margin-top:3px;accent-color:#e05050;flex-shrink:0">
            <span><strong>Cancel + Full Refund</strong><br><span style="color:var(--text-secondary,#888);font-size:12px">Cancel the order and return the full amount via Stripe.</span></span>
          </label>
          <label style="display:flex;gap:10px;cursor:pointer;font-size:13px;line-height:1.45">
            <input type="radio" name="zw-ref-act" value="refund" style="margin-top:3px;accent-color:#e05050;flex-shrink:0">
            <span><strong>Partial Refund</strong> — order stays open<br><span style="color:var(--text-secondary,#888);font-size:12px">Refund a specific dollar amount. Order status is unchanged.</span></span>
          </label>
        </div>

        <div id="zw-ref-partial-row" style="display:none;margin-bottom:1.3rem">
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px">Refund Amount (USD)</label>
          <div style="display:flex;align-items:center;gap:6px">
            <span style="color:var(--text-secondary,#888)">$</span>
            <input id="zw-ref-amount" type="number" min="0.01" step="0.01" class="form-input" placeholder="0.00" style="max-width:130px">
          </div>
          <div style="font-size:11px;color:var(--text-secondary,#888);margin-top:5px">Order total: <span id="zw-ref-max-label">—</span></div>
        </div>

        <div style="margin-bottom:1.3rem">
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px">Reason</label>
          <select id="zw-ref-reason" class="form-select">
            <option value="customer_request">Customer request</option>
            <option value="out_of_stock">Item out of stock / unfulfillable</option>
            <option value="duplicate">Duplicate order</option>
            <option value="fraudulent">Fraudulent</option>
            <option value="other">Other</option>
          </select>
        </div>

        <div style="margin-bottom:1.3rem">
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:6px">Note to Customer <span style="font-weight:400;color:var(--text-secondary,#888)">(optional)</span></label>
          <textarea id="zw-ref-note" class="form-textarea" rows="3" placeholder="Add a personal message that will appear in the refund email…" style="resize:vertical;font-size:13px;line-height:1.5"></textarea>
        </div>

        <div style="background:rgba(224,80,80,0.08);border:1px solid rgba(224,80,80,0.22);border-radius:8px;padding:12px 14px;margin-bottom:1.5rem">
          <div style="color:#e05050;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px">⚠ Irreversible</div>
          <div style="font-size:12px;color:var(--text-secondary,#999);line-height:1.5">Stripe refunds cannot be undone and money is returned immediately. Confirm the customer request before submitting.</div>
        </div>

        <div style="margin-bottom:1.6rem">
          <label style="display:block;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:5px">Refund Authorization Code</label>
          <div style="font-size:12px;color:var(--text-secondary,#888);margin-bottom:8px;line-height:1.5">Required for every refund. Separate from your admin password and never stored in the browser. 5 wrong attempts locks access for 1 hour and alerts your email.</div>
          <input id="zw-ref-key" type="password" class="form-input" autocomplete="new-password" placeholder="Enter your authorization code" spellcheck="false">
        </div>

        <div style="display:flex;gap:10px">
          <button id="zw-ref-close" class="btn btn-secondary" style="flex:1">Close</button>
          <button id="zw-ref-submit" class="btn btn-danger" style="flex:1;background:#e05050;border-color:#c03030">Confirm</button>
        </div>
        <div id="zw-ref-error" style="margin-top:12px;color:#e05050;font-size:12px;min-height:18px;text-align:center"></div>
      </div>
    `;
    document.body.appendChild(el);

    el.addEventListener('click', (e) => { if (e.target === el) zwCloseRefundModal(); });
    document.getElementById('zw-ref-close').addEventListener('click', zwCloseRefundModal);
    el.querySelectorAll('[name="zw-ref-act"]').forEach((r) => r.addEventListener('change', () => {
      const partial = document.querySelector('[name="zw-ref-act"]:checked')?.value === 'refund';
      document.getElementById('zw-ref-partial-row').style.display = partial ? 'block' : 'none';
    }));
    document.getElementById('zw-ref-submit').addEventListener('click', zwSubmitRefund);
    document.getElementById('zw-ref-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') zwSubmitRefund(); });
  }

  function zwOpenRefundModal(orderId, total, email, label) {
    _zwRefOrderId = orderId;
    _zwRefTotal   = parseFloat(total) || 0;
    document.getElementById('zw-ref-summary').innerHTML =
      `<strong>${escapeHtml(label || String(orderId))}</strong> &nbsp;·&nbsp; ${escapeHtml(email || 'Customer')} &nbsp;·&nbsp; <strong>${money(_zwRefTotal)}</strong>`;
    document.getElementById('zw-ref-max-label').textContent = money(_zwRefTotal);
    document.querySelector('[name="zw-ref-act"][value="cancel_refund"]').checked = true;
    document.getElementById('zw-ref-partial-row').style.display = 'none';
    document.getElementById('zw-ref-amount').value  = '';
    document.getElementById('zw-ref-reason').value  = 'customer_request';
    document.getElementById('zw-ref-note').value    = '';
    document.getElementById('zw-ref-key').value     = '';
    document.getElementById('zw-ref-error').textContent = '';
    const overlay = document.getElementById('zw-refund-overlay');
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    setTimeout(() => document.getElementById('zw-ref-key')?.focus(), 120);
  }

  function zwCloseRefundModal() {
    const el = document.getElementById('zw-refund-overlay');
    if (el) el.style.display = 'none';
    document.body.style.overflow = '';
    const key = document.getElementById('zw-ref-key');
    if (key) key.value = '';
  }

  async function zwSubmitRefund() {
    const action      = document.querySelector('[name="zw-ref-act"]:checked')?.value;
    const refundKey   = (document.getElementById('zw-ref-key')?.value || '').trim();
    const reason      = document.getElementById('zw-ref-reason')?.value || 'customer_request';
    const customerNote = (document.getElementById('zw-ref-note')?.value || '').trim();
    const errEl       = document.getElementById('zw-ref-error');
    const btn      = document.getElementById('zw-ref-submit');
    if (errEl) errEl.textContent = '';

    if (!refundKey) {
      if (errEl) errEl.textContent = 'Authorization code is required.';
      document.getElementById('zw-ref-key')?.focus();
      return;
    }

    let amountCents = null;
    if (action === 'refund') {
      const raw = parseFloat(document.getElementById('zw-ref-amount')?.value || '');
      if (!raw || raw <= 0)             { if (errEl) errEl.textContent = 'Enter a refund amount greater than $0.'; return; }
      if (raw > _zwRefTotal + 0.005)    { if (errEl) errEl.textContent = `Cannot exceed order total of ${money(_zwRefTotal)}.`; return; }
      amountCents = Math.round(raw * 100);
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }

    try {
      const session = await window.sb.auth.getSession();
      const token   = session?.data?.session?.access_token;
      if (!token) throw new Error('Session expired. Refresh the page and try again.');

      const resp = await fetch('/api/admin-refund', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ accessToken: token, orderId: _zwRefOrderId, refundKey, action, amountCents, reason, customerNote }),
      });
      const data = await resp.json().catch(() => ({}));

      if (!resp.ok || !data.success) {
        if (errEl) errEl.textContent = data.error || 'Request failed. Try again.';
        if (btn) { btn.disabled = false; btn.textContent = 'Confirm'; }
        const keyEl = document.getElementById('zw-ref-key');
        if (keyEl) { keyEl.value = ''; keyEl.focus(); }
        return;
      }

      zwCloseRefundModal();
      const label = action === 'cancel' ? 'Order cancelled' : action === 'cancel_refund' ? 'Order cancelled & refunded' : 'Partial refund issued';
      const statusEl = $('commerceStatus');
      if (statusEl) statusEl.textContent = `✓ ${label}${data.stripeRefundId ? ` — Stripe ${data.stripeRefundId}` : ''}`;
      await loadCommerceData();
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Network error. Try again.';
      if (btn) { btn.disabled = false; btn.textContent = 'Confirm'; }
      const keyEl = document.getElementById('zw-ref-key');
      if (keyEl) { keyEl.value = ''; keyEl.focus(); }
    }
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

    let tabContent = '';
    switch (state.activeTab) {
      case 'overview':
        tabContent = renderOverview();
        break;
      case 'orders':
        tabContent = `<div class="commerce-card">${renderOrderWorkflow()}</div>`;
        break;
      case 'cancelled':
        tabContent = renderCancelledOrders();
        break;
      case 'returns':
        tabContent = renderReturns();
        break;
      case 'promotions':
        tabContent = renderPromotions();
        break;
      case 'inventory':
        tabContent = renderInventoryDepth();
        break;
      case 'customers':
        tabContent = renderCustomerCrm();
        break;
      case 'settings':
        tabContent = renderIntegrations() + '<div style="margin-top:16px;">' + renderAnalytics() + '</div>';
        break;
      default:
        tabContent = renderOverview();
    }

    mount.innerHTML = renderTabs() + tabContent;
    bindCommerceEvents();
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
    mountRefundModal();

    // Tab navigation
    document.querySelectorAll('.cz-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activeTab = btn.dataset.tab;
        renderCommerce();
      });
    });

    // "View All" from overview recent orders table
    document.querySelectorAll('[data-tab]').forEach((btn) => {
      if (btn.classList.contains('cz-tab')) return;
      btn.addEventListener('click', () => {
        state.activeTab = btn.dataset.tab;
        renderCommerce();
      });
    });

    // Order search
    const searchEl = $('czOrderSearch');
    if (searchEl) {
      searchEl.addEventListener('input', () => {
        state.orderSearch = searchEl.value;
        renderCommerce();
      });
    }

    document.querySelectorAll('[data-order-action="cancel-refund"]').forEach((btn) => {
      btn.addEventListener('click', () => zwOpenRefundModal(btn.dataset.orderId, btn.dataset.orderTotal, btn.dataset.orderEmail, btn.dataset.orderLabel));
    });

    $('commerceAddPromoBtn')?.addEventListener('click', () => {
      if ($('commercePromoList')) state.config.promotions = readPromotionsFromDom();
      state.config.promotions = [...(state.config.promotions || []), { code: '', label: '', type: 'percent', value: 10, minSubtotal: 0, description: '', active: true, expirationDate: '', maxUsage: null, usageCount: 0 }];
      renderCommerce();
    });

    $('commerceSavePromosBtn')?.addEventListener('click', async () => {
      const btn = $('commerceSavePromosBtn');
      const orig = btn.textContent;
      // Sync from DOM and validate before saving
      if ($('commercePromoList')) state.config.promotions = readPromotionsFromDom();
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
        if ($('commercePromoList')) state.config.promotions = readPromotionsFromDom();
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

    document.querySelectorAll('[data-gen-label]').forEach((button) => {
      button.addEventListener('click', async () => {
        const returnId = button.dataset.genLabel;
        const orderId  = button.dataset.orderId;
        const statusEl = document.getElementById(`label-status-${returnId}`);
        if (!orderId) { if (statusEl) statusEl.textContent = 'Error: no order ID on this request.'; return; }

        button.disabled = true;
        if (statusEl) statusEl.textContent = 'Generating label…';

        try {
          const session = await window.sb.auth.getSession();
          const token = session?.data?.session?.access_token;
          if (!token) throw new Error('Not signed in');

          const returnRequest = (state.returnsState.requests || []).find(r => r.id === returnId) || {};

          const resp = await fetch('/api/generate-return-label', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accessToken: token, returnId, orderId, returnRequest }),
          });
          const data = await resp.json();
          if (!data.ok) throw new Error(data.error || 'Unknown error');

          // Update local state
          const requests = Array.isArray(state.returnsState.requests) ? [...state.returnsState.requests] : [];
          const idx = requests.findIndex(r => r.id === returnId);
          if (idx !== -1) {
            requests[idx] = { ...requests[idx], status: 'label_sent', labelUrl: data.labelUrl, trackingNumber: data.trackingNumber, trackingUrl: data.trackingUrl, carrier: data.carrier, labelSentAt: new Date().toISOString() };
            state.returnsState.requests = requests;
          }

          if (statusEl) statusEl.innerHTML = `✓ Label sent &mdash; <a href="${data.labelUrl}" target="_blank" style="color:var(--accent,#a0e0b0)">Download PDF</a> &middot; Tracking: ${data.trackingNumber}`;
          button.style.display = 'none';
        } catch (e) {
          if (statusEl) statusEl.textContent = `Error: ${e.message}`;
          button.disabled = false;
        }
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
    if ($('commercePromoList')) state.config.promotions = readPromotionsFromDom();
    const showPromoEl = $('commerceShowPromoCode');
    if (showPromoEl) state.config.show_promo_code = showPromoEl.checked;
    if ($('rp-window')) state.config.returnsPolicy = readReturnsPolicyFromDom();
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
      return false;
    }
    $('commerceStatus').textContent = message || 'Commerce settings saved.';
    return true;
  }

  function installNavigationHook() {
    const originalNavigateTo = window.navigateTo;
    if (typeof originalNavigateTo !== 'function' || originalNavigateTo.__commerceWrapped) return;
    window.navigateTo = function (page) {
      if (page === 'commerce') {
        state.activeTab = 'promotions';
        document.querySelectorAll('.page').forEach((node) => node.classList.remove('active'));
        $('commerce')?.classList.add('active');
        document.querySelectorAll('.nav-link').forEach((node) => node.classList.remove('active'));
        document.querySelector('[data-page="commerce"]')?.classList.add('active');
        $('pageTitle').textContent = 'Commerce';
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
