// Pricing — price lists, scheduled changes, approvals, and the register.
//
// Everything on this page goes through /api/admin-prices. Nothing here writes
// to the pricing tables directly, and that is deliberate rather than tidiness:
// the register has to record the price BEFORE a change, and a before-figure the
// browser supplies is a before-figure the browser can invent. The server reads
// it from the database in the same request that writes the new row.
//
// It also means an admin cannot skip the audit line by not sending it — which
// is the difference between this and admin_audit_log, whose rows are inserted
// by admin-main.js from the browser.
//
// Reads the global `sb` client (for the session token only) and the shared
// helpers escapeHtml / escapeAttr / fmt$ / sectionEl defined in admin.html.
(function () {
  'use strict';

  let _loaded = false;
  let _lists = [];
  let _prices = [];
  let _audit = [];
  let _you = '';
  let _products = [];   // id, title + colourways, for the propose form
  let _pick = null;     // the chosen product
  let _live = null;     // /api/prices for _pick — what a shopper is charged TODAY
  let _query = '';      // product search text

  const $ = (id) => document.getElementById(id);
  const money = (cents) => '$' + (Number(cents || 0) / 100).toFixed(2);
  const dollars = (v) => (v === null || v === undefined || v === '') ? '—' : '$' + Number(v).toFixed(2);
  const day = (v) => v ? String(v).slice(0, 10) : '';

  function note(msg, kind) {
    const el = $('pricing-note');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'error' ? 'var(--error, #ef4444)' : 'var(--text-secondary)';
  }

  async function token() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) throw new Error('Missing admin session token.');
    return session.access_token;
  }

  async function api(method, body) {
    const t = await token();
    const resp = await fetch('/api/admin-prices', {
      method,
      headers: method === 'GET'
        ? { Authorization: 'Bearer ' + t }
        : { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || !payload.ok) throw new Error(payload.error || 'Request failed.');
    return payload;
  }

  window.pricingLoadData = async function () {
    if (_loaded) { render(); return; }
    const body = $('pricing-body');
    if (body) body.innerHTML = '<p style="color:var(--text-secondary);font-size:.85rem;">Loading…</p>';
    try {
      const data = await api('GET');
      _lists = data.lists || [];
      _prices = data.prices || [];
      _audit = data.audit || [];
      _you = data.you || '';

      /* The catalogue, for the propose form. Read straight from Supabase like
         every other admin page — it is only names and ids. `sku` and `status`
         come along so the picker can be searched by code and can say when you
         are about to price something no customer can see. */
      const { data: prods } = await sb.from('products')
        .select('id,title,sku,status,current_price,color_variants(id,color_name,current_price)')
        .order('title', { ascending: true });
      _products = prods || [];

      _loaded = true;
      render();
    } catch (err) {
      if (body) {
        /* Before 0022 is applied the tables do not exist. Say that plainly
           rather than showing an empty screen that looks like a working one. */
        body.innerHTML = '<div style="padding:1rem;border:1px solid var(--border);border-radius:8px;">'
          + '<strong>Pricing is not set up yet.</strong><br>'
          + '<span style="color:var(--text-secondary);font-size:.85rem;">'
          + escapeHtml(err.message || 'Could not load pricing.')
          + '<br>If this says a table is missing, apply migration 0022 from APIs → Database migrations.'
          + '</span></div>';
      }
    }
  };

  function listName(id) {
    const l = _lists.find((x) => String(x.id) === String(id));
    return l ? (l.name || l.code) : '—';
  }

  function productName(id) {
    const p = _products.find((x) => String(x.id) === String(id));
    return p ? (p.title || id) : String(id || '').slice(0, 8);
  }

  function colourName(productId, variantId) {
    if (!variantId) return 'All colours';
    const p = _products.find((x) => String(x.id) === String(productId));
    const v = p && (p.color_variants || []).find((c) => String(c.id) === String(variantId));
    return v ? (v.color_name || 'Colour') : 'Colour';
  }

  /* Live / scheduled / ended, from the same two dates the resolver reads. This
     is a LABEL, not a second implementation of the rule — nothing here decides
     what anybody is charged. */
  function windowLabel(p) {
    const now = Date.now();
    const from = p.starts_at ? Date.parse(p.starts_at) : null;
    const to = p.ends_at ? Date.parse(p.ends_at) : null;
    if (p.status !== 'approved') return '';
    if (from && now < from) return 'Scheduled — starts ' + day(p.starts_at);
    if (to && now >= to) return 'Ended ' + day(p.ends_at);
    return to ? 'Live until ' + day(p.ends_at) : 'Live';
  }

  function statusChip(p) {
    const map = {
      proposed: ['Awaiting approval', 'rgba(251,191,36,.15)', '#fbbf24'],
      approved: ['Approved', 'rgba(34,197,94,.15)', '#22c55e'],
      rejected: ['Rejected', 'rgba(239,68,68,.15)', '#ef4444'],
      superseded: ['Superseded', 'rgba(148,163,184,.15)', '#94a3b8'],
    };
    const [label, bg, fg] = map[p.status] || [p.status, 'rgba(148,163,184,.15)', '#94a3b8'];
    return `<span style="font-size:.68rem;padding:.15rem .45rem;border-radius:4px;background:${bg};color:${fg};">${escapeHtml(label)}</span>`;
  }

  function render() {
    const body = $('pricing-body');
    if (!body) return;

    const pending = _prices.filter((p) => p.status === 'proposed');
    const live = _prices.filter((p) => p.status === 'approved');

    body.innerHTML = `
      <p id="pricing-note" style="font-size:.82rem;margin:0 0 1rem;"></p>

      ${pending.length ? `
      <div style="border:1px solid rgba(251,191,36,.35);border-radius:8px;padding:1rem;margin-bottom:1.5rem;">
        <div class="zw-eyebrow" style="margin-bottom:.6rem;">Awaiting approval — ${pending.length}</div>
        ${pending.map(pendingRow).join('')}
      </div>` : ''}

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:1.5rem;">
        <div>
          <div class="zw-eyebrow" style="margin-bottom:.6rem;">Propose a price change</div>
          ${proposeForm()}
        </div>
        <div>
          <div class="zw-eyebrow" style="margin-bottom:.6rem;">Price lists</div>
          ${listsTable()}
        </div>
      </div>

      <div class="zw-eyebrow" style="margin:1.75rem 0 .6rem;">Prices</div>
      ${live.length ? pricesTable(live) : empty('No price overrides yet. Products and colourways are priced from the catalogue.')}

      <div class="zw-eyebrow" style="margin:1.75rem 0 .6rem;">Register</div>
      ${_audit.length ? auditTable() : empty('Nothing recorded yet.')}
    `;

    /* The search box is re-rendered as you type, so it has to be re-focused and
       the caret put back — otherwise the first keystroke works and the second
       goes nowhere, which reads as the box being broken. Only the results list
       is redrawn, not the whole panel. */
    const search = $('pricing-search');
    if (search) {
      search.addEventListener('input', (e) => {
        _query = e.target.value;
        const at = e.target.selectionStart;
        render();
        const again = $('pricing-search');
        if (again) { again.focus(); try { again.setSelectionRange(at, at); } catch (_) {} }
      });
    }
  }

  const empty = (msg) => `<p style="color:var(--text-secondary);font-size:.85rem;">${escapeHtml(msg)}</p>`;

  function pendingRow(p) {
    return `
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:.75rem;padding:.6rem 0;border-bottom:1px solid var(--border);">
        <div style="flex:1;min-width:220px;font-size:.85rem;">
          <strong>${escapeHtml(productName(p.product_id))}</strong>
          <span style="color:var(--text-secondary);"> · ${escapeHtml(colourName(p.product_id, p.color_variant_id))}</span><br>
          <span style="color:var(--text-secondary);font-size:.78rem;">
            ${escapeHtml(listName(p.price_list_id))} → ${dollars(p.amount)}
            ${p.starts_at ? ' · from ' + escapeHtml(day(p.starts_at)) : ''}
            ${p.ends_at ? ' · until ' + escapeHtml(day(p.ends_at)) : ''}
          </span>
          ${p.note ? `<br><span style="color:var(--text-secondary);font-size:.78rem;">${escapeHtml(p.note)}</span>` : ''}
        </div>
        <button class="btn btn-secondary btn-sm" onclick="pricingDecide('${escapeAttr(p.id)}','approve',this)">Approve</button>
        <button class="btn btn-danger btn-sm" onclick="pricingDecide('${escapeAttr(p.id)}','reject',this)">Reject</button>
      </div>`;
  }

  /* ── Choosing a product ───────────────────────────────────────────────────
     A <select> of every product is unusable past about twenty of them: you
     cannot type, you cannot search by SKU, and you cannot see what anything
     costs while choosing. This is a search box over title and SKU with the
     current price beside each result, so the thing you are about to change is
     visible before you change it. */
  function picker() {
    if (_pick) {
      const colours = (_pick.color_variants || []).length;
      return `
        <div style="display:flex;align-items:center;gap:.75rem;padding:.7rem .85rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-primary);">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;">${escapeHtml(_pick.title || 'Untitled')}</div>
            <div style="color:var(--text-secondary);font-size:.78rem;">
              ${escapeHtml(_pick.sku || '')}${_pick.sku && colours ? ' · ' : ''}${colours ? colours + ' colourway' + (colours === 1 ? '' : 's') : ''}
              ${statusWarning(_pick)}
            </div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="pricingClearPick()">Change</button>
        </div>`;
    }

    const q = _query.trim().toLowerCase();
    const matches = (q
      ? _products.filter((p) => (String(p.title || '') + ' ' + String(p.sku || '')).toLowerCase().includes(q))
      : _products).slice(0, 8);

    return `
      <input id="pricing-search" class="form-input" type="search" autocomplete="off"
             placeholder="Search by name or SKU…" value="${escapeAttr(_query)}">
      <div style="border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;max-height:260px;overflow-y:auto;">
        ${matches.length ? matches.map((p) => `
          <button type="button" onclick="pricingPick('${escapeAttr(p.id)}')"
                  style="display:flex;width:100%;gap:.75rem;align-items:center;text-align:left;padding:.6rem .85rem;background:none;border:none;border-bottom:1px solid var(--border);color:inherit;cursor:pointer;font:inherit;">
            <span style="flex:1;min-width:0;">
              <span style="display:block;">${escapeHtml(p.title || 'Untitled')}</span>
              <span style="color:var(--text-secondary);font-size:.76rem;">${escapeHtml(p.sku || '—')}${statusWarning(p)}</span>
            </span>
            <span style="font-variant-numeric:tabular-nums;color:var(--text-secondary);">${dollars(p.current_price)}</span>
          </button>`).join('')
        : `<div style="padding:.85rem;color:var(--text-secondary);font-size:.82rem;">
             ${_products.length ? 'Nothing matches “' + escapeHtml(_query) + '”.' : 'No products.'}
           </div>`}
      </div>
      ${!q && _products.length > 8
        ? `<div style="font-size:.75rem;color:var(--text-secondary);margin-top:.35rem;">Showing 8 of ${_products.length}. Type to narrow.</div>`
        : ''}`;
  }

  /* Pricing something nobody can buy is a real mistake and a silent one. */
  function statusWarning(p) {
    const s = String(p.status || '').toLowerCase();
    if (!s || s === 'live') return '';
    return ` <span style="color:#fbbf24;">· ${escapeHtml(p.status)}</span>`;
  }

  /* What a shopper pays for this right now, from /api/prices — the SERVER's
     answer, not a second calculation here. Without it you are typing a new
     price with no idea what the old one is, which is the one thing this whole
     screen exists to change. */
  function currentLine() {
    if (!_pick) return '';
    if (!_live) return '<div style="color:var(--text-secondary);font-size:.8rem;">Checking the current price…</div>';

    const cid = $('pricing-colour') ? $('pricing-colour').value : '';
    const hit = cid ? (_live.colours || []).find((c) => String(c.id) === String(cid)) : _live.base;
    if (!hit) return '';
    const why = { list: 'from a price list', variant: "this colourway's own price", product: "the product's price" }[hit.source] || hit.source;

    const typed = $('pricing-amount') && Number($('pricing-amount').value);
    const after = Number.isFinite(typed) && typed > 0
      ? `<span style="color:var(--text-secondary);"> → </span><strong>$${typed.toFixed(2)}</strong>`
      : '';

    return `
      <div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:.5rem;padding:.6rem .85rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-primary);font-size:.85rem;">
        <span style="color:var(--text-secondary);">Charged today</span>
        <strong style="font-variant-numeric:tabular-nums;">${money(hit.priceCents)}</strong>${after}
        <span style="color:var(--text-secondary);font-size:.78rem;">· ${escapeHtml(why)}</span>
      </div>`;
  }

  function proposeForm() {
    const lists = _lists.filter((l) => l.active !== false)
      .map((l) => `<option value="${escapeAttr(l.id)}">${escapeHtml(l.name || l.code)}</option>`).join('');

    if (!_pick) {
      return `<div style="border:1px solid var(--border);border-radius:8px;padding:1rem;">
        <label class="form-label">Product</label>
        ${picker()}
      </div>`;
    }

    const colours = _pick.color_variants || [];
    return `
      <div style="border:1px solid var(--border);border-radius:8px;padding:1rem;">
        <label class="form-label">Product</label>
        ${picker()}

        <label class="form-label" style="margin-top:.7rem;">Colourway</label>
        <select id="pricing-colour" class="form-input" onchange="pricingRefreshCurrent()">
          <option value="">All colours</option>
          ${colours.map((c) => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.color_name || 'Colour')}${
            c.current_price ? ' — ' + dollars(c.current_price) : ''}</option>`).join('')}
        </select>

        <div id="pricing-current" style="margin-top:.7rem;">${currentLine()}</div>

        <label class="form-label" style="margin-top:.7rem;">Price list</label>
        <select id="pricing-list" class="form-input">${lists}</select>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-top:.6rem;">
          <div><label class="form-label">New price</label>
            <input id="pricing-amount" type="number" step="0.01" min="0.01" class="form-input"
                   oninput="pricingRefreshCurrent()" placeholder="0.00"></div>
          <div><label class="form-label">Compare at <span style="color:var(--text-secondary);font-weight:400;">(optional)</span></label>
            <input id="pricing-compare" type="number" step="0.01" min="0" class="form-input" placeholder="0.00"></div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-top:.6rem;">
          <div><label class="form-label">Starts</label>
            <input id="pricing-starts" type="date" class="form-input"></div>
          <div><label class="form-label">Ends</label>
            <input id="pricing-ends" type="date" class="form-input"></div>
        </div>
        <div style="font-size:.75rem;color:var(--text-secondary);margin-top:.35rem;line-height:1.5;">
          Leave both blank to start now and run until you change it.
        </div>

        <label class="form-label" style="margin-top:.6rem;">Why</label>
        <input id="pricing-note-in" type="text" class="form-input" placeholder="End-of-season markdown">

        <button class="btn btn-primary btn-sm" style="margin-top:.8rem;" onclick="pricingPropose(this)">Propose</button>
        <div style="font-size:.75rem;color:var(--text-secondary);margin-top:.5rem;line-height:1.5;">
          Nothing changes for shoppers until this is approved.
        </div>
      </div>`;
  }

  window.pricingPick = async function (id) {
    _pick = _products.find((p) => String(p.id) === String(id)) || null;
    _live = null;
    render();
    /* Asked WITHOUT an admin token on purpose: this must show the price an
       ordinary shopper is charged, not whatever the signed-in admin qualifies
       for. Same choice the server makes when it records the "from" figure. */
    try {
      const r = await fetch('/api/prices?productId=' + encodeURIComponent(id), { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      _live = j && j.ok ? j : null;
    } catch (_) { _live = null; }
    render();
  };

  window.pricingClearPick = function () { _pick = null; _live = null; _query = ''; render(); };

  /* Redraw only the "charged today → new price" line. A full render would take
     focus out of the box being typed in. */
  window.pricingRefreshCurrent = function () {
    const host = $('pricing-current');
    if (host) host.innerHTML = currentLine();
  };

  function listsTable() {
    if (!_lists.length) return empty('No price lists.');
    return `<div style="overflow-x:auto;"><table class="products-table" style="width:100%;font-size:.82rem;">
      <thead><tr><th>List</th><th>For</th><th>Priority</th><th>State</th></tr></thead>
      <tbody>${_lists.map((l) => `
        <tr>
          <td>${escapeHtml(l.name || l.code)}</td>
          <td style="color:var(--text-secondary);">${escapeHtml(
            [l.customer_group && l.customer_group + 's', l.region, l.channel].filter(Boolean).join(' · ') || 'Everyone')}</td>
          <td>${Number(l.priority) || 0}</td>
          <td>${l.active === false ? '<span style="color:var(--text-secondary);">Off</span>' : 'On'}${
            l.require_second_approver ? ' <span style="color:var(--text-secondary);">· needs 2 approvers</span>' : ''}</td>
        </tr>`).join('')}</tbody></table></div>`;
  }

  function pricesTable(rows) {
    return `<div style="overflow-x:auto;"><table class="products-table" style="width:100%;font-size:.82rem;">
      <thead><tr><th>Product</th><th>Colour</th><th>List</th><th>Price</th><th>When</th><th></th></tr></thead>
      <tbody>${rows.map((p) => `
        <tr>
          <td>${escapeHtml(productName(p.product_id))}</td>
          <td style="color:var(--text-secondary);">${escapeHtml(colourName(p.product_id, p.color_variant_id))}</td>
          <td>${escapeHtml(listName(p.price_list_id))}</td>
          <td style="font-variant-numeric:tabular-nums;">${dollars(p.amount)}</td>
          <td style="color:var(--text-secondary);">${escapeHtml(windowLabel(p))}</td>
          <td>${statusChip(p)}</td>
        </tr>`).join('')}</tbody></table></div>`;
  }

  function auditTable() {
    return `<div style="overflow-x:auto;"><table class="products-table" style="width:100%;font-size:.82rem;">
      <thead><tr><th>When</th><th>Who</th><th>What</th><th>From</th><th>To</th><th></th></tr></thead>
      <tbody>${_audit.map((a) => `
        <tr>
          <td style="white-space:nowrap;color:var(--text-secondary);">${escapeHtml(String(a.at || '').replace('T', ' ').slice(0, 16))}</td>
          <td>${escapeHtml(a.actor_email || '—')}</td>
          <td>${escapeHtml(a.action)} · ${escapeHtml(a.product_title || '')}${
            a.color_name ? ' <span style="color:var(--text-secondary);">' + escapeHtml(a.color_name) + '</span>' : ''}</td>
          <td style="font-variant-numeric:tabular-nums;">${dollars(a.from_amount)}</td>
          <td style="font-variant-numeric:tabular-nums;">${dollars(a.to_amount)}</td>
          <td>${a.self_approved
            ? '<span title="Approved by the person who proposed it" style="font-size:.68rem;padding:.15rem .45rem;border-radius:4px;background:rgba(251,191,36,.15);color:#fbbf24;">self-approved</span>'
            : ''}</td>
        </tr>`).join('')}</tbody></table></div>`;
  }

  window.pricingPropose = async function (btn) {
    const amount = $('pricing-amount') && $('pricing-amount').value;
    if (!amount || Number(amount) <= 0) { note('Enter a price above zero.', 'error'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Proposing…'; }
    try {
      await api('POST', {
        action: 'propose',
        productId: $('pricing-product').value,
        colorVariantId: $('pricing-colour').value || null,
        priceListId: $('pricing-list').value,
        amount: Number(amount),
        compareAt: $('pricing-compare').value || null,
        startsAt: $('pricing-starts').value || null,
        endsAt: $('pricing-ends').value || null,
        note: $('pricing-note-in').value || '',
      });
      _loaded = false;
      await window.pricingLoadData();
      note('Proposed. It changes nothing until it is approved.');
    } catch (err) {
      note(err.message || 'Could not propose that change.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Propose'; }
    }
  };

  window.pricingDecide = async function (priceId, action, btn) {
    if (action === 'approve'
      && !confirm('Approve this price change? It takes effect for shoppers as soon as its start date is reached.')) return;
    if (btn) { btn.disabled = true; btn.textContent = action === 'approve' ? 'Approving…' : 'Rejecting…'; }
    try {
      const res = await api('POST', { action, priceId });
      _loaded = false;
      await window.pricingLoadData();
      note(action === 'approve'
        ? (res.selfApproved
            ? 'Approved. Recorded as self-approved — you proposed it as well.'
            : 'Approved.')
        : 'Rejected.');
    } catch (err) {
      note(err.message || 'Could not update that change.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = action === 'approve' ? 'Approve' : 'Reject'; }
    }
  };
})();
