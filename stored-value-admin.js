(function () {
  /* ── GIFT CARDS AND STORE CREDIT, ON THE COUPONS PAGE ─────────────────────
   *
   * It sits here because a coupon and a gift card are the two things a shop
   * hands out that turn into money off, and somebody looking for one will look
   * where the other is. They are NOT the same underneath — a coupon reduces
   * what an order is worth, a gift card pays part of what it is worth — but
   * that is a distinction for the till, not for the person issuing them.
   *
   * ── WHAT THIS SCREEN DELIBERATELY CANNOT DO ───────────────────────────────
   *
   * It cannot list cards. There is no "all gift cards" table here and there is
   * no endpoint behind one, because a list of live codes is a list of spendable
   * money sitting somewhere more people can read than can issue. Looking one up
   * needs the whole code, the same as the shopper's own lookup at checkout.
   *
   * What it CAN show is the total outstanding, which is the number an owner
   * actually needs — unspent cards are a liability, money taken for goods not
   * yet handed over — and that needs no codes at all.
   *
   * ── AND WHY THE SWITCH IS HERE TOO ────────────────────────────────────────
   *
   * The server refuses to issue while the feature is off, because a card issued
   * into a till that cannot accept it is a promise the shop cannot keep. That
   * refusal is only useful if the person hitting it can see the switch that
   * caused it, so the switch is the first thing on the card.
   */

  const state = { enabled: null, summary: null, lastCode: '', busy: false };

  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(cents) {
    return '$' + (Math.max(0, Number(cents || 0)) / 100).toFixed(2);
  }

  function note(msg, kind) {
    const el = $('svStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'error' ? 'var(--error, #ef4444)' : 'var(--text-secondary)';
  }

  async function token() {
    const { data: { session } } = await window.sb.auth.getSession();
    if (!session?.access_token) throw new Error('Missing admin session token.');
    return session.access_token;
  }

  async function api(body) {
    const t = await token();
    const resp = await fetch('/api/admin-stored-value', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify(body || {}),
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || !payload.ok) throw new Error(payload.error || 'That did not work.');
    return payload;
  }

  /* The switch is read by the server from site_settings.stored_value, and only
     by the server — it never goes near the browser flag system, because a
     shopper's browser deciding whether the till accepts gift cards is a
     shopper's browser deciding whether the till accepts gift cards. */
  async function readEnabled() {
    const { data, error } = await window.sb
      .from('site_settings').select('key,value').eq('key', 'stored_value');
    if (error) throw error;
    const cfg = (data && data[0] && data[0].value) || {};
    return cfg.enabled === true;
  }

  async function writeEnabled(on) {
    const { data } = await window.sb
      .from('site_settings').select('key,value').eq('key', 'stored_value');
    const cfg = (data && data[0] && data[0].value) || {};
    const next = { ...cfg, enabled: !!on, updatedAt: new Date().toISOString() };
    const result = await window.sb
      .from('site_settings').upsert([{ key: 'stored_value', value: next }], { onConflict: 'key' });
    if (result.error) throw new Error(result.error.message || 'Could not save that.');
  }

  function mountStyles() {
    if ($('stored-value-admin-style')) return;
    const style = document.createElement('style');
    style.id = 'stored-value-admin-style';
    style.textContent = `
      .sv-card { background:var(--bg-secondary); border:1px solid var(--border); border-radius:10px; padding:20px; margin-top:18px; }
      .sv-muted { color:var(--text-secondary); font-size:13px; line-height:1.55; }
      .sv-head { display:flex; justify-content:space-between; gap:12px; align-items:center; flex-wrap:wrap; }
      .sv-switch { display:flex; align-items:center; gap:8px; font-size:.8rem; color:var(--text-muted); cursor:pointer; }
      .sv-switch input { width:15px; height:15px; accent-color:var(--accent,#fff); cursor:pointer; }
      .sv-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-top:14px; }
      .sv-field label { display:block; font-size:.68rem; letter-spacing:.08em; text-transform:uppercase; color:var(--text-secondary); margin-bottom:5px; }
      .sv-totals { display:flex; gap:26px; flex-wrap:wrap; margin-top:14px; padding:14px 16px; border:1px solid var(--border); border-radius:8px; }
      .sv-total-value { font-size:1.5rem; font-weight:700; font-variant-numeric:tabular-nums; }
      .sv-total-label { font-size:.66rem; letter-spacing:.12em; text-transform:uppercase; color:var(--text-secondary); margin-top:2px; }
      .sv-issued { margin-top:14px; padding:14px 16px; border:1px dashed var(--border); border-radius:8px; }
      .sv-issued-code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:1.15rem; letter-spacing:.14em; user-select:all; }
      .sv-actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:14px; }
      .sv-off { opacity:.45; pointer-events:none; }
    `;
    document.head.appendChild(style);
  }

  function render() {
    const host = $('storedValueMount');
    if (!host) return;
    const on = state.enabled === true;
    const s = state.summary;

    host.innerHTML = `
      <div class="sv-card">
        <div class="sv-head">
          <div>
            <h3>Gift Cards &amp; Store Credit</h3>
            <div class="sv-muted">One instrument with two names: a gift card is a balance somebody bought, store credit is a balance somebody was given. Both are spent at checkout by typing the code.</div>
          </div>
          <label class="sv-switch">
            <input type="checkbox" id="svEnabled" ${on ? 'checked' : ''}>
            ${on ? 'On — the till accepts them' : 'Off — the till will not accept them'}
          </label>
        </div>

        <div id="svStatus" class="sv-muted" style="margin-top:10px;min-height:16px"></div>

        ${s ? `
        <div class="sv-totals">
          <div>
            <div class="sv-total-value">${money(s.outstandingCents)}</div>
            <div class="sv-total-label">Outstanding — money owed in goods</div>
          </div>
          <div>
            <div class="sv-total-value">${s.giftCards.count}</div>
            <div class="sv-total-label">Gift cards with a balance</div>
          </div>
          <div>
            <div class="sv-total-value">${s.storeCredit.count}</div>
            <div class="sv-total-label">Store credits with a balance</div>
          </div>
        </div>
        ${s.capped ? `<div class="sv-muted" style="margin-top:8px;color:#f0a020">More than ${s.cap} live instruments — this total covers the first ${s.cap}. It is under-reported, not wrong.</div>` : ''}
        ` : ''}

        <div class="${on ? '' : 'sv-off'}" id="svIssueArea">
          <div class="sv-grid">
            <div class="sv-field">
              <label for="svKind">Type</label>
              <select class="form-input" id="svKind">
                <option value="gift_card">Gift card — bought</option>
                <option value="store_credit">Store credit — given</option>
              </select>
            </div>
            <div class="sv-field">
              <label for="svAmount">Amount (USD)</label>
              <input class="form-input" id="svAmount" type="number" min="1" max="5000" step="0.01" placeholder="50.00">
            </div>
            <div class="sv-field">
              <label for="svEmail">Customer email</label>
              <input class="form-input" id="svEmail" type="email" placeholder="jane@example.com">
            </div>
            <div class="sv-field">
              <label for="svExpires">Expires (optional)</label>
              <input class="form-input" id="svExpires" type="date">
            </div>
          </div>
          <div class="sv-grid">
            <div class="sv-field" style="grid-column:1/-1">
              <label for="svReason">Why (kept on the record, not shown to the customer)</label>
              <input class="form-input" id="svReason" type="text" maxlength="300" placeholder="Return #1042 — damaged in transit">
            </div>
          </div>
          <div class="sv-muted" style="margin-top:10px">
            An email that already has an account gets the balance attached to it, so it shows up on their account page. One that does not still issues — the code is how it travels.
          </div>
          <div class="sv-actions">
            <button class="btn btn-primary" id="svIssueBtn">Issue</button>
            <button class="btn btn-secondary" id="svRefreshBtn">Refresh totals</button>
          </div>
        </div>

        ${state.lastCode ? `
        <div class="sv-issued">
          <div class="sv-total-label">Issued — copy this now</div>
          <div class="sv-issued-code" id="svIssuedCode">${esc(state.lastCode)}</div>
          <div class="sv-muted" style="margin-top:6px">Shown once and never again. Nothing in this panel can look it back up, and the audit record deliberately does not carry it. If it is lost before it reaches the customer, void it and issue another.</div>
          <div class="sv-actions">
            <button class="btn btn-secondary btn-sm" id="svCopyBtn">Copy</button>
            <button class="btn btn-secondary btn-sm" id="svDismissBtn">Done</button>
          </div>
        </div>` : ''}

        <div style="margin-top:20px;border-top:1px solid var(--border);padding-top:16px">
          <div class="sv-total-label">Look one up</div>
          <div class="sv-muted" style="margin-top:4px">Needs the whole code. There is no search and no list — that is the point of a bearer instrument.</div>
          <div class="sv-grid">
            <div class="sv-field" style="grid-column:span 2">
              <label for="svLookupCode">Code</label>
              <input class="form-input" id="svLookupCode" type="text" placeholder="ZWG-XXXX-XXXX-XXXX" autocomplete="off">
            </div>
          </div>
          <div class="sv-actions">
            <button class="btn btn-secondary" id="svLookupBtn">Look up</button>
            <button class="btn btn-secondary" id="svVoidBtn">Void it</button>
          </div>
          <div id="svLookupResult" class="sv-muted" style="margin-top:10px;min-height:16px"></div>
        </div>
      </div>
    `;
    bind();
  }

  function bind() {
    $('svEnabled')?.addEventListener('change', async (e) => {
      const on = !!e.target.checked;
      note('Saving…');
      try {
        await writeEnabled(on);
        state.enabled = on;
        note(on
          ? 'On. The gift-card field appears at checkout on the next page load.'
          : 'Off. Existing balances are untouched — the field just stops being offered.');
        render();
      } catch (err) {
        e.target.checked = !on;
        note(err.message || 'Could not save that.', 'error');
      }
    });

    $('svIssueBtn')?.addEventListener('click', async () => {
      if (state.busy) return;
      const amount = Number($('svAmount')?.value || 0);
      if (!(amount > 0)) { note('Enter an amount greater than zero.', 'error'); return; }
      const email = String($('svEmail')?.value || '').trim();
      const kind = $('svKind')?.value || 'gift_card';
      /* Store credit given to nobody in particular is a gift card with a
         confusing name on the accounts. The server does not enforce it — an
         admin may have a reason — but the screen asks. */
      if (kind === 'store_credit' && !email) { note('Store credit needs an email, so it can reach an account.', 'error'); return; }

      state.busy = true;
      note('Issuing…');
      try {
        const out = await api({
          action: 'issue',
          kind,
          amountCents: Math.round(amount * 100),
          ownerEmail: email,
          reason: String($('svReason')?.value || ''),
          expiresAt: $('svExpires')?.value || null,
        });
        state.lastCode = out.code || '';
        note('Issued ' + money(Math.round(amount * 100)) + '.');
        await refreshSummary();
        render();
      } catch (err) {
        note(err.message || 'Could not issue that.', 'error');
      } finally {
        state.busy = false;
      }
    });

    $('svCopyBtn')?.addEventListener('click', async () => {
      const btn = $('svCopyBtn');
      try {
        await navigator.clipboard.writeText(state.lastCode);
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
      } catch (_) {
        btn.textContent = 'Select it above';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
      }
    });

    $('svDismissBtn')?.addEventListener('click', () => { state.lastCode = ''; render(); });

    $('svRefreshBtn')?.addEventListener('click', async () => {
      note('Counting…');
      try { await refreshSummary(); note(''); render(); }
      catch (err) { note(err.message || 'Could not count that.', 'error'); }
    });

    $('svLookupBtn')?.addEventListener('click', async () => {
      const out = $('svLookupResult');
      const code = String($('svLookupCode')?.value || '').trim();
      if (!code) { if (out) out.textContent = 'Enter the code.'; return; }
      if (out) out.textContent = 'Looking…';
      try {
        const r = await api({ action: 'lookup', code });
        const i = r.info || {};
        if (!i.found) { if (out) out.textContent = 'No card with that code.'; return; }
        const bits = [
          (i.kind === 'store_credit' ? 'Store credit' : 'Gift card'),
          money(i.balanceCents) + ' left of ' + money(i.initialCents),
          i.expiresAt ? 'expires ' + new Date(i.expiresAt).toLocaleDateString() : 'no expiry',
        ];
        if (!i.usable) bits.push(i.reason === 'empty' ? 'spent' : i.reason);
        if (i.ownerEmail) bits.push('issued to ' + i.ownerEmail);
        if (out) out.textContent = bits.join(' · ');
      } catch (err) {
        if (out) out.textContent = err.message || 'Could not look that up.';
      }
    });

    $('svVoidBtn')?.addEventListener('click', async () => {
      const out = $('svLookupResult');
      const code = String($('svLookupCode')?.value || '').trim();
      if (!code) { if (out) out.textContent = 'Enter the code.'; return; }
      /* Voiding cancels the remaining balance and cannot be undone — the ledger
         keeps the entry, but the money is gone from the card. Worth a question. */
      if (!window.confirm('Void ' + code + '? The remaining balance is cancelled and this cannot be reversed.')) return;
      if (out) out.textContent = 'Voiding…';
      try {
        const r = await api({ action: 'void', code, reason: String($('svReason')?.value || '') });
        if (out) out.textContent = 'Voided — ' + r.voided + ' cancelled.';
        await refreshSummary();
        render();
      } catch (err) {
        if (out) out.textContent = err.message || 'Could not void that.';
      }
    });
  }

  async function refreshSummary() {
    if (state.enabled !== true) { state.summary = null; return; }
    try {
      const r = await api({ action: 'summary' });
      state.summary = r.summary || null;
    } catch (_) {
      /* A missing migration or an unreadable ledger must not take the switch
         and the issue form down with it — those are what somebody came here to
         use, and one of them is how the ledger gets turned on in the first
         place. */
      state.summary = null;
    }
  }

  /* The Coupons page is built by commerce-admin.js and re-rendered by it on
     every save, so this mounts a container of its own AFTER that one rather
     than inside it. Two modules writing one innerHTML is how a card disappears
     the first time somebody edits a promo. */
  function ensureMount() {
    const page = $('commerce');
    if (!page || $('storedValueMount')) return !!page;
    const mount = document.createElement('div');
    mount.id = 'storedValueMount';
    page.appendChild(mount);
    return true;
  }

  let _loading = false;

  async function load() {
    if (_loading) return;
    if (!window.sb) return;
    if (!ensureMount()) return;
    _loading = true;
    try { await loadInner(); } finally { _loading = false; }
  }

  async function loadInner() {
    mountStyles();
    try {
      state.enabled = await readEnabled();
    } catch (_) {
      state.enabled = false;
    }
    await refreshSummary();
    render();
  }

  /* ── TWO WAYS IN, BECAUSE ONE OF THEM DEPENDS ON SCRIPT ORDER ────────────
     commerce-admin.js also wraps navigateTo, and its wrapper does NOT call
     through for `commerce` — it handles that page and returns. So if this
     module's wrapper were the inner one, it would never run for the only page
     it cares about, and the card would silently not exist.
     Today the ordering works out (that listener registers first, this one
     defers past it), but "works out" is a property of a script tag somebody can
     move. The delegated click below does not care who wrapped whom: the nav
     link calls navigateTo from an inline onclick, and the click still bubbles
     to the document either way. */
  function installNavigationHook() {
    const original = window.navigateTo;
    if (typeof original === 'function' && !original.__storedValueWrapped) {
      const wrapped = function (page) {
        const out = original.apply(this, arguments);
        if (page === 'commerce') setTimeout(load, 0);
        return out;
      };
      wrapped.__storedValueWrapped = true;
      window.navigateTo = wrapped;
    }
    if (!document.__storedValueNavBound) {
      document.addEventListener('click', (e) => {
        const link = e.target && e.target.closest && e.target.closest('[data-page="commerce"]');
        if (link) setTimeout(load, 0);
      });
      document.__storedValueNavBound = true;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(installNavigationHook, 0);
  });
})();
