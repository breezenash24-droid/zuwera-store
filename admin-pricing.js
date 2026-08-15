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
  let _live = null;     // the quote for _pick — what a shopper is charged TODAY
  let _query = '';      // product search text
  /* productId -> the same quote, for every product in the list. The figure
     beside each row used to be products.current_price, which is the CATALOGUE
     price — so a product moved to $32 by a price list went on reading $40 in the
     one place a merchant looks to check what things cost. Resolved by the server
     in one request rather than worked out here, because a second implementation
     of the pricing rules in the panel is the exact fault this system removes. */
  let _charged = {};

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

  async function api(method, body, query) {
    const t = await token();
    const resp = await fetch('/api/admin-prices' + (query || ''), {
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
      /* Re-point at the row in the NEW list. Proposing or ending reloads
         everything, and without this _pick went on referring to an object from
         the previous fetch — so the form kept showing the colourways and status
         it had before the change it just made. */
      if (_pick) _pick = _products.find((p) => String(p.id) === String(_pick.id)) || _pick;

      _loaded = true;
      render();
      /* After the first paint, not before it. The list is useful the moment it
         is on screen; the charged figures sharpen it a moment later, and making
         the whole page wait on them would trade a correct number for a slower
         one. Failures are silent by design — the row falls back to the catalogue
         price, which is what it showed before. */
      loadCharged();
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

  /* One request for the whole list. Chunked because the ids go in a URL and a
     catalogue of any size would eventually exceed what a URL may hold — a limit
     that arrives silently, as a request that stops working at some product
     count nobody chose. */
  async function loadCharged() {
    const ids = _products.map((p) => String(p.id)).filter(Boolean);
    if (!ids.length) return;
    for (let i = 0; i < ids.length; i += 60) {
      const chunk = ids.slice(i, i + 60);
      try {
        const data = await api('GET', null, '?quote=' + encodeURIComponent(chunk.join(',')));
        (data.products || []).forEach((p) => { _charged[String(p.productId)] = p; });
      } catch (_) { /* the catalogue price stands */ }
    }
    if (_loaded) render();
  }

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
      <div id="pricing-pending" style="border:1px solid rgba(251,191,36,.35);border-radius:8px;padding:1rem;margin-bottom:1.5rem;">
        <div class="zw-eyebrow" style="margin-bottom:.6rem;">Awaiting approval — ${pending.length}</div>
        <div style="font-size:.8rem;color:var(--text-secondary);margin-bottom:.75rem;line-height:1.6;">
          These change nothing for shoppers until approved. Approving your own proposal is allowed and is recorded as self-approved.
        </div>
        ${pending.map(pendingRow).join('')}
      </div>` : ''}

      <!-- Two panes: the catalogue stays on the left while you work on the
           right, so moving between products does not mean re-finding the list
           each time. Collapses to one column under 900px. -->
      <div class="zw-price-panes">
        <div>
          <div class="zw-eyebrow" style="margin-bottom:.6rem;">Products</div>
          ${picker()}
        </div>
        <div>
          <div class="zw-eyebrow" style="margin-bottom:.6rem;">
            ${_pick ? escapeHtml(_pick.title || 'Untitled') : 'Propose a price change'}
          </div>
          ${proposeForm()}
        </div>
      </div>

      <div class="zw-eyebrow" style="margin:1.75rem 0 .6rem;">Price lists</div>
      ${listsTable()}

      <div class="zw-eyebrow" style="margin:1.75rem 0 .6rem;">Prices</div>
      ${live.length ? pricesTable(live) : empty('No price overrides yet. Products and colourways are priced from the catalogue.')}

      <div class="zw-eyebrow" style="margin:1.75rem 0 .6rem;">Register</div>
      ${_audit.length ? auditTable() : empty('Nothing recorded yet.')}
    `;

    /* The search box is re-rendered as you type, so it has to be re-focused and
       the caret put back — otherwise the first keystroke works and the second
       goes nowhere, which reads as the box being broken. Only the results list
       is redrawn, not the whole panel. */
    /* The member caveat starts hidden in the markup, so its visibility has to
       be settled once after every render — not only when a field is touched. */
    if (_pick) window.pricingRefreshCurrent();

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
  /* The catalogue pane. Stays on screen while the right-hand form is used, so
     the selected row is highlighted rather than the list being replaced — the
     whole point of two panes is comparing and moving between products without
     losing your place. */
  function picker() {
    const q = _query.trim().toLowerCase();
    const matches = q
      ? _products.filter((p) => (String(p.title || '') + ' ' + String(p.sku || '')).toLowerCase().includes(q))
      : _products;

    return `
      <input id="pricing-search" class="form-input" type="search" autocomplete="off"
             placeholder="Search by name or SKU…" value="${escapeAttr(_query)}"
             style="border-radius:8px 8px 0 0;">
      <div style="border:1px solid var(--border);border-top:none;border-radius:0 0 8px 8px;max-height:520px;overflow-y:auto;">
        ${matches.length ? matches.map((p) => {
          const on = _pick && String(_pick.id) === String(p.id);
          const colours = (p.color_variants || []).length;
          return `
          <button type="button" onclick="pricingPick('${escapeAttr(p.id)}')" aria-current="${on ? 'true' : 'false'}"
                  style="display:flex;width:100%;gap:.75rem;align-items:center;text-align:left;padding:.6rem .85rem;
                         background:${on ? 'var(--bg-primary)' : 'none'};border:none;
                         border-left:3px solid ${on ? 'var(--accent)' : 'transparent'};
                         border-bottom:1px solid var(--border);color:inherit;cursor:pointer;font:inherit;">
            <span style="flex:1;min-width:0;">
              <span style="display:block;${on ? 'font-weight:600;' : ''}">${escapeHtml(p.title || 'Untitled')}</span>
              <span style="color:var(--text-secondary);font-size:.76rem;">
                ${escapeHtml(p.sku || '—')}${colours ? ' · ' + colours + ' colour' + (colours === 1 ? '' : 's') : ''}${statusWarning(p)}
              </span>
            </span>
            ${chargedCell(p)}
          </button>`;
        }).join('')
        : `<div style="padding:.85rem;color:var(--text-secondary);font-size:.82rem;">
             ${_products.length ? 'Nothing matches “' + escapeHtml(_query) + '”.' : 'No products.'}
           </div>`}
      </div>
      <div style="font-size:.75rem;color:var(--text-secondary);margin-top:.35rem;">
        ${matches.length} of ${_products.length} product${_products.length === 1 ? '' : 's'}
      </div>`;
  }

  /* WHAT THIS PRODUCT COSTS TODAY, in the list.
     Every colourway is asked, not just the product, because a colour can carry
     its own price and its own price-list row — so one figure is only honest when
     they all agree. When they do not, the lowest is shown as "from", which is
     what the storefront says too.

     Falls back to the catalogue price while the quotes are in flight, and stays
     there if they never arrive: the old number, which is at worst the number
     this screen showed yesterday. */
  function chargedCell(p) {
    const q = _charged[String(p.id)];
    const wrap = (main, sub) => `
      <span style="text-align:right;white-space:nowrap;">
        <span style="display:block;font-variant-numeric:tabular-nums;">${main}</span>
        ${sub ? `<span style="display:block;font-size:.7rem;color:var(--text-secondary);">${sub}</span>` : ''}
      </span>`;

    if (!q || !q.base) {
      return wrap(`<span style="color:var(--text-secondary);">${dollars(p.current_price)}</span>`, '');
    }

    const cents = [q.base.priceCents].concat((q.colours || []).map((c) => c.priceCents))
      .filter((n) => Number(n) > 0);
    if (!cents.length) return wrap(`<span style="color:var(--text-secondary);">${dollars(p.current_price)}</span>`, '');

    const low = Math.min.apply(null, cents);
    const varies = Math.max.apply(null, cents) !== low;
    const main = (varies ? '<span style="color:var(--text-secondary);font-size:.72rem;">from </span>' : '') + money(low);

    /* The catalogue price is only worth showing when something has moved away
       from it — that is the whole signal. Shown struck rather than labelled,
       because it is the figure this row used to display. */
    const cat = Math.round((Number(p.current_price) || 0) * 100);
    const moved = cat > 0 && !varies && cat !== low;
    const anyMember = (q.base.memberDiffers || (q.colours || []).some((c) => c.memberDiffers));

    const sub = [
      moved ? `<s>${money(cat)}</s>` : '',
      anyMember ? 'member price set' : '',
    ].filter(Boolean).join(' · ');

    return wrap(main, sub);
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
    /* 'price_list' is what the resolver calls it and what this line printed
       until now — a column name in front of a merchant, mid-sentence. */
    const why = {
      price_list: 'from a price list', list: 'from a price list',
      variant: "this colourway's own price", product: "the product's price",
    }[hit.source] || hit.source;

    const num = (id) => { const el = $(id); const n = el ? Number(el.value) : NaN; return Number.isFinite(n) && n > 0 ? n : null; };
    const typed = num('pricing-amount');
    const typedMember = num('pricing-member');
    const after = typed
      ? `<span style="color:var(--text-secondary);"> → </span><strong>$${typed.toFixed(2)}</strong>`
      : '';
    /* Members are a separate line rather than folded into the arrow above: two
       audiences, two before-and-afters, and conflating them is what made the
       missing member field easy to miss in the first place.

       SHOWN ONLY WHEN THERE IS ONE. `memberDiffers` is the server saying a
       member genuinely pays less today. Printing "Members pay $50" beside
       "Charged today $50" would describe a discount that does not exist, and a
       screen that mentions a tier nobody is on invites somebody to go looking
       for it. A member figure being typed counts too — that is a member price
       about to exist. */
    const hasMemberToday = !!hit.memberDiffers;
    const memberLine = (hasMemberToday || typedMember)
      ? `<div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:.5rem;margin-top:.35rem;color:var(--text-secondary);font-size:.8rem;">
           <span>Members pay</span>
           <strong style="font-variant-numeric:tabular-nums;color:var(--text-primary);">${
             hasMemberToday ? money(hit.memberPriceCents) : '—'}</strong>
           ${typedMember ? `<span>→</span><strong style="color:var(--text-primary);">$${typedMember.toFixed(2)}</strong>` : ''}
         </div>`
      : '';

    /* ── Ending the row that is in effect ───────────────────────────────────
       The only verb this screen had was "propose", so changing a price meant
       adding a second row beside the live one and hoping the resolver preferred
       it. It often did not: two rows with no dates are both live forever, and
       which one wins is not something you can see from here. That is how $30
       went on being charged for a product somebody had already moved to $32.

       Offered only when a price LIST is what is in effect. A catalogue price is
       not a row and has nothing to end — it is changed on the product. */
    const endable = hit.priceId && (hit.source === 'price_list' || hit.source === 'list');
    const endRow = endable
      ? `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:.6rem;margin-top:.55rem;padding-top:.55rem;border-top:1px solid var(--border);">
           <span style="color:var(--text-secondary);font-size:.78rem;">
             Set by ${escapeHtml(listNameByCode(hit.priceListCode) || 'a price list')}.
           </span>
           <button class="btn btn-secondary btn-sm" style="padding:.2rem .55rem;font-size:.72rem;"
                   onclick="pricingEnd('${escapeAttr(hit.priceId)}',this)">End this price</button>
         </div>`
      : '';

    return `
      <div style="padding:.6rem .85rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-primary);font-size:.85rem;">
        <div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:.5rem;">
          <span style="color:var(--text-secondary);">Charged today</span>
          <strong style="font-variant-numeric:tabular-nums;">${money(hit.priceCents)}</strong>${after}
          <span style="color:var(--text-secondary);font-size:.78rem;">· ${escapeHtml(why)}</span>
        </div>
        ${memberLine}
        ${endRow}
      </div>`;
  }

  function listNameByCode(code) {
    if (!code) return '';
    const l = _lists.find((x) => String(x.code) === String(code));
    return l ? (l.name || l.code) : String(code);
  }

  function proposeForm() {
    const lists = _lists.filter((l) => l.active !== false)
      .map((l) => `<option value="${escapeAttr(l.id)}">${escapeHtml(l.name || l.code)}</option>`).join('');

    if (!_pick) {
      return `<div style="border:1px solid var(--border);border-radius:8px;padding:1.25rem;color:var(--text-secondary);font-size:.85rem;line-height:1.7;">
        Choose a product on the left.<br>
        Its current price, colourways and everything you can set will appear here.
      </div>`;
    }

    const colours = _pick.color_variants || [];
    return `
      <div style="border:1px solid var(--border);border-radius:8px;padding:1rem;">
        <div style="color:var(--text-secondary);font-size:.78rem;margin-bottom:.7rem;">
          ${escapeHtml(_pick.sku || '')}${_pick.sku && colours.length ? ' · ' : ''}${
            colours.length ? colours.length + ' colourway' + (colours.length === 1 ? '' : 's') : ''}${statusWarning(_pick)}
        </div>

        <label class="form-label">Colourway</label>
        <select id="pricing-colour" class="form-input" onchange="pricingRefreshCurrent()">
          <option value="">All colours</option>
          ${colours.map((c) => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.color_name || 'Colour')}${
            c.current_price ? ' — ' + dollars(c.current_price) : ''}</option>`).join('')}
        </select>

        <div id="pricing-current" style="margin-top:.7rem;">${currentLine()}</div>

        <label class="form-label" style="margin-top:.7rem;">Price list</label>
        <select id="pricing-list" class="form-input">${lists}</select>

        <!-- All three figures the product form has. Member price was missing,
             so this screen could express two of the three — and the missing one
             is the one nearly every product here uses. -->
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.6rem;margin-top:.6rem;">
          <div><label class="form-label">New price</label>
            <input id="pricing-amount" type="number" step="0.01" min="0.01" class="form-input"
                   oninput="pricingRefreshCurrent()" placeholder="0.00"></div>
          <div><label class="form-label">Member <span style="color:var(--text-secondary);font-weight:400;">(opt)</span></label>
            <input id="pricing-member" type="number" step="0.01" min="0" class="form-input"
                   oninput="pricingRefreshCurrent()" placeholder="0.00"></div>
          <div><label class="form-label">Compare at <span style="color:var(--text-secondary);font-weight:400;">(opt)</span></label>
            <input id="pricing-compare" type="number" step="0.01" min="0" class="form-input" placeholder="0.00"></div>
        </div>
        <!-- The caveat only appears once there is a member price to caveat.
             A store with no member tier should never be told how the member
             tier resolves. -->
        <div id="pricing-member-note" style="font-size:.75rem;color:var(--text-secondary);margin-top:.35rem;line-height:1.5;display:none;">
          Members pay this only while this row is the one in effect. It never competes with the Members price list.
        </div>
        <!-- Said where the figure is TYPED, not after it is saved. A field that
             accepts a number and quietly does nothing with it is how somebody
             spends an afternoon wondering why a discount never appeared. -->
        ${_live && _live.memberPricing === false ? `
        <div style="font-size:.75rem;color:#fbbf24;margin-top:.35rem;line-height:1.5;">
          Member pricing is switched off for this store, so a member price here will be saved but not charged.
          Turn it on under Marketing → Loyalty.
        </div>` : ''}

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
    /* The list already has this product's quote, so show it at once instead of
       "Checking the current price…" on every click. Refreshed underneath
       regardless: the list's copy was fetched when the page loaded, and someone
       else may have changed a price since. */
    _live = _charged[String(id)] || null;
    render();
    /* Admin-gated ?quote rather than the public /api/prices, because this panel
       needs the price as a GUEST and as a member at the same time. /api/prices
       answers as whoever is asking — sending the admin token to it would price
       the whole response as a member, which is the wrong number for the main
       line. */
    try {
      const fresh = await api('GET', null, '?quote=' + encodeURIComponent(id));
      _live = fresh;
      _charged[String(id)] = { productId: id, base: fresh.base, colours: fresh.colours };
    } catch (_) { /* the list's copy stands */ }
    render();
  };

  window.pricingClearPick = function () { _pick = null; _live = null; _query = ''; render(); };

  /* Redraw only the "charged today → new price" line. A full render would take
     focus out of the box being typed in. */
  window.pricingRefreshCurrent = function () {
    const host = $('pricing-current');
    if (host) host.innerHTML = currentLine();

    /* The member caveat follows the member field, not the page load. */
    const noteEl = $('pricing-member-note');
    if (noteEl) {
      const el = $('pricing-member');
      const typed = el && Number(el.value) > 0;
      const cid = $('pricing-colour') ? $('pricing-colour').value : '';
      const hit = _live && (cid ? (_live.colours || []).find((c) => String(c.id) === String(cid)) : _live.base);
      noteEl.style.display = (typed || (hit && hit.memberDiffers)) ? '' : 'none';
    }
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
    /* The product comes from _pick, not from a form field. It used to read
       $('pricing-product').value, and when the <select> was replaced by the
       search picker that element stopped existing — so every Propose threw
       "Cannot read properties of null (reading 'value')" before it sent
       anything. Read through a helper so a missing field is a clear message
       rather than a crash. */
    const val = (id) => { const el = $(id); return el ? String(el.value || '').trim() : ''; };

    if (!_pick) { note('Choose a product first.', 'error'); return; }
    const amount = val('pricing-amount');
    if (!amount || Number(amount) <= 0) { note('Enter a price above zero.', 'error'); return; }

    const memberPrice = val('pricing-member');
    if (memberPrice && Number(memberPrice) >= Number(amount)) {
      /* Refused here as well as ignored by the resolver: a member price at or
         above the regular one is a transposed pair of numbers, and silently
         dropping it would leave somebody believing members have a discount. */
      note('The member price must be below the new price.', 'error');
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Proposing…'; }
    try {
      await api('POST', {
        action: 'propose',
        productId: _pick.id,
        colorVariantId: val('pricing-colour') || null,
        priceListId: val('pricing-list'),
        amount: Number(amount),
        memberPrice: memberPrice ? Number(memberPrice) : null,
        compareAt: val('pricing-compare') || null,
        startsAt: val('pricing-starts') || null,
        endsAt: val('pricing-ends') || null,
        note: val('pricing-note-in'),
      });
      _loaded = false;
      await window.pricingLoadData();
      note('Proposed. It changes nothing until it is approved.');

      /* Take them to it. The pending block renders at the TOP of the page and
         the form is near the bottom, so proposing from the form left the one
         thing that needs acting on off-screen — which reads as nothing having
         happened. */
      const pendingEl = $('pricing-pending');
      if (pendingEl && pendingEl.scrollIntoView) {
        pendingEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } catch (err) {
      note(err.message || 'Could not propose that change.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Propose'; }
    }
  };

  /* Stop the price that is in effect. The row is kept and given an end date
     rather than deleted — it charged real customers real money, and the register
     is the thing somebody reads a year later. */
  window.pricingEnd = async function (priceId, btn) {
    if (!window.confirm('End this price now?\n\nIt stops applying immediately and the price falls back to whatever is next in effect — usually the catalogue price. The change stays in the register.')) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Ending…'; }
    try {
      const res = await api('POST', { action: 'end', priceId });
      _loaded = false;
      await window.pricingLoadData();
      /* The figure it fell BACK to, from the server's own resolution — the one
         question anybody has after ending a price. */
      note('Ended. Now charging ' + money(res.revertsToCents) + '.');
    } catch (err) {
      note(err.message || 'Could not end that price.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'End this price'; }
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
