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

  const state = { enabled: null, summary: null, lastCode: '', busy: false, policy: null };

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

  /* ── STORE POLICY, ON commerce_config RATHER THAN stored_value ────────────
     Two rows, two different questions. `stored_value.enabled` is whether the
     TILL accepts a card — server-only, never near a browser flag. These are
     what the STOREFRONT offers, and they live with the rest of the customer
     experience settings the storefront already reads on /api/stock, so the
     policy and the price it governs arrive on one response.

     Read-modify-write, narrow: it touches three keys and carries everything
     else in the blob through untouched. */
  async function readPolicy() {
    const { data } = await window.sb
      .from('site_settings').select('key,value').eq('key', 'commerce_config');
    const cfg = (data && data[0] && data[0].value) || {};
    const g = (cfg && typeof cfg.giftCards === 'object' && cfg.giftCards) || {};
    return {
      customAmounts: g.customAmounts === true,
      promptBalanceAtCheckout: g.promptBalanceAtCheckout === true,
      minCents: Math.round(Number(g.minCents)) || 1000,
      maxCents: Math.round(Number(g.maxCents)) || 50000,
    };
  }

  async function writePolicy(next) {
    const { data } = await window.sb
      .from('site_settings').select('key,value').eq('key', 'commerce_config');
    const cfg = (data && data[0] && data[0].value) || {};
    cfg.giftCards = { ...(cfg.giftCards || {}), ...next };
    const result = await window.sb
      .from('site_settings').upsert([{ key: 'commerce_config', value: cfg }], { onConflict: 'key' });
    if (result.error) throw new Error(result.error.message || 'Could not save that.');
  }

  function mountStyles() {
    if ($('stored-value-admin-style')) return;
    const style = document.createElement('style');
    style.id = 'stored-value-admin-style';
    style.textContent = `
      .sv-card { background:var(--bg-secondary); border:1px solid var(--border); border-radius:10px; padding:20px; margin-top:18px; }
      .sv-ledger-table { width:100%; border-collapse:collapse; font-size:.85rem; }
      .sv-ledger-table th { text-align:left; font-weight:600; font-size:.7rem; letter-spacing:.08em; text-transform:uppercase; color:var(--text-secondary); padding:6px 10px; border-bottom:1px solid var(--border); }
      .sv-ledger-table td { padding:9px 10px; border-bottom:1px solid var(--border); vertical-align:top; }
      .sv-ledger-table code { font-size:.85rem; letter-spacing:.08em; }
      /* Figures line up so a column of money reads as a column of money. */
      .sv-ledger-table td[style*="right"] { font-variant-numeric:tabular-nums; }
      .sv-ledger-sub { margin:4px 0 8px; background:var(--bg-primary); }
      .sv-ledger-sub th, .sv-ledger-sub td { padding:6px 10px; }
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

        <!-- ── Store policy ─────────────────────────────────────────────────
             Three switches that change what shoppers are offered, all stored on
             commerce_config.giftCards. Separate from the master switch above:
             that one decides whether the till accepts a card at all, these
             decide what the storefront proposes. -->
        <div class="sv-grid" style="margin-top:18px">
          <div class="sv-field" style="grid-column:1/-1">
            <label style="display:flex;align-items:flex-start;gap:.5rem;cursor:pointer;font-weight:400">
              <input type="checkbox" id="svCustomAmounts" ${state.policy && state.policy.customAmounts ? 'checked' : ''} style="margin-top:.2rem">
              <span><strong>Let buyers choose their own amount.</strong>
                <span class="sv-muted">Adds a “Choose your own amount” button on every gift card page. The listed price stays the default, so a shopper who ignores it still gets a card. The amount they pick becomes both what they pay and what the card is worth — the server computes them from one number, so the two can never disagree.</span>
              </span>
            </label>
          </div>
        </div>
        <div class="sv-grid" id="svAmountBounds" style="${state.policy && state.policy.customAmounts ? '' : 'display:none'}">
          <div class="sv-field">
            <label for="svMinAmount">Smallest amount</label>
            <input class="form-input" id="svMinAmount" type="number" min="1" step="1"
                   value="${((state.policy && state.policy.minCents) || 1000) / 100}">
          </div>
          <div class="sv-field">
            <label for="svMaxAmount">Largest amount</label>
            <input class="form-input" id="svMaxAmount" type="number" min="1" step="1"
                   value="${((state.policy && state.policy.maxCents) || 50000) / 100}">
          </div>
          <div class="sv-field" style="grid-column:1/-1">
            <div class="sv-muted">An unbounded amount is one typo away from a $50,000 card, and gift cards are the ideal thing to buy with a stolen card because they turn into money immediately. Keep the ceiling near the largest order you would expect.</div>
          </div>
        </div>

        <!-- Asked for directly: the prompt is useful and not everybody wants it. -->
        <div class="sv-grid">
          <div class="sv-field" style="grid-column:1/-1">
            <label style="display:flex;align-items:flex-start;gap:.5rem;cursor:pointer;font-weight:400">
              <input type="checkbox" id="svPromptBalance" ${state.policy && state.policy.promptBalanceAtCheckout ? 'checked' : ''} style="margin-top:.2rem">
              <span><strong>Remind signed-in customers of their balance at checkout.</strong>
                <span class="sv-muted">A one-tap prompt when somebody with a card reaches the payment step, so they do not have to go and find the code. No password: they are already signed in, and asking again protects nothing.</span>
              </span>
            </label>
          </div>
        </div>
        <div class="sv-actions" style="margin-top:4px">
          <button class="btn btn-secondary" id="svPolicySave">Save these settings</button>
          <span id="svPolicyMsg" class="sv-muted"></span>
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
              <label for="svReason">Why — kept on the record, <strong>never shown to the customer</strong></label>
              <input class="form-input" id="svReason" type="text" maxlength="300" placeholder="Return #1042 — damaged in transit">
            </div>
          </div>
          <!-- Two fields, two audiences, and they are next to each other on
               purpose so the difference is impossible to miss. "Return #1042 —
               damaged in transit" is the right thing to write on the record and
               the wrong thing to send to the person it happened to. -->
          <div class="sv-grid">
            <div class="sv-field" style="grid-column:1/-1">
              <label for="svMessage">Message — <strong>this is what they read</strong></label>
              <textarea class="form-input" id="svMessage" rows="3" maxlength="600"
                        placeholder="Sorry about the jacket — here's something towards your next one."></textarea>
              <div class="sv-muted" style="margin-top:.35rem">
                Optional. Appears above the code in the email, in your store's own branding. Line breaks are kept.
              </div>
            </div>
          </div>
          <div class="sv-grid">
            <div class="sv-field" style="grid-column:1/-1">
              <label style="display:flex;align-items:flex-start;gap:.5rem;cursor:pointer;font-weight:400">
                <input type="checkbox" id="svSendEmail" checked style="margin-top:.2rem">
                <span>Email the card to them.
                  <span class="sv-muted">Off means the code is yours to pass on — it is still shown once below, and nothing can look it back up afterwards.</span>
                </span>
              </label>
            </div>
          </div>
          <!-- The same code refunds ask for, and for the same reason: issuing a
               gift card creates money out of nothing, and being signed in as an
               admin should not be enough to do that. It is a Cloudflare
               environment variable, so it is not in the database and there is no
               reset button here — which is the entire point of it. -->
          <div class="sv-grid">
            <div class="sv-field" style="grid-column:1/-1">
              <label for="svAuthKey">Authorization code</label>
              <input class="form-input" id="svAuthKey" type="password" autocomplete="off" placeholder="REFUND_SECRET">
              <div class="sv-muted" style="margin-top:.35rem">Five wrong tries locks issuing for an hour. Looking a card up and voiding one do not need it — cancelling a code somebody should not have must never be the slow path.</div>
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
          <div class="sv-muted" style="margin-top:4px">Needs the whole code. There is no search <em>by</em> code — that is the point of a bearer instrument, and a box that answered “does this prefix exist” would be an oracle for guessing one. The ledger below lists what has been issued, with the codes masked.</div>
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

        <!-- ── THE LEDGER ─────────────────────────────────────────────────────
             Migration 0030 is called "stored value is one ledger" and it always
             was one: every issue, hold, capture, release, refund and void has
             been writing a signed row since the day it shipped, and a balance
             is the sum of those rows. That is why this screen and the till can
             never disagree about what a card is worth — they are not comparing
             two totals, they are reading the same one.

             What never existed was any way to LOOK at it. The panel could check
             a code, show a total, issue and void, and could not answer "which
             cards are out", "what happened to this one", or "where did that $50
             go". A ledger nobody can read is a table.

             Codes are MASKED here, deliberately. This is a screen that may be
             open on a shared display, and a full code is spendable money. The
             lookup above still returns one, because that is somebody typing a
             code they are already holding. -->
        <div style="margin-top:20px;border-top:1px solid var(--border);padding-top:16px">
          <div class="sv-head" style="align-items:center">
            <div>
              <div class="sv-total-label">Ledger</div>
              <div class="sv-muted" style="margin-top:4px">Every card issued, newest first. Open one to see what has happened to it — the entries are what the balance is made of.</div>
            </div>
            <div class="sv-actions" style="margin:0">
              <select class="form-select" id="svLedgerStatus" style="max-width:150px">
                <option value="active">Active</option>
                <option value="void">Voided</option>
                <option value="all">All</option>
              </select>
              <button class="btn btn-secondary btn-sm" id="svLedgerBtn">Load</button>
            </div>
          </div>
          <div id="svLedger" style="margin-top:12px"></div>
        </div>
      </div>
    `;
    bind();
  }

  function bind() {
    /* Bounds appear with the switch that needs them. A min and a max sitting
       under an unticked box are two questions about something not happening. */
    $('svCustomAmounts')?.addEventListener('change', (e) => {
      const box = $('svAmountBounds');
      if (box) box.style.display = e.target.checked ? '' : 'none';
    });

    $('svPolicySave')?.addEventListener('click', async () => {
      const btn = $('svPolicySave');
      const msg = $('svPolicyMsg');
      const minD = parseFloat($('svMinAmount')?.value);
      const maxD = parseFloat($('svMaxAmount')?.value);
      const next = {
        customAmounts: !!$('svCustomAmounts')?.checked,
        promptBalanceAtCheckout: !!$('svPromptBalance')?.checked,
      };
      if (next.customAmounts) {
        if (!(minD > 0) || !(maxD > 0)) {
          if (msg) { msg.textContent = 'Give both amounts a value above zero.'; msg.style.color = 'var(--error,#ef4444)'; }
          return;
        }
        next.minCents = Math.round(minD * 100);
        next.maxCents = Math.round(maxD * 100);
      }
      if (btn) btn.disabled = true;
      if (msg) { msg.style.color = 'var(--text-secondary)'; msg.textContent = 'Saving…'; }
      try {
        await writePolicy(next);
        state.policy = await readPolicy();
        if (msg) msg.textContent = 'Saved.';
      } catch (err) {
        if (msg) { msg.textContent = err.message || 'Could not save that.'; msg.style.color = 'var(--error,#ef4444)'; }
      } finally {
        if (btn) btn.disabled = false;
      }
    });

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
      if (!String($('svAuthKey')?.value || '').trim()) { note('The authorization code is required to issue.', 'error'); return; }
      const kind = $('svKind')?.value || 'gift_card';
      /* Store credit given to nobody in particular is a gift card with a
         confusing name on the accounts. The server does not enforce it — an
         admin may have a reason — but the screen asks. */
      if (kind === 'store_credit' && !email) { note('Store credit needs an email, so it can reach an account.', 'error'); return; }

      /* Asked before the money is made, not after. Ticking "email it to them"
         with no address is a plan that fails silently at the last step, by
         which point the card exists and the only copy of the code is on this
         screen. */
      const sendEmail = !!$('svSendEmail')?.checked;
      if (sendEmail && !email) { note('Add an email address, or untick “Email the card to them”.', 'error'); return; }

      state.busy = true;
      note('Issuing…');
      try {
        const out = await api({
          action: 'issue',
          kind,
          amountCents: Math.round(amount * 100),
          ownerEmail: email,
          reason: String($('svReason')?.value || ''),
          message: String($('svMessage')?.value || ''),
          sendEmail,
          expiresAt: $('svExpires')?.value || null,
          authKey: $('svAuthKey')?.value || '',
        });
        /* Cleared on success so it is not sitting in the DOM for the next
           person at this screen. */
        if ($('svAuthKey')) $('svAuthKey').value = '';
        if ($('svMessage')) $('svMessage').value = '';
        state.lastCode = out.code || '';
        /* Say what happened to the email, both ways. "Issued $50" while the
           delivery quietly failed is how a customer ends up waiting for
           something that was never sent — and the code is still on screen, so
           an admin told the truth can act on it now rather than tomorrow. */
        note('Issued ' + money(Math.round(amount * 100)) + '.'
          + (out.emailed ? ' Emailed to ' + out.emailTo + '.'
             : sendEmail ? ' NOT emailed (' + (out.emailError || 'unknown reason') + ') — send them the code below yourself.'
             : ' Not emailed — the code below is yours to pass on.'),
          out.emailed || !sendEmail ? '' : 'error');
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
    $('svLedgerBtn')?.addEventListener('click', loadLedger);
    /* Changing the filter loads it: a dropdown that changes nothing until a
       second button is pressed is a dropdown that looks broken. */
    $('svLedgerStatus')?.addEventListener('change', loadLedger);

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

  const KIND_WORDS = {
    issue: 'Issued', hold: 'Held at checkout', capture: 'Spent',
    release: 'Hold released', refund: 'Refunded onto the card', void: 'Voided',
  };

  function when(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (_) { return String(iso).slice(0, 10); }
  }

  /* Signed, and shown signed. An issue is +$50 and a capture is −$20, and the
     column adds up to the balance — which is the point of showing it at all. */
  function signed(cents) {
    const n = Number(cents) || 0;
    return (n < 0 ? '−' : '+') + money(Math.abs(n));
  }

  function renderLedger(cards) {
    const host = $('svLedger');
    if (!host) return;
    if (!cards.length) {
      host.innerHTML = '<div class="sv-muted">Nothing issued yet under that filter.</div>';
      return;
    }
    host.innerHTML = `
      <table class="sv-ledger-table">
        <thead><tr>
          <th>Card</th><th>Issued to</th><th>Reason</th>
          <th style="text-align:right">Face</th><th style="text-align:right">Left</th><th></th>
        </tr></thead>
        <tbody>
          ${cards.map((c) => `
            <tr data-sv-id="${esc(c.id)}">
              <td>
                <code>${esc(c.masked)}</code>
                <div class="sv-muted" style="font-size:.72rem">
                  ${c.kind === 'store_credit' ? 'Store credit' : 'Gift card'}${c.status !== 'active' ? ' · ' + esc(c.status) : ''}${c.locked ? ' · locked' : ''}
                  ${c.createdAt ? ' · ' + esc(when(c.createdAt)) : ''}
                </div>
              </td>
              <td>${esc(c.ownerEmail || '—')}${c.claimed ? '<div class="sv-muted" style="font-size:.72rem">claimed to an account</div>' : ''}</td>
              <td class="sv-muted" style="font-size:.78rem">${esc(c.reason || c.sourceRef || '')}</td>
              <td style="text-align:right">${esc(money(c.initialCents))}</td>
              <td style="text-align:right"><strong>${esc(money(c.balanceCents))}</strong></td>
              <td style="text-align:right"><button type="button" class="btn btn-secondary btn-sm sv-entries-btn" data-sv-id="${esc(c.id)}">History</button></td>
            </tr>
            <tr class="sv-entries-row" data-sv-for="${esc(c.id)}" style="display:none"><td colspan="6"></td></tr>
          `).join('')}
        </tbody>
      </table>`;

    host.querySelectorAll('.sv-entries-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.svId;
        const row = host.querySelector('.sv-entries-row[data-sv-for="' + id + '"]');
        if (!row) return;
        if (row.style.display !== 'none') { row.style.display = 'none'; return; }
        row.style.display = '';
        const cell = row.firstElementChild;
        cell.innerHTML = '<div class="sv-muted">Reading the ledger…</div>';
        try {
          const r = await api({ action: 'entries', id });
          const entries = r.entries || [];
          if (!entries.length) { cell.innerHTML = '<div class="sv-muted">No entries — which should be impossible for a card that exists.</div>'; return; }
          let running = 0;
          cell.innerHTML = `
            <table class="sv-ledger-table sv-ledger-sub">
              <thead><tr><th>What happened</th><th>Order</th><th style="text-align:right">Amount</th><th style="text-align:right">Balance after</th><th>When</th></tr></thead>
              <tbody>${entries.map((en) => {
                running += Number(en.cents) || 0;
                return `<tr>
                  <td>${esc(KIND_WORDS[en.kind] || en.kind)}</td>
                  <td class="sv-muted">${esc(en.orderRef || '')}</td>
                  <td style="text-align:right">${esc(signed(en.cents))}</td>
                  <td style="text-align:right">${esc(money(running))}</td>
                  <td class="sv-muted">${esc(when(en.createdAt))}</td>
                </tr>`;
              }).join('')}</tbody>
            </table>`;
        } catch (err) {
          cell.innerHTML = '<div class="sv-muted">' + esc(err.message || 'Could not read that.') + '</div>';
        }
      });
    });
  }

  async function loadLedger() {
    const host = $('svLedger');
    if (!host) return;
    host.innerHTML = '<div class="sv-muted">Loading…</div>';
    try {
      const r = await api({ action: 'list', status: $('svLedgerStatus')?.value || 'active', limit: 100 });
      renderLedger(r.cards || []);
    } catch (e) {
      host.innerHTML = '<div class="sv-muted">' + esc(e.message || 'Could not read the ledger.') + '</div>';
    }
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
    /* Non-fatal on its own: an unreadable policy means the shipped defaults,
       which offer nothing extra. The switch above is what somebody came here
       to use and it must not go down with this. */
    try { state.policy = await readPolicy(); } catch (_) { state.policy = null; }
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
