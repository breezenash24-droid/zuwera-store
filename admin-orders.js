// Orders — operational order-management table for the admin panel.
//
// Complements the Receipts page (which shows per-order receipt cards): this is a
// scannable, filterable table of every order with status + fulfillment at a
// glance, an expandable detail row, summary KPIs, and CSV export. Read-only.
//
// Loaded by admin.html inside <div id="orders" class="page">. Reads the global
// `sb` Supabase client and the shared helpers (escapeHtml, escapeAttr, fmt$,
// safeHttpUrl, sectionEl, zwExportCSV) defined in admin.html.
(function () {
  'use strict';

  let _ordLoaded = false;
  let _listenersAttached = false;
  let _all = [];        // every order
  let _filtered = [];   // after search/status/fulfillment filters
  const _expanded = new Set(); // order ids whose detail row is open

  // ── helpers ────────────────────────────────────────────────────────────────
  function ordErr(msg) {
    const el = sectionEl('ord-error');
    if (!el) return;
    el.textContent = msg || '';
    el.style.display = msg ? 'block' : 'none';
  }

  function parseItems(o) {
    try {
      const a = typeof o.items === 'string' ? JSON.parse(o.items) : (o.items || []);
      return Array.isArray(a) ? a : [];
    } catch (_) { return []; }
  }
  // orders.items[].amount is CENTS; quantity is `quantity` (fallback `qty`).
  const itemUnit = (it) => (it.amount != null ? Number(it.amount) / 100 : Number(it.price || 0)) || 0;
  const itemQty = (it) => Number(it.quantity != null ? it.quantity : (it.qty != null ? it.qty : 1)) || 1;
  const itemCount = (o) => parseItems(o).reduce((n, it) => n + itemQty(it), 0);

  const orderNumOf = (o) => o.order_number || '#' + String(o.stripe_payment_intent_id || o.id || '').slice(-8).toUpperCase();

  function ordDate(v, withTime) {
    const d = new Date(v || 0);
    if (isNaN(d.getTime())) return '—';
    const opts = withTime
      ? { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
      : { year: 'numeric', month: 'short', day: 'numeric' };
    return d.toLocaleDateString(undefined, opts);
  }

  // 'shipped' (has tracking) | 'refunded' | 'awaiting'
  function fulfillment(o) {
    if (o.status === 'refunded') return 'refunded';
    if (o.delivery_method === 'hand_delivery') return 'hand_delivery';
    return (o.tracking_number && String(o.tracking_number).trim()) ? 'shipped' : 'awaiting';
  }

  function statusBadge(o) {
    const s = o.status || 'unknown';
    const color = s === 'refunded' ? '#ef4444' : (s === 'completed' || s === 'delivered') ? '#10b981' : '#f59e0b';
    return `<span style="display:inline-block;padding:3px 9px;border-radius:99px;font-size:11px;font-weight:600;background:${color};color:#fff;">${escapeHtml(s)}</span>`;
  }

  function fulfillBadge(o) {
    const f = fulfillment(o);
    if (f === 'hand_delivery') return `<span style="color:var(--accent);font-weight:600;font-size:12px;">🚶 Hand delivery</span>`;
    if (f === 'shipped') return `<span style="color:var(--success,#10b981);font-weight:600;font-size:12px;">● Shipped</span>`;
    if (f === 'refunded') return `<span style="color:var(--text-secondary);font-size:12px;">—</span>`;
    return `<span style="color:var(--warning,#f59e0b);font-weight:600;font-size:12px;">● Awaiting</span>`;
  }

  // ── data ─────────────────────────────────────────────────────────────────
  window.ordersLoadData = async function () {
    ordErr('');
    if (_ordLoaded) { applyFilters(); return; }
    const container = sectionEl('ord-table-wrap');
    try {
      const { data, error } = await sb
        .from('orders')
        .select('id,order_number,stripe_payment_intent_id,created_at,customer_name,email,total,subtotal,shipping,tax,status,items,ship_line1,ship_line2,ship_city,ship_state,ship_zip,ship_country,shipping_provider,shipping_service,tracking_number,tracking_url,delivery_method,feature_flags')
        .order('created_at', { ascending: false });
      if (error) throw error;
      _all = data || [];
      _ordLoaded = true;
      populateStatusFilter();
      attachListeners();
      applyFilters();
    } catch (err) {
      if (container) container.innerHTML = '';
      ordErr('Could not load orders: ' + (err && err.message ? err.message : 'unknown error'));
    }
  };

  function populateStatusFilter() {
    const sel = sectionEl('ord-status');
    if (!sel) return;
    const statuses = Array.from(new Set(_all.map(o => o.status).filter(Boolean))).sort();
    const current = sel.value || 'all';
    sel.innerHTML = '<option value="all">All statuses</option>' +
      statuses.map(s => `<option value="${escapeAttr(s)}">${escapeHtml(s.charAt(0).toUpperCase() + s.slice(1))}</option>`).join('');
    sel.value = current;
  }

  // ── filtering / sorting ────────────────────────────────────────────────────
  function applyFilters() {
    const q = (sectionEl('ord-search')?.value || '').toLowerCase().trim();
    const status = sectionEl('ord-status')?.value || 'all';
    const fulfil = sectionEl('ord-fulfil')?.value || 'all';
    const sortBy = sectionEl('ord-sort')?.value || 'newest';

    let rows = _all.filter(o => {
      if (status !== 'all' && (o.status || '') !== status) return false;
      if (fulfil !== 'all' && fulfillment(o) !== fulfil) return false;
      if (!q) return true;
      const hay = [
        orderNumOf(o), o.customer_name, o.email, o.ship_state, o.ship_city,
        o.tracking_number, fmt$(o.total || 0), o.status
      ].map(v => String(v || '').toLowerCase()).join(' ');
      return hay.includes(q);
    });

    rows.sort((a, b) => {
      if (sortBy === 'oldest') return new Date(a.created_at || 0) - new Date(b.created_at || 0);
      if (sortBy === 'highest') return (parseFloat(b.total) || 0) - (parseFloat(a.total) || 0);
      if (sortBy === 'lowest') return (parseFloat(a.total) || 0) - (parseFloat(b.total) || 0);
      return new Date(b.created_at || 0) - new Date(a.created_at || 0); // newest
    });

    _filtered = rows;
    updateStats();
    renderTable();
  }

  function updateStats() {
    const rows = _filtered;
    const revenue = rows.reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
    const avg = rows.length ? revenue / rows.length : 0;
    const awaiting = rows.filter(o => fulfillment(o) === 'awaiting').length;
    const set = (id, v) => { const el = sectionEl(id); if (el) el.textContent = v; };
    set('ord-kpi-count', rows.length.toLocaleString());
    set('ord-kpi-revenue', fmt$(revenue));
    set('ord-kpi-avg', fmt$(avg));
    set('ord-kpi-awaiting', awaiting.toLocaleString());
  }

  // ── rendering ──────────────────────────────────────────────────────────────
  function renderTable() {
    const wrap = sectionEl('ord-table-wrap');
    if (!wrap) return;

    if (!_filtered.length) {
      wrap.innerHTML = `<p style="text-align:center;color:var(--text-secondary);padding:44px;font-size:13px;">${_all.length ? 'No orders match your filters.' : 'No orders yet. When a customer checks out, their order appears here.'}</p>`;
      return;
    }

    const rowsHtml = _filtered.map(o => {
      const open = _expanded.has(o.id);
      const main = `
        <tr class="ord-row" data-id="${escapeAttr(o.id)}" style="cursor:pointer;border-top:1px solid var(--border);${open ? 'background:var(--bg-primary);' : ''}">
          <td style="padding:12px 14px;white-space:nowrap;">
            <span style="color:var(--text-secondary);font-size:11px;margin-right:6px;">${open ? '▾' : '▸'}</span>
            <span style="font-weight:600;font-size:13px;">${escapeHtml(orderNumOf(o))}</span>
          </td>
          <td style="padding:12px 14px;white-space:nowrap;font-size:12px;color:var(--text-secondary);">${escapeHtml(ordDate(o.created_at))}</td>
          <td style="padding:12px 14px;">
            <div style="font-size:13px;">${escapeHtml(o.customer_name || '—')}</div>
            <div style="font-size:11px;color:var(--text-secondary);">${escapeHtml(o.email || '')}</div>
          </td>
          <td style="padding:12px 14px;text-align:center;font-size:13px;color:var(--text-secondary);">${itemCount(o)}</td>
          <td style="padding:12px 14px;text-align:right;font-weight:700;font-size:13px;white-space:nowrap;">${fmt$(o.total || 0)}</td>
          <td style="padding:12px 14px;text-align:center;">${statusBadge(o)}</td>
          <td style="padding:12px 14px;text-align:center;white-space:nowrap;">${fulfillBadge(o)}</td>
        </tr>`;
      const detail = open
        ? `<tr class="ord-detail" data-detail="${escapeAttr(o.id)}"><td colspan="7" style="padding:0 14px 20px;background:var(--bg-primary);">${renderDetail(o)}</td></tr>`
        : '';
      return main + detail;
    }).join('');

    wrap.innerHTML = `
      <div style="overflow-x:auto;border:1px solid var(--border);border-radius:10px;">
        <table style="width:100%;border-collapse:collapse;min-width:720px;">
          <thead>
            <tr style="background:var(--bg-secondary);text-align:left;">
              <th style="padding:11px 14px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-secondary);font-weight:600;">Order</th>
              <th style="padding:11px 14px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-secondary);font-weight:600;">Date</th>
              <th style="padding:11px 14px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-secondary);font-weight:600;">Customer</th>
              <th style="padding:11px 14px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-secondary);font-weight:600;text-align:center;">Items</th>
              <th style="padding:11px 14px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-secondary);font-weight:600;text-align:right;">Total</th>
              <th style="padding:11px 14px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-secondary);font-weight:600;text-align:center;">Status</th>
              <th style="padding:11px 14px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-secondary);font-weight:600;text-align:center;">Fulfillment</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`;
  }

  function renderDetail(o) {
    const items = parseItems(o);
    const itemsHtml = items.length ? items.map(it => {
      const img = safeHttpUrl(it.image);
      const variant = [it.size, it.color || it.colorName].filter(Boolean).join(' · ');
      return `
        <div style="display:flex;gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
          ${img ? `<img src="${escapeAttr(img)}" alt="${escapeAttr(it.name || 'Item')}" style="width:46px;height:46px;border-radius:6px;object-fit:cover;flex-shrink:0;">` : ''}
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:500;">${escapeHtml(it.name || it.sku || 'Item')}</div>
            <div style="font-size:11px;color:var(--text-secondary);">${escapeHtml(variant || '')}</div>
          </div>
          <div style="font-size:12px;color:var(--text-secondary);white-space:nowrap;">${itemQty(it)} × ${fmt$(itemUnit(it))}</div>
        </div>`;
    }).join('') : '<div style="font-size:12px;color:var(--text-secondary);">No line items recorded.</div>';

    const trackUrl = safeHttpUrl(o.tracking_url);
    const trackLink = trackUrl ? `<a href="${escapeAttr(trackUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);text-decoration:none;">Track shipment ↗</a>` : '';
    const ff = (o.feature_flags && typeof o.feature_flags === 'object') ? Object.keys(o.feature_flags).filter(k => o.feature_flags[k]) : [];

    const addr = [
      o.ship_line1, o.ship_line2,
      [o.ship_city, o.ship_state].filter(Boolean).join(', '),
      o.ship_zip, o.ship_country
    ].filter(Boolean).map(escapeHtml).join('<br>');

    return `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:20px;padding-top:16px;">
        <div>
          <p class="zw-eyebrow">Items</p>
          ${itemsHtml}
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-secondary);margin-top:10px;"><span>Subtotal</span><span>${fmt$(o.subtotal || 0)}</span></div>
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-secondary);margin-top:4px;"><span>Shipping</span><span>${fmt$(o.shipping || 0)}</span></div>
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-secondary);margin-top:4px;"><span>Tax</span><span>${fmt$(o.tax || 0)}</span></div>
          <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;margin-top:8px;border-top:1px solid var(--border);padding-top:8px;"><span>Total</span><span style="color:var(--accent);">${fmt$(o.total || 0)}</span></div>
        </div>
        <div>
          <p class="zw-eyebrow">Shipping address</p>
          <p style="font-size:12px;line-height:1.7;">${addr || '<span style="color:var(--text-secondary);">No address on file</span>'}</p>
          <p class="zw-eyebrow" style="margin-top:16px;">Tracking</p>
          <p style="font-size:12px;line-height:1.6;">
            ${escapeHtml(o.shipping_provider || 'Not shipped')}${o.shipping_service ? ' — ' + escapeHtml(o.shipping_service) : ''}<br>
            <span style="color:var(--text-secondary);">${escapeHtml(o.tracking_number || '—')}</span><br>
            ${trackLink}
          </p>
        </div>
        <div>
          <p class="zw-eyebrow">Details</p>
          <div style="font-size:12px;line-height:1.9;">
            <div><span style="color:var(--text-secondary);">Placed:</span> ${escapeHtml(ordDate(o.created_at, true))}</div>
            <div><span style="color:var(--text-secondary);">Order #:</span> ${escapeHtml(orderNumOf(o))}</div>
            <div><span style="color:var(--text-secondary);">Payment:</span> ${escapeHtml(String(o.stripe_payment_intent_id || '—'))}</div>
            ${ff.length ? `<div><span style="color:var(--text-secondary);">Variants:</span> ${ff.map(escapeHtml).join(', ')}</div>` : ''}
          </div>
          <div style="margin-top:14px;">
            <button class="btn btn-secondary btn-sm" data-ro-ok onclick="navigateTo('receipts')">Open in Receipts →</button>
          </div>
        </div>
      </div>`;
  }

  // ── CSV export (respects current filters) ────────────────────────────────────
  window.ordersExportCSV = function () {
    const rows = (_filtered && _filtered.length ? _filtered : _all) || [];
    if (typeof window.zwExportCSV !== 'function') return;
    window.zwExportCSV('orders-{date}.csv', rows, [
      { label: 'Order', get: o => orderNumOf(o) },
      { label: 'Date', get: o => (o.created_at || '').slice(0, 10) },
      { label: 'Customer', get: o => o.customer_name || '' },
      { label: 'Email', get: o => o.email || '' },
      { label: 'Items', get: o => itemCount(o) },
      { label: 'Total', get: o => Number(o.total || 0).toFixed(2) },
      { label: 'Status', get: o => o.status || '' },
      { label: 'Fulfillment', get: o => fulfillment(o) },
      { label: 'State', get: o => o.ship_state || '' },
      { label: 'Tracking', get: o => o.tracking_number || '' }
    ]);
  };

  // ── listeners ────────────────────────────────────────────────────────────────
  function attachListeners() {
    if (_listenersAttached) return;
    _listenersAttached = true;

    ['ord-search', 'ord-status', 'ord-fulfil', 'ord-sort'].forEach(id => {
      const el = sectionEl(id);
      if (!el) return;
      const evt = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evt, applyFilters);
    });

    // Row toggle (delegated so it survives re-renders).
    const wrap = sectionEl('ord-table-wrap');
    if (wrap) {
      wrap.addEventListener('click', (e) => {
        const row = e.target.closest('.ord-row');
        if (!row) return;
        const id = row.getAttribute('data-id');
        if (!id) return;
        if (_expanded.has(id)) _expanded.delete(id); else _expanded.add(id);
        renderTable();
      });
    }
  }
})();
