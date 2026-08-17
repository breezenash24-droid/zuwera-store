// Wholesale — trade accounts, and the price list that makes them mean anything.
//
// Wholesale shipped as a resolver, a customer group, an order minimum and a
// database guard, with no way to operate any of it: an account was created by
// typing JSON into profiles.wholesale in the SQL editor. This page is the rest
// of that feature.
//
// Everything goes through /api/admin-wholesale. Nothing here writes to profiles
// directly, and that is the point rather than tidiness — profiles.wholesale
// decides what a customer is charged, so the browser sends FIELDS and the
// server builds the object. A body carrying a finished wholesale object is a
// body that can set min_order_cents to 0 on an account that is supposed to have
// a $250 floor.
//
// ── THE ONE THING THIS PAGE HAS TO SAY OUT LOUD ─────────────────────────────
//
// An approved buyer with no wholesale PRICE LIST pays retail. Nothing errors:
// listApplies() matches nothing, the resolver falls back to the catalogue
// price, and that fallback is the safety net that keeps an empty pricing system
// from selling everything at zero. Correct behaviour, and indistinguishable
// from a feature that does not work. So the missing list is the first thing on
// the page, not a footnote.
//
// Reads the global `sb` client (for the session token only) and the shared
// helpers escapeHtml / escapeAttr defined in admin.html.
(function () {
  'use strict';

  let _loaded = false;
  let _accounts = [];
  let _list = null;         // { exists, active, lists[] }
  let _matches = [];        // customer search results
  let _edit = null;         // the account being edited, or a new grant
  let _searchTimer = null;
  /* The search box is re-created on every redraw, so its text and focus have to
     live out here or typing is interrupted by its own results arriving. */
  let _searchFocus = false;
  let _searchValue = '';
  /* CONFIRMATION GOES WHERE THE BUTTON WAS.
     Creating the price list worked and read as if nothing had happened: the
     only acknowledgement was one grey line in #wholesale-note at the very
     BOTTOM of the page, while the button that was pressed sits at the top. The
     banner did change — from a yellow box to a quiet grey sentence — but a
     warning disappearing is not a confirmation, it is an absence, and an
     absence is exactly what "it didn't do anything" looks like.
     So a result is shown where the action was taken, and it survives the
     re-render that follows it. */
  let _flash = null;        // { msg, kind }

  const $ = (id) => document.getElementById(id);
  const money = (cents) => '$' + (Number(cents || 0) / 100).toFixed(2);

  function note(msg, kind) {
    const el = $('wholesale-note');
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
    const resp = await fetch('/api/admin-wholesale' + (query || ''), {
      method,
      headers: method === 'GET'
        ? { Authorization: 'Bearer ' + t }
        : { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) throw new Error(data.error || 'Request failed.');
    return data;
  }

  const STATUS_LABEL = {
    applied: ['Applied', 'rgba(251,191,36,.15)', '#fbbf24'],
    approved: ['Approved', 'rgba(34,197,94,.15)', '#22c55e'],
    suspended: ['Suspended', 'rgba(239,68,68,.15)', '#ef4444'],
  };

  const TERM_LABEL = {
    prepaid: 'Prepaid', net15: 'Net 15', net30: 'Net 30', net60: 'Net 60',
  };

  function pill(status) {
    const s = STATUS_LABEL[status] || [status || 'None', 'rgba(148,163,184,.15)', 'var(--text-secondary)'];
    return '<span style="font-size:.68rem;padding:.15rem .45rem;border-radius:4px;background:' + s[1]
      + ';color:' + s[2] + ';">' + escapeHtml(s[0]) + '</span>';
  }

  function empty(msg) {
    return '<div style="color:var(--text-secondary);font-size:.85rem;padding:.8rem 0;">' + escapeHtml(msg) + '</div>';
  }

  /* THE BANNER. Placed first and coloured, because the failure it describes is
     silent: approved buyers quietly paying retail, with nothing in any log to
     say so. */
  function listBanner() {
    if (!_list) return '';
    if (!_list.exists) {
      return '<div style="border:1px solid rgba(251,191,36,.4);background:rgba(251,191,36,.08);'
        + 'border-radius:8px;padding:.9rem 1rem;margin-bottom:1.2rem;">'
        + '<div style="font-weight:600;margin-bottom:.3rem;">No wholesale price list yet</div>'
        + '<div style="font-size:.8rem;color:var(--text-secondary);line-height:1.6;">'
        + 'Approving somebody puts them in the wholesale customer group, but nothing charges a '
        + 'different price until a price list exists for that group. Until then approved buyers '
        + 'pay the ordinary catalogue price and nothing reports a problem.'
        + '</div>'
        + '<button class="btn btn-primary btn-sm" style="margin-top:.7rem;" onclick="wholesaleEnsureList(this)">'
        + 'Create the wholesale price list</button></div>';
    }
    if (!_list.active) {
      return '<div style="border:1px solid rgba(239,68,68,.4);background:rgba(239,68,68,.08);'
        + 'border-radius:8px;padding:.9rem 1rem;margin-bottom:1.2rem;font-size:.82rem;line-height:1.6;">'
        + '<strong>The wholesale price list is switched off.</strong> Approved buyers are being charged '
        + 'the ordinary price. Turn it back on under Pricing.</div>';
    }
    const l = _list.lists[0] || {};
    const pct = Number(l.rule_percent_off);
    const hasRule = Number.isFinite(pct) && pct > 0;
    return '<div style="border:1px solid var(--border);border-radius:8px;padding:.9rem 1rem;'
      + 'margin-bottom:1.2rem;font-size:.82rem;line-height:1.65;">'

      + '<div style="font-weight:600;margin-bottom:.5rem;">How trade prices are worked out</div>'

      /* THE RULE FIRST, because it is the answer for almost every store.
         A row per product is the exception — and the trap, since a product
         added next month gets no row and is quietly sold at retail. */
      + '<label class="form-label" style="margin-top:.2rem;">Trade discount off the catalogue price</label>'
      + '<div style="display:flex;gap:.5rem;align-items:center;max-width:340px;">'
      + '<input id="wh-rule" type="number" min="0.01" max="99.99" step="0.01" class="form-input"'
      + ' value="' + (hasRule ? escapeAttr(String(pct)) : '') + '" placeholder="e.g. 40">'
      + '<span style="color:var(--text-secondary);">% off</span>'
      + '<button class="btn btn-secondary btn-sm" style="white-space:nowrap;" onclick="wholesaleSaveRule(this)">Save</button>'
      + '</div>'
      + '<div style="color:var(--text-secondary);margin-top:.4rem;">'
      + (hasRule
          ? 'Every product is ' + escapeHtml(String(pct)) + '% off for approved trade buyers, including ones you add later.'
          : 'Leave blank to price product by product instead. Be aware that anything you add afterwards then has '
            + 'no trade price and quietly sells at full retail.')
      + '</div>'

      + '<div style="color:var(--text-secondary);margin-top:.7rem;padding-top:.7rem;border-top:1px solid var(--border);">'
      + 'A price set on a specific product under <strong>Pricing</strong> always beats this rule — '
      + 'choose the <strong>' + escapeHtml(l.name || l.code || 'Wholesale') + '</strong> list when you propose one.'
      + '</div></div>';
  }

  function accountsTable() {
    if (!_accounts.length) return empty('No wholesale accounts yet.');
    return '<div style="overflow-x:auto;"><table class="products-table" style="width:100%;font-size:.82rem;">'
      + '<thead><tr><th>Customer</th><th>Company</th><th>Status</th><th>Minimum</th><th>Terms</th><th></th></tr></thead><tbody>'
      + _accounts.map((a) => {
        /* The minimum is shown as STORED, with a note when it is not being
           enforced. An admin who typed 250 on an application and saw "—" would
           reasonably conclude it had not saved. */
        const min = a.minOrderCents > 0 ? money(a.minOrderCents) : '—';
        const inert = a.minOrderCents > 0 && !a.enforcedCents
          ? '<div style="font-size:.68rem;color:var(--text-secondary);">not enforced until approved</div>'
          : '';
        return '<tr>'
          + '<td>' + escapeHtml(a.name || a.email || a.id)
            + (a.name && a.email ? '<div style="font-size:.7rem;color:var(--text-secondary);">' + escapeHtml(a.email) + '</div>' : '')
          + '</td>'
          + '<td style="color:var(--text-secondary);">' + escapeHtml(a.company || '—') + '</td>'
          + '<td>' + pill(a.status) + '</td>'
          + '<td>' + min + inert + '</td>'
          + '<td style="color:var(--text-secondary);">' + escapeHtml(TERM_LABEL[a.terms] || a.terms || '—') + '</td>'
          + '<td style="text-align:right;"><button class="btn btn-secondary btn-sm" onclick="wholesaleEdit(\''
            + escapeAttr(a.id) + '\')">Edit</button></td>'
          + '</tr>';
      }).join('')
      + '</tbody></table></div>';
  }

  function searchPanel() {
    const rows = _matches.length
      ? _matches.map((m) => '<div style="display:flex;align-items:center;justify-content:space-between;gap:.6rem;'
          + 'padding:.45rem 0;border-bottom:1px solid var(--border);">'
          + '<div><div>' + escapeHtml(m.name || m.email) + '</div>'
          + (m.name ? '<div style="font-size:.7rem;color:var(--text-secondary);">' + escapeHtml(m.email) + '</div>' : '')
          + '</div>'
          + (m.status
              ? '<span style="font-size:.72rem;color:var(--text-secondary);">already ' + escapeHtml(m.status) + '</span>'
              : '<button class="btn btn-secondary btn-sm" onclick="wholesaleGrant(\'' + escapeAttr(m.id) + '\',\''
                + escapeAttr(m.email) + '\')">Give a wholesale account</button>')
          + '</div>').join('')
      : '';
    return '<div class="zw-eyebrow" style="margin:1.75rem 0 .6rem;">Add an account</div>'
      + '<input id="wholesale-search" type="text" class="form-input" placeholder="Search customers by name or email"'
      + ' oninput="wholesaleSearch(this.value)" autocomplete="off">'
      + '<div style="font-size:.75rem;color:var(--text-secondary);margin-top:.35rem;line-height:1.5;">'
      + 'The customer needs an account on the store already — this turns an existing customer into a trade buyer.'
      + '</div>'
      + (rows ? '<div style="margin-top:.6rem;">' + rows + '</div>' : '');
  }

  function editPanel() {
    if (!_edit) return '';
    const a = _edit;
    const opt = (v, label, cur) => '<option value="' + escapeAttr(v) + '"'
      + (String(cur) === String(v) ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    return '<div class="zw-eyebrow" style="margin:1.75rem 0 .6rem;">'
      + escapeHtml(a.email || 'Wholesale account') + '</div>'
      + '<div style="border:1px solid var(--border);border-radius:8px;padding:1rem;max-width:560px;">'

      + '<label class="form-label">Status</label>'
      + '<select id="wh-status" class="form-input">'
        + opt('applied', 'Applied — not charged wholesale yet', a.status)
        + opt('approved', 'Approved — charged wholesale prices', a.status)
        + opt('suspended', 'Suspended — back to ordinary prices', a.status)
      + '</select>'
      + '<div style="font-size:.75rem;color:var(--text-secondary);margin-top:.35rem;line-height:1.5;">'
      + 'Only <strong>Approved</strong> puts this buyer in the wholesale group. The other two leave them paying '
      + 'ordinary prices, so an application can sit here safely.</div>'

      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-top:.7rem;">'
        + '<div><label class="form-label">Company</label>'
        + '<input id="wh-company" type="text" class="form-input" value="' + escapeAttr(a.company || '') + '"></div>'
        + '<div><label class="form-label">Tax ID</label>'
        + '<input id="wh-taxid" type="text" class="form-input" value="' + escapeAttr(a.taxId || '') + '"></div>'
      + '</div>'

      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-top:.7rem;">'
        + '<div><label class="form-label">Minimum order</label>'
        + '<input id="wh-min" type="number" min="0" step="0.01" class="form-input" value="'
          + escapeAttr(a.minOrderCents ? (a.minOrderCents / 100).toFixed(2) : '') + '" placeholder="250.00"></div>'
        + '<div><label class="form-label">Payment terms</label>'
        + '<select id="wh-terms" class="form-input">'
          + opt('prepaid', 'Prepaid', a.terms)
          + opt('net15', 'Net 15', a.terms)
          + opt('net30', 'Net 30', a.terms)
          + opt('net60', 'Net 60', a.terms)
        + '</select></div>'
      + '</div>'
      + '<div style="font-size:.75rem;color:var(--text-secondary);margin-top:.35rem;line-height:1.5;">'
      + 'The minimum is checked on the goods only — before shipping, tax and any discount code, so a buyer '
      + 'cannot reach it without actually buying more. Leave it blank for no minimum.'
      /* Terms are recorded, not enforced: checkout still takes payment. Saying
         so here is cheaper than a merchant discovering it after shipping on
         credit that was never extended. */
      + '<br><br>Payment terms are <strong>recorded on the account, not billed</strong> — checkout still '
      + 'takes payment at the till. Use them for your own records until invoicing exists.</div>'

      /* A LEGAL CLAIM, ASKED FOR IN ITS OWN WORDS.
         Inferred from the Tax ID it would zero the tax on every account
         carrying a VAT number or an EIN for invoicing, none of which is a
         resale certificate. */
      + '<label style="display:flex;gap:.55rem;align-items:flex-start;margin-top:.9rem;cursor:pointer;">'
      + '<input id="wh-exempt" type="checkbox"' + (a.resaleExempt ? ' checked' : '')
      + ' style="margin-top:.2rem;flex:none;">'
      + '<span><span style="font-size:.85rem;">Resale certificate on file — do not charge sales tax</span>'
      + '<span style="display:block;font-size:.75rem;color:var(--text-secondary);line-height:1.5;margin-top:.15rem;">'
      + 'Only applies while the account is Approved. Suspend it, remove it, or untick this and tax is '
      + 'charged again from the next order. Put the certificate number in Tax ID above.'
      + '</span></span></label>'

      + '<label class="form-label" style="margin-top:.7rem;">Notes</label>'
      + '<textarea id="wh-notes" class="form-input" rows="2">' + escapeHtml(a.notes || '') + '</textarea>'

      + (a.approvedAt
          ? '<div style="font-size:.72rem;color:var(--text-secondary);margin-top:.6rem;">Granted '
            + escapeHtml(String(a.approvedAt).slice(0, 10))
            + (a.approvedBy ? ' by ' + escapeHtml(a.approvedBy) : '') + '</div>'
          : '')

      + '<div style="display:flex;gap:.5rem;margin-top:.9rem;flex-wrap:wrap;">'
      + '<button class="btn btn-primary btn-sm" onclick="wholesaleSave(this)">Save</button>'
      + '<button class="btn btn-secondary btn-sm" onclick="wholesaleCancel()">Cancel</button>'
      + (a.status
          ? '<button class="btn btn-secondary btn-sm" style="margin-left:auto;" onclick="wholesaleRevoke(this)">'
            + 'Remove wholesale</button>'
          : '')
      + '</div></div>';
  }

  function flashBox() {
    if (!_flash) return '';
    const good = _flash.kind !== 'error';
    return '<div style="border:1px solid ' + (good ? 'rgba(34,197,94,.45)' : 'rgba(239,68,68,.45)')
      + ';background:' + (good ? 'rgba(34,197,94,.10)' : 'rgba(239,68,68,.10)')
      + ';border-radius:8px;padding:.75rem .9rem;margin-bottom:1rem;font-size:.85rem;line-height:1.6;">'
      + escapeHtml(_flash.msg) + '</div>';
  }

  function render() {
    const body = $('wholesale-body');
    if (!body) return;
    body.innerHTML = flashBox()
      + listBanner()
      + '<div class="zw-eyebrow" style="margin:0 0 .6rem;">Trade accounts</div>'
      + accountsTable()
      + editPanel()
      + searchPanel()
      + '<div id="wholesale-note" style="font-size:.8rem;margin-top:.9rem;color:var(--text-secondary);"></div>';
    /* Focus is restored after a redraw so typing in the search box is not
       interrupted by its own results arriving. */
    if (_searchFocus) {
      const s = $('wholesale-search');
      if (s) { s.value = _searchValue; s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    }
  }

  window.wholesaleLoadData = async function () {
    if (_loaded) { render(); return; }
    const body = $('wholesale-body');
    if (body) body.innerHTML = '<div style="color:var(--text-secondary);padding:1rem 0;">Loading…</div>';
    try {
      const data = await api('GET');
      _accounts = data.accounts || [];
      _list = data.list || null;
      _loaded = true;
      render();
    } catch (err) {
      if (body) {
        body.innerHTML = '<div style="color:var(--error,#ef4444);padding:1rem 0;">'
          + escapeHtml(err.message || 'Could not load wholesale accounts.') + '</div>';
      }
    }
  };

  window.wholesaleSearch = function (value) {
    _searchValue = value;
    _searchFocus = true;
    clearTimeout(_searchTimer);
    const term = String(value || '').trim();
    if (term.length < 2) { _matches = []; render(); return; }
    /* Debounced, because this runs a query per keystroke otherwise and the
       answer for "br" is never the one anybody wanted. */
    _searchTimer = setTimeout(async () => {
      try {
        const data = await api('GET', null, '?search=' + encodeURIComponent(term));
        _matches = data.matches || [];
        render();
      } catch (_) { /* the previous results stand */ }
    }, 250);
  };

  window.wholesaleGrant = function (id, email) {
    _edit = { id, email, status: 'approved', terms: 'prepaid', minOrderCents: 0 };
    _searchFocus = false;
    render();
    note('Set the terms, then Save. Nothing changes for this customer until you do.');
  };

  window.wholesaleEdit = function (id) {
    _edit = _accounts.find((a) => String(a.id) === String(id)) || null;
    _searchFocus = false;
    render();
  };

  window.wholesaleCancel = function () { _edit = null; _matches = []; render(); };

  window.wholesaleSave = async function (btn) {
    if (!_edit) return;
    const status = $('wh-status') ? $('wh-status').value : 'applied';
    if (status === 'approved' && _list && !_list.exists
      && !confirm('There is no wholesale price list yet, so this buyer will still pay ordinary prices.\n\nApprove anyway?')) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const res = await api('POST', {
        action: 'save',
        customerId: _edit.id,
        status,
        company: $('wh-company') ? $('wh-company').value : '',
        taxId: $('wh-taxid') ? $('wh-taxid').value : '',
        minOrder: $('wh-min') ? $('wh-min').value : '',
        terms: $('wh-terms') ? $('wh-terms').value : 'prepaid',
        notes: $('wh-notes') ? $('wh-notes').value : '',
        resaleExempt: !!($('wh-exempt') && $('wh-exempt').checked),
      });
      _list = res.list || _list;
      _edit = null;
      _matches = [];
      _loaded = false;
      await window.wholesaleLoadData();
      note(status === 'approved' ? 'Approved. This buyer is now in the wholesale group.' : 'Saved.');
    } catch (err) {
      note(err.message || 'Could not save that account.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  };

  window.wholesaleRevoke = async function (btn) {
    if (!_edit) return;
    if (!confirm('Remove the wholesale account for ' + (_edit.email || 'this customer')
      + '?\n\nThey stay a customer and go back to ordinary prices.')) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Removing…'; }
    try {
      await api('POST', { action: 'revoke', customerId: _edit.id });
      _edit = null;
      _loaded = false;
      await window.wholesaleLoadData();
      note('Removed. They are an ordinary customer again.');
    } catch (err) {
      note(err.message || 'Could not remove that account.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Remove wholesale'; }
    }
  };

  window.wholesaleSaveRule = async function (btn) {
    const el = $('wh-rule');
    const raw = el ? String(el.value).trim() : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const res = await api('POST', { action: 'set-rule', percentOff: raw === '' ? null : raw });
      _list = res.list || _list;
      _flash = {
        msg: res.percentOff === null
          ? 'Trade discount removed. Wholesale is now priced product by product under Pricing.'
          : 'Approved trade buyers now pay ' + res.percentOff + '% off the catalogue price, on every product '
            + 'including ones you add later.',
        kind: 'ok',
      };
      render();
    } catch (err) {
      _flash = { msg: err.message || 'Could not save that rule.', kind: 'error' };
      render();
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  };

  window.wholesaleEnsureList = async function (btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
    try {
      const res = await api('POST', { action: 'ensure-list' });
      _list = res.list || _list;
      _flash = {
        msg: res.created
          ? 'Wholesale price list created. Nothing is discounted yet — set the actual prices under Pricing and choose the Wholesale list when you propose one.'
          : 'That list already existed, so nothing changed.',
        kind: 'ok',
      };
      render();
    } catch (err) {
      note(err.message || 'Could not create the price list.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Create the wholesale price list'; }
    }
  };
})();
