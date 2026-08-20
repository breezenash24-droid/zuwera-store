                    /* ── State ──────────────────────────────────────────────── */
                    let _returnsData     = [];
                    let _selectedReturnId = null;

                    const RETURN_STATUSES = [
                        ['requested',           'Requested'],
                        ['approved',            'Approved'],
                        ['label_sent',          'Label Sent'],
                        ['item_received',       'Item Received'],
                        ['exchange_in_progress','Exchange In Progress'],
                        ['completed',           'Completed'],
                        ['refunded',            'Refunded'],
                        ['denied',              'Denied'],
                        ['closed',              'Closed'],
                    ];
                    const RETURN_STATUS_COLORS = {
                        requested:           '#f59e0b',
                        approved:            '#22c55e',
                        label_sent:          '#38bdf8',
                        item_received:       '#34d399',
                        denied:              '#ef4444',
                        completed:           '#a78bfa',
                        refunded:            '#6b7280',
                        closed:              '#6b7280',
                        exchange_in_progress:'#a78bfa',
                    };
                    /* `refunded` used to be in here, so a request already paid
                       out went on offering "Mark refunded" — the same mistake
                       the endpoint had, where a settled return read as
                       clearance to settle it again. It is the strongest signal
                       in the list that this is a second attempt. */
                    const REFUND_ALLOWED_STATUSES = new Set(['item_received', 'completed', 'closed']);

                    /* The order's own state, which the request does not carry.
                       A return can be sitting at "item received" while the
                       order was refunded from the Receipts page an hour ago —
                       and then the workspace walks somebody through typing an
                       auth code before anything says no. Filled in by
                       loadReturnsPage; empty means unknown, which does not
                       block, because a lookup that failed is not evidence. */
                    let _orderStatusById = {};
                    let _orderIndexById = {};
                    function retOrderSettled(r) {
                        const s = String(_orderStatusById[String(r && r.orderId || '')] || '').toLowerCase();
                        return s === 'refunded' || s === 'cancelled' || s === 'canceled';
                    }

                    function syncReturnsUI() {
                        renderReturnsStats();
                        window.renderReturnsTable();
                        renderReturnDetails();
                    }

                    function retAttr(value) { return escapeHtml(value).replace(/`/g, '&#96;'); }
                    function retSafeUrl(url) { return url && /^https?:\/\//i.test(String(url)) ? String(url) : null; }
                    function retMoney(value) {
                        const n = Number(value || 0);
                        return Number.isFinite(n) ? '$' + n.toFixed(2) : '$0.00';
                    }
                    function retAddressMissing(r) {
                        const a = r.shippingAddress || {};
                        return !a.line1 || !a.city || !a.state || !a.zip || !a.country;
                    }
                    function retLabelError(r) {
                        return String(r.lastLabelError || r.labelError || '').trim();
                    }
                    function retCanAttemptLabel(r) {
                        return ['requested', 'approved', 'label_sent', 'item_received', 'exchange_in_progress'].includes(r.status || '');
                    }
                    function retCanRefund(r) {
                        /* Two questions, both of which have to say yes: has the
                           item come back, and is there anything left to refund.
                           The second was never asked here — it was only asked
                           at the end, by the endpoint, after an auth code. */
                        return REFUND_ALLOWED_STATUSES.has(r.status || '') && !retOrderSettled(r);
                    }
                    function retNextAction(r) {
                        if (retLabelError(r)) return 'Fix label issue or save a manual label';
                        if (retAddressMissing(r)) return 'Add/fix customer address';
                        if (r.status === 'requested') return 'Review, approve, then send label';
                        if (r.status === 'approved' && !r.labelUrl) return 'Send return label';
                        if (r.status === 'label_sent') return 'Waiting for item — mark received once it arrives';
                        if (r.status === 'item_received') return 'Item received — inspect then issue refund or complete';
                        if (r.status === 'exchange_in_progress') return 'Send replacement / update exchange';
                        if (r.status === 'completed' || r.status === 'refunded' || r.status === 'closed') return 'Finished';
                        if (r.status === 'denied') return 'Denied';
                        return 'Review request';
                    }
                    function retStatusBadge(status) {
                        const color = RETURN_STATUS_COLORS[status] || 'var(--text-secondary)';
                        return `<span style="font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:${color};border:1px solid ${color};padding:2px 8px;border-radius:4px;white-space:nowrap;">${escapeHtml(status || '-')}</span>`;
                    }
                    /* `refunded` is not hand-settable.
                       It means money moved, and money only moves through
                       /api/admin-refund — which also sets the order's status,
                       closes the request and emails the customer. Setting it
                       from this dropdown did none of that: it wrote one word
                       and left the order saying `confirmed` forever.
                       That path existed before today behind a Save button four
                       fields further down. Making the dropdown save on change
                       fixed a real complaint and, in the same stroke, made the
                       disconnected route the easy one — so it comes out.
                       A return already refunded still SHOWS as refunded; the
                       option is only removed from the ones you can pick. */
                    function retStatusOptions(current) {
                        return RETURN_STATUSES
                            .filter(([value]) => value !== 'refunded' || current === 'refunded')
                            .map(([value, label]) => `<option value="${value}"${current === value ? ' selected' : ''}`
                                + `${value === 'refunded' ? ' disabled' : ''}>${label}</option>`)
                            .join('');
                    }
                    function retField(id) { return document.getElementById(id)?.value ?? ''; }
                    function notifyReturns(message, type = 'info') {
                        if (typeof showToast === 'function') showToast(message, type);
                        const box = document.getElementById('returns-status');
                        if (box) {
                            const color = type === 'error' ? '#f97316' : (type === 'success' ? '#22c55e' : 'var(--text-secondary)');
                            box.style.display = 'block';
                            box.style.borderColor = type === 'error' ? 'rgba(249,115,22,.35)' : 'var(--border)';
                            box.style.color = color;
                            box.textContent = message;
                        } else if (type === 'error') alert(message);
                    }

                    // ── Return Address Card ────────────────────────────────────────
                    window.toggleReturnAddressCard = function() {
                        const form = document.getElementById('ret-addr-form');
                        const chevron = document.getElementById('ret-addr-chevron');
                        if (!form) return;
                        const open = form.style.display === 'none';
                        form.style.display = open ? 'block' : 'none';
                        if (chevron) chevron.style.transform = open ? 'rotate(180deg)' : 'rotate(0deg)';
                    };

                    window.loadReturnAddressCard = async function() {
                        const summary = document.getElementById('ret-addr-summary');
                        const badge   = document.getElementById('ret-addr-badge');
                        const form    = document.getElementById('ret-addr-form');
                        const chevron = document.getElementById('ret-addr-chevron');
                        if (!summary) return;
                        summary.textContent = 'Loading…';
                        try {
                            const { data: { session } } = await sb.auth.getSession();
                            const token = session?.access_token;
                            if (!token) throw new Error('Not authenticated');

                            // Fetch the real unmasked address values
                            const r = await fetch('/api/get-return-address', {
                                headers: { Authorization: `Bearer ${token}` }
                            });
                            const d = await r.json().catch(() => ({}));
                            if (!d.ok) throw new Error(d.error || 'Could not load address');
                            const addr = d.address || {};

                            const hasStreet  = !!addr.SHIPPO_FROM_STREET1;
                            const hasCity    = !!addr.SHIPPO_FROM_CITY;
                            const hasState   = !!addr.SHIPPO_FROM_STATE;
                            const hasZip     = !!addr.SHIPPO_FROM_ZIP;
                            const allSet     = hasStreet && hasCity && hasState && hasZip;

                            // Pre-fill form fields with current values
                            const fieldMap = {
                                'ra-name': 'SHIPPO_FROM_NAME', 'ra-street1': 'SHIPPO_FROM_STREET1',
                                'ra-street2': 'SHIPPO_FROM_STREET2', 'ra-city': 'SHIPPO_FROM_CITY',
                                'ra-state': 'SHIPPO_FROM_STATE', 'ra-zip': 'SHIPPO_FROM_ZIP',
                                'ra-country': 'SHIPPO_FROM_COUNTRY',
                            };
                            Object.entries(fieldMap).forEach(([id, key]) => {
                                const el = document.getElementById(id);
                                if (el && addr[key]) el.value = addr[key];
                            });

                            if (allSet) {
                                const namePart = addr.SHIPPO_FROM_NAME ? addr.SHIPPO_FROM_NAME + ', ' : '';
                                const cityState = [addr.SHIPPO_FROM_CITY, addr.SHIPPO_FROM_STATE, addr.SHIPPO_FROM_ZIP].filter(Boolean).join(' ');
                                summary.textContent = namePart + addr.SHIPPO_FROM_STREET1 + (cityState ? ', ' + cityState : '');
                                badge.innerHTML = '<span style="font-size:.75rem;color:var(--success);font-weight:600;">✓ Ready</span>';
                                if (form) form.style.display = 'none';
                                if (chevron) chevron.style.transform = 'rotate(0deg)';
                            } else {
                                const missing = [];
                                if (!hasStreet) missing.push('Street');
                                if (!hasCity)   missing.push('City');
                                if (!hasState)  missing.push('State');
                                if (!hasZip)    missing.push('ZIP');
                                summary.textContent = 'Missing: ' + missing.join(', ') + ' — labels won\'t generate until this is set.';
                                badge.innerHTML = '<span style="font-size:.75rem;color:var(--error);font-weight:600;">⚠ Incomplete</span>';
                                if (form) form.style.display = 'block';
                                if (chevron) chevron.style.transform = 'rotate(180deg)';
                            }
                        } catch(e) {
                            if (summary) summary.textContent = 'Could not load address status.';
                        }
                    };

                    window.saveReturnAddress = async function() {
                        const statusEl = document.getElementById('ret-addr-status');
                        const saveBtn  = document.querySelector('#ret-addr-form .btn.btn-primary');
                        const fields = [
                            { id: 'ra-name',    key: 'SHIPPO_FROM_NAME' },
                            { id: 'ra-street1', key: 'SHIPPO_FROM_STREET1' },
                            { id: 'ra-street2', key: 'SHIPPO_FROM_STREET2' },
                            { id: 'ra-city',    key: 'SHIPPO_FROM_CITY' },
                            { id: 'ra-state',   key: 'SHIPPO_FROM_STATE' },
                            { id: 'ra-zip',     key: 'SHIPPO_FROM_ZIP' },
                            { id: 'ra-country', key: 'SHIPPO_FROM_COUNTRY' },
                        ];
                        const updates = fields
                            .map(f => ({ key: f.key, value: (document.getElementById(f.id)?.value || '').trim() }))
                            .filter(u => u.value.length > 0);

                        if (!updates.length) {
                            if (statusEl) { statusEl.style.color = 'var(--warning)'; statusEl.textContent = 'Fill in at least one field to save.'; }
                            return;
                        }
                        if (statusEl) { statusEl.style.color = 'var(--text-secondary)'; statusEl.textContent = 'Saving…'; }
                        if (saveBtn) saveBtn.disabled = true;
                        try {
                            const { data: { session } } = await sb.auth.getSession();
                            const token = session?.access_token;
                            if (!token) throw new Error('Not authenticated — please refresh and sign in again.');
                            const errors = [];
                            let saved = 0;
                            for (const u of updates) {
                                const r = await fetch('/api/update-api-key', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ accessToken: token, keyName: u.key, keyValue: u.value }),
                                });
                                const d = await r.json().catch(() => ({}));
                                if (d.ok) { saved++; }
                                else { errors.push(`${u.key}: ${d.error || 'unknown error'}`); }
                            }
                            if (errors.length) {
                                if (statusEl) { statusEl.style.color = 'var(--error)'; statusEl.textContent = '✗ Errors: ' + errors.join('; '); }
                            } else {
                                if (statusEl) { statusEl.style.color = 'var(--success)'; statusEl.textContent = `✓ Saved ${saved} field${saved !== 1 ? 's' : ''}. Reloading…`; }
                                // Reload card with real values after a brief pause
                                setTimeout(() => { loadReturnAddressCard(); if (statusEl) statusEl.textContent = ''; }, 900);
                            }
                        } catch(e) {
                            if (statusEl) { statusEl.style.color = 'var(--error)'; statusEl.textContent = '✗ ' + e.message; }
                        } finally {
                            if (saveBtn) saveBtn.disabled = false;
                        }
                    };

                    let _retStage = 'open'; // active pipeline tab

                    const PIPELINE_TABS = [
                        { key:'open',     label:'Needs Action',  match: r => ['requested','approved'].includes(r.status) },
                        { key:'transit',  label:'In Transit',    match: r => r.status === 'label_sent' },
                        { key:'received', label:'Item Received', match: r => r.status === 'item_received' },
                        { key:'done',     label:'Done',          match: r => ['completed','refunded','closed','denied','exchange_in_progress'].includes(r.status) },
                        { key:'all',      label:'All',           match: () => true },
                    ];

                    window.loadReturnsPage = async function() {
                        document.getElementById('returns-loading').style.display = 'block';
                        document.getElementById('returns-loading').textContent = 'Loading…';
                        document.getElementById('ret-split').style.display = 'none';
                        const statusBox = document.getElementById('returns-status');
                        if (statusBox) { statusBox.style.display = 'none'; statusBox.textContent = ''; }
                        try {
                            const { data: { session } } = await sb.auth.getSession();
                            const token = session?.access_token;
                            if (!token) throw new Error('Missing admin session token.');
                            const resp = await fetch('/api/admin-returns', { headers: { Authorization: `Bearer ${token}` } });
                            const payload = await resp.json().catch(() => ({}));
                            if (!resp.ok || !payload.success) throw new Error(payload.error || 'Could not load returns.');
                            _returnsData = Array.isArray(payload.requests) ? payload.requests : [];
                            _returnsData.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
                            if (_selectedReturnId && !_returnsData.some(r => r.id === _selectedReturnId)) _selectedReturnId = null;

                            /* One query for every order on screen, so the panel
                               knows what has already been refunded before it
                               offers to refund it. Failure leaves the map empty
                               and nothing is blocked — an unanswered lookup is
                               not evidence that a refund happened, and the
                               endpoint still refuses either way. */
                            try {
                                const ids = [...new Set(_returnsData.map(r => String(r.orderId || '')).filter(Boolean))];
                                if (ids.length) {
                                    const { data: ords } = await sb.from('orders')
                                        .select('id,status,order_number,stripe_payment_intent_id').in('id', ids);
                                    _orderStatusById = Object.fromEntries((ords || []).map(o => [String(o.id), o.status]));
                                    /* The whole row, so the panel can print the name the
                                       Orders page prints instead of the id's last eight. */
                                    _orderIndexById = Object.fromEntries((ords || []).map(o => [String(o.id), o]));
                                }
                            } catch (e) { console.warn('returns: could not read order statuses —', e && e.message); }

                            document.getElementById('returns-loading').style.display = 'none';
                            document.getElementById('ret-split').style.display = 'flex';
                            renderReturnsStats();
                            window.renderReturnsTable();
                            renderReturnDetails();
                        } catch(e) {
                            document.getElementById('returns-loading').textContent = 'Could not load returns: ' + e.message;
                        }
                    };

                    function renderReturnsStats() {
                        // Render pipeline tabs with live counts
                        const pipeline = document.getElementById('ret-pipeline');
                        if (!pipeline) return;
                        pipeline.innerHTML = PIPELINE_TABS.map(tab => {
                            const count = _returnsData.filter(tab.match).length;
                            const active = _retStage === tab.key;
                            const urgentDot = (tab.key === 'open' && count > 0) ? `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#f59e0b;margin-right:4px;vertical-align:middle;"></span>` : '';
                            return `<button onclick="retSetStage('${tab.key}')" style="display:flex;align-items:center;gap:6px;padding:6px 14px;border-radius:20px;border:1px solid ${active?'var(--accent)':'var(--border)'};background:${active?'var(--accent)':'transparent'};color:${active?'#09090b':'var(--text-primary)'};font-size:.8rem;font-weight:${active?'700':'500'};cursor:pointer;white-space:nowrap;transition:all .15s;">${urgentDot}${tab.label}<span style="background:${active?'rgba(0,0,0,.18)':'var(--border)'};border-radius:99px;font-size:.7rem;padding:1px 7px;font-weight:700;">${count}</span></button>`;
                        }).join('');
                    }

                    window.retSetStage = function(key) {
                        _retStage = key;
                        renderReturnsStats();
                        window.renderReturnsTable();
                    };

                    function getFilteredReturns() {
                        const tab   = PIPELINE_TABS.find(t => t.key === _retStage) || PIPELINE_TABS[PIPELINE_TABS.length - 1];
                        const typeF   = document.getElementById('ret-filter-type')?.value || '';
                        const searchF = (document.getElementById('ret-filter-search')?.value || '').toLowerCase();
                        return _returnsData.filter(r => {
                            if (!tab.match(r)) return false;
                            if (typeF && r.resolution !== typeF) return false;
                            if (searchF) {
                                const hay = [r.id, r.orderId, r.orderLabel, r.userId, r.userEmail, r.userName, r.customerEmail, r.customerName, r.reason, r.notes, r.internalNotes, r.customerMessage, r.exchangeSku, r.trackingNumber].join(' ').toLowerCase();
                                if (!hay.includes(searchF)) return false;
                            }
                            return true;
                        });
                    }

                    window.renderReturnsTable = function() {
                        const rows = getFilteredReturns();
                        const cards = document.getElementById('ret-cards');
                        const empty = document.getElementById('ret-list-empty');
                        if (!rows.length) {
                            cards.innerHTML = '';
                            empty.style.display = 'block';
                            return;
                        }
                        empty.style.display = 'none';
                        cards.innerHTML = rows.map(r => {
                            const id          = retAttr(r.id || '');
                            const orderLabel  = window.ZWOrderNo(_orderIndexById[String(r.orderId || '')] || r.orderId) || r.orderLabel || '';
                            const name        = r.customerName || r.userName || 'Customer';
                            const email       = r.customerEmail || r.userEmail || '';
                            const color       = RETURN_STATUS_COLORS[r.status] || 'var(--text-secondary)';
                            const nextAction  = retNextAction(r);
                            const labelError  = retLabelError(r);
                            const isSelected  = _selectedReturnId === r.id;
                            const hasProblem  = labelError || retAddressMissing(r);
                            const resType     = { return:'Return', exchange:'Exchange', store_credit:'Credit' }[r.resolution] || 'Return';
                            return `<div onclick="retSelectReturn('${id}')" style="padding:14px 16px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;gap:12px;align-items:stretch;background:${isSelected ? 'var(--bg-secondary)' : 'transparent'};transition:background .12s;" onmouseover="if(!${isSelected})this.style.background='var(--bg-secondary)'" onmouseout="if(!${isSelected})this.style.background='transparent'">
                                <div style="width:3px;border-radius:2px;flex-shrink:0;background:${hasProblem ? '#f97316' : color};"></div>
                                <div style="flex:1;min-width:0;">
                                    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:3px;">
                                        <div style="font-weight:600;font-size:.84rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(name)}</div>
                                        <div style="font-size:.7rem;color:var(--text-secondary);white-space:nowrap;flex-shrink:0;">${fmtDate(r.createdAt)}</div>
                                    </div>
                                    <div style="font-size:.75rem;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:5px;">${escapeHtml(email || '—')}</div>
                                    <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:5px;">
                                        <span style="font-family:monospace;font-size:.75rem;color:var(--text-secondary);">${escapeHtml(orderLabel)}</span>
                                        <span style="font-size:.72rem;color:var(--text-secondary);">${retMoney(r.orderTotal)} · ${resType}</span>
                                    </div>
                                    ${r.reason ? `<div style="font-size:.75rem;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:5px;" title="${retAttr(r.reason)}">${escapeHtml(r.reason)}</div>` : ''}
                                    <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
                                        ${retStatusBadge(r.status)}
                                        ${hasProblem ? `<span style="font-size:.7rem;color:#f97316;font-weight:600;">${labelError ? '⚠ Label error' : '⚠ No address'}</span>` : `<span style="font-size:.7rem;color:${color};">${escapeHtml(nextAction)}</span>`}
                                    </div>
                                </div>
                            </div>`;
                        }).join('');
                    };

                    function retSelectReturn(requestId) {
                        _selectedReturnId = requestId;
                        renderReturnsTable();
                        renderReturnDetails();
                        const card = document.querySelector(`#ret-cards [onclick*="${CSS.escape(requestId)}"]`);
                        if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    }

                    function renderReturnDetails() {
                        const panel = document.getElementById('returns-detail-panel');
                        const empty = document.getElementById('ret-detail-empty');
                        const r = _returnsData.find(x => x.id === _selectedReturnId);
                        if (!r) {
                            panel.style.display = 'none';
                            panel.innerHTML = '';
                            if (empty) empty.style.display = 'flex';
                            return;
                        }
                        if (empty) empty.style.display = 'none';
                        const id = retAttr(r.id || '');
                        const a = r.shippingAddress || {};
                        const orderLabel = window.ZWOrderNo(_orderIndexById[String(r.orderId || '')] || r.orderId) || r.orderLabel || '';
                        function renderItemRows(items) {
                            return items.length ? items.map(item => {
                                const name = item.name || item.title || item.product_title || 'Item';
                                const qty = item.quantity || item.qty || 1;
                                const meta = [item.sku, item.size, item.color || item.colorName].filter(Boolean).join(' / ');
                                return `<div style="display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border);padding:8px 0;"><div><div style="font-weight:600;">${escapeHtml(name)}</div><div style="color:var(--text-secondary);font-size:.75rem;">${escapeHtml(meta || 'No variant data')}</div></div><div style="text-align:right;color:var(--text-secondary);font-size:.8rem;">x${escapeHtml(String(qty))}<br>${retMoney(item.price || item.unit_price || 0)}</div></div>`;
                            }).join('') : '<p style="color:var(--text-secondary);font-size:.82rem;">No line item data.</p>';
                        }
                        const returnItems = Array.isArray(r.returnItems) && r.returnItems.length ? r.returnItems : null;
                        const orderItems = Array.isArray(r.orderItems) ? r.orderItems : [];
                        const isPartial = returnItems && orderItems.length > 0 && returnItems.length < orderItems.length;
                        const returnItemsHtml = renderItemRows(returnItems || orderItems);
                        const orderItemsHtml = isPartial
                            ? `<details style="margin-top:.75rem;"><summary style="font-size:.72rem;color:var(--text-secondary);cursor:pointer;user-select:none;">Full order (${orderItems.length} item${orderItems.length !== 1 ? 's' : ''})</summary><div style="margin-top:.5rem;">${renderItemRows(orderItems)}</div></details>`
                            : '';
                        const _detailLabelUrl = retSafeUrl(r.labelUrl);
                        const _detailTrackUrl = retSafeUrl(r.trackingUrl);
                        const labelLinks = _detailLabelUrl
                            ? `<a href="${retAttr(_detailLabelUrl)}" target="_blank" style="color:#38bdf8;text-decoration:underline;">Open label PDF</a>${_detailTrackUrl ? ` <span style="color:var(--text-secondary);">/</span> <a href="${retAttr(_detailTrackUrl)}" target="_blank" style="color:#38bdf8;text-decoration:underline;">Track package</a>` : ''}`
                            : '<span style="color:var(--text-secondary);">No return label sent yet.</span>';
                        const labelError = retLabelError(r);
                        const labelErrorHtml = labelError
                            ? `<div style="margin-top:.75rem;padding:.75rem;border:1px solid rgba(249,115,22,.35);border-radius:8px;color:#f97316;background:rgba(249,115,22,.08);font-size:.82rem;line-height:1.45;"><strong>Last label attempt failed:</strong> ${escapeHtml(labelError)}${r.labelErrorAt ? `<br><span style="color:var(--text-secondary);">At ${new Date(r.labelErrorAt).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})}</span>` : ''}<br><span style="color:var(--text-secondary);">Use the manual label fields below if Shippo has no available rates for this address.</span></div>`
                            : '';
                        const sendLabelDisabled = retCanAttemptLabel(r) ? '' : 'disabled';
                        const sendLabelText = r.status === 'requested' ? 'Approve + Send Label' : (r.labelUrl ? 'Resend Label' : 'Send Label');

                        /* A return has stages, and the panel did not show them.
                           Ten buttons sat in one row at equal weight, in three
                           different hand-picked colours, all present whatever
                           state the return was in — so the only way to know
                           which one to press was to already know the process.
                           Two of them disabled themselves with a tooltip, which
                           is the panel admitting there IS an order and then
                           declining to show it.

                           So: where this return is, one button for the step it
                           is actually on, and the rest folded away. The others
                           are kept rather than hidden for good — going back a
                           step is a real thing that happens, and a process you
                           cannot reverse is worse than a cluttered one. */
                        const STAGES = [
                            { key: 'asked',    label: 'Requested' },
                            { key: 'sent',     label: 'Label sent' },
                            { key: 'received', label: 'Item back' },
                            { key: 'done',     label: 'Resolved' },
                        ];
                        const stageOf = (s) => (
                            s === 'requested' ? 0
                          : s === 'approved' || s === 'label_sent' ? 1
                          : s === 'item_received' || s === 'exchange_in_progress' ? 2
                          : 3);
                        const at = stageOf(String(r.status || 'requested'));
                        const isDenied = String(r.status || '') === 'denied';

                        const stageBar = isDenied
                            ? '<div style="font-size:.78rem;color:var(--text-secondary)">Denied — no further steps.</div>'
                            : '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:.72rem">'
                              + STAGES.map((s, n) => {
                                  const done = n < at, now = n === at;
                                  const colour = done ? 'color:#34d399' : now ? 'color:var(--text-primary);font-weight:600' : 'color:var(--text-secondary);opacity:.6';
                                  return (n ? '<span style="opacity:.35">→</span>' : '')
                                      + '<span style="' + colour + '">' + (done ? '✓ ' : '') + s.label + '</span>';
                              }).join('')
                              + '</div>';

                        /* One next step, decided from the status and the
                           resolution — an exchange and a refund diverge here,
                           and the old row offered both at once with no hint
                           which applied. */
                        const wantsExchange = String(r.resolution || '') === 'exchange';
                        const primary = (
                            at === 0 ? { label: sendLabelText, call: `sendReturnLabel('${id}', this)`, off: sendLabelDisabled }
                          : at === 1 ? { label: 'Mark item received', call: `quickReturnStatus('${id}','item_received')`, off: '' }
                          : at === 2 && String(r.status) === 'exchange_in_progress'
                                     ? { label: 'Complete', call: `quickReturnStatus('${id}','completed')`, off: '' }
                          : at === 2 && wantsExchange
                                     ? { label: 'Start the exchange', call: `quickReturnStatus('${id}','exchange_in_progress')`, off: '' }
                          : at === 2 ? { label: 'Mark refunded', call: `quickMarkRefunded('${id}')`,
                                         off: retCanRefund(r) ? ''
                                              : retOrderSettled(r)
                                              ? 'disabled title="This order has already been refunded — there is nothing left to refund"'
                                              : 'disabled title="Item must be received before marking refunded"' }
                          : null);

                        /* Everything else, uniform. The greens and blues were
                           per-button decisions that made unrelated actions look
                           related — one colour meant "safe", the same colour
                           elsewhere meant "email". */
                        const others = [
                            ['Approve', `quickReturnStatus('${id}','approved')`, ''],
                            [sendLabelText, `sendReturnLabel('${id}', this)`, sendLabelDisabled],
                            ['✉ Email update', `sendReturnStatusEmail('${id}', this)`, ''],
                            ['Item received', `quickReturnStatus('${id}','item_received')`, ''],
                            ['Exchange started', `quickReturnStatus('${id}','exchange_in_progress')`, ''],
                            /* Also here, not just on the primary. "Other
                               actions" is where somebody goes when the obvious
                               button is off — an escape hatch that still pays
                               out would make disabling the first one theatre. */
                            ['Mark refunded', `quickMarkRefunded('${id}')`,
                             retCanRefund(r) ? ''
                             : retOrderSettled(r)
                             ? 'disabled title="This order has already been refunded"'
                             : 'disabled title="Item must be received before marking refunded"'],
                            ['+ Restock', `openRestockModal('${id}')`,
                             ['item_received', 'refunded', 'completed'].includes(String(r.status)) ? '' : 'disabled title="Restock available after the item is received"'],
                            ['Complete', `quickReturnStatus('${id}','completed')`, ''],
                            ['Deny', `quickReturnStatus('${id}','denied')`, ''],
                            ['Close', `quickReturnStatus('${id}','closed')`, ''],
                        ].filter(([label]) => !primary || label !== primary.label);

                        const actionsHtml =
                            (primary
                              ? `<button class="btn btn-primary btn-sm" onclick="${primary.call}" ${primary.off}>${escapeHtml(primary.label)}</button>`
                              : '<span style="font-size:.78rem;color:var(--text-secondary)">Finished — nothing left to do.</span>')
                            + `<details style="position:relative"><summary style="cursor:pointer;font-size:.78rem;color:var(--text-secondary);padding:6px 4px;list-style:none">Other actions ▾</summary>`
                            + `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;max-width:420px">`
                            + others.map(([label, call, off]) =>
                                `<button class="btn btn-secondary btn-sm" onclick="${call}" ${off}>${escapeHtml(label)}</button>`).join('')
                            + `</div></details>`;

                        panel.style.display = 'block';
                        panel.innerHTML = `
                            <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;margin-bottom:1rem;">
                                <div>
                                    <div style="font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--text-secondary);margin-bottom:5px;">Return Workspace</div>
                                    <h3 style="margin:0 0 5px;font-size:1.05rem;">${escapeHtml(orderLabel)} — ${escapeHtml(r.customerName || 'Customer')}</h3>
                                    <div style="color:var(--text-secondary);font-size:.78rem;">
                                        Created ${r.createdAt ? new Date(r.createdAt).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}) : '-'}${r.updatedAt ? ' · Updated ' + new Date(r.updatedAt).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}) : ''}
                                    </div>
                                    <div style="margin-top:8px;">${stageBar}</div>
                                    ${retOrderSettled(r) ? `<div style="margin-top:8px;border:1px solid #ef4444;border-left-width:4px;border-radius:6px;padding:.5rem .7rem;background:rgba(239,68,68,.08);color:#ef4444;font-size:.78rem;line-height:1.5;">
                                        <strong>This order has already been refunded.</strong> Anything here that would pay out is switched off — refunding again would pay twice for the same item.
                                    </div>` : ''}
                                    <div style="margin-top:6px;color:#38bdf8;font-size:.78rem;">→ ${escapeHtml(retNextAction(r))}</div>
                                </div>
                                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start;">
                                    ${actionsHtml}
                                </div>
                            </div>

                            <div style="display:grid;grid-template-columns:minmax(260px,1.1fr) minmax(260px,.9fr);gap:1rem;margin-bottom:1rem;">

                                <!-- Left: editable fields -->
                                <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:1rem;">
                                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;margin-bottom:.85rem;">
                                        <!-- These save on change. Nothing ever locked them — the
                                             Save Details button that commits them is four fields
                                             and two text areas further down, so changing the
                                             dropdown and watching nothing happen reads exactly
                                             like a control that has been disabled. Which matters
                                             most for Resolution: misclick "Exchange Started" and
                                             the way back looked closed. -->
                                        <div><label class="form-label">Status <span style="opacity:.5;font-weight:400">— saves as you pick</span></label>
                                            <select id="ret-detail-status-${id}" class="form-select" onchange="saveReturnDetails('${id}')">${retStatusOptions(r.status)}</select></div>
                                        <!-- STORE CREDIT IS NOT ON THIS MENU. It was, and there is
                                             no credit balance anywhere in the system: no ledger,
                                             nothing in the account page that could show one, and
                                             nothing in cart pricing or the payment intent that
                                             could spend it. Settling a return as credit meant
                                             telling a customer about money they had no way to
                                             use, and the staff member doing it had no way to know
                                             that.

                                             It stays visible on a return that ALREADY carries it
                                             — marked retired, so the row reads correctly and can
                                             be moved to refund or exchange — and it cannot be
                                             chosen for a new one. Building the ledger for real is
                                             on the work queue; until it exists the honest thing
                                             is to not offer it. -->
                                        <div><label class="form-label">Resolution <span style="opacity:.5;font-weight:400">— saves as you pick</span></label>
                                            <select id="ret-detail-resolution-${id}" class="form-select" onchange="saveReturnDetails('${id}')">
                                                <option value="return" ${r.resolution === 'return' ? 'selected' : ''}>Return / Refund</option>
                                                <option value="exchange" ${r.resolution === 'exchange' ? 'selected' : ''}>Exchange</option>
                                                ${r.resolution === 'store_credit' ? '<option value="store_credit" selected>Store Credit (retired)</option>' : ''}
                                            </select></div>
                                        <div><label class="form-label">Exchange SKU / Size</label>
                                            <input id="ret-detail-exchange-${id}" class="form-input" value="${retAttr(r.exchangeSku || '')}" placeholder="Replacement SKU or size"></div>
                                        <div><label class="form-label">Order Total</label>
                                            <input class="form-input" value="${retAttr(retMoney(r.orderTotal))}" readonly style="opacity:.5;cursor:default"></div>
                                    </div>
                                    <div style="margin-bottom:.75rem;"><label class="form-label">Customer Reason</label>
                                        <input id="ret-detail-reason-${id}" class="form-input" value="${retAttr(r.reason || '')}"></div>
                                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;">
                                        <div><label class="form-label">Customer Notes</label>
                                            <textarea id="ret-detail-notes-${id}" class="form-textarea" rows="3">${escapeHtml(r.notes || '')}</textarea></div>
                                        <div><label class="form-label">Message to Customer</label>
                                            <textarea id="ret-detail-message-${id}" class="form-textarea" rows="3" placeholder="Optional support note">${escapeHtml(r.customerMessage || '')}</textarea></div>
                                        <div><label class="form-label">Internal Notes</label>
                                            <textarea id="ret-detail-internal-${id}" class="form-textarea" rows="3" placeholder="Private team notes">${escapeHtml(r.internalNotes || '')}</textarea></div>
                                        <div><label class="form-label">Inspection Notes</label>
                                            <textarea id="ret-detail-inspection-${id}" class="form-textarea" rows="3" placeholder="Condition, tags, photos, restock">${escapeHtml(r.inspectionNotes || '')}</textarea></div>
                                    </div>
                                    <div style="display:flex;gap:8px;margin-top:1rem;flex-wrap:wrap;">
                                        <button class="btn btn-primary btn-sm" onclick="saveReturnDetails('${id}', this)">Save Details</button>
                                        <button class="btn btn-secondary btn-sm" onclick="loadReturnsPage()">Reload</button>
                                    </div>
                                </div>

                                <!-- Right: customer info + label -->
                                <div style="display:grid;gap:.8rem;align-content:start;">

                                    <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:1rem;">
                                        <div style="font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--text-secondary);margin-bottom:.6rem;">Customer</div>
                                        <div style="font-weight:600;">${escapeHtml(r.customerName || 'Customer')}</div>
                                        <div style="color:var(--text-secondary);font-size:.8rem;margin-top:2px;">${escapeHtml(r.customerEmail || '-')}</div>
                                        <div style="color:var(--text-secondary);font-size:.8rem;margin-top:10px;line-height:1.6;">
                                            ${escapeHtml(a.name || '')}${a.name ? '<br>' : ''}
                                            ${escapeHtml(a.line1 || '')}${a.line2 ? ', ' + escapeHtml(a.line2) : ''}${a.line1 ? '<br>' : ''}
                                            ${escapeHtml([a.city, a.state, a.zip].filter(Boolean).join(' '))}${a.city ? '<br>' : ''}
                                            ${escapeHtml(a.country || '')}
                                        </div>
                                        ${retAddressMissing(r) ? '<div style="margin-top:8px;color:#f97316;font-size:.75rem;">⚠ Shipping address incomplete — label generation may fail.</div>' : ''}
                                    </div>

                                    <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:1rem;">
                                        <div style="font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--text-secondary);margin-bottom:.6rem;">Label / Tracking</div>
                                        <div style="font-size:.85rem;line-height:1.65;">${labelLinks}</div>
                                        ${r.carrier || r.service ? `<div style="color:var(--text-secondary);font-size:.78rem;margin-top:6px;">${escapeHtml([r.carrier, r.service].filter(Boolean).join(' — '))}</div>` : ''}
                                        ${r.trackingNumber ? `<div style="font-family:monospace;font-size:.78rem;margin-top:3px;">${escapeHtml(r.trackingNumber)}</div>` : ''}
                                        ${labelErrorHtml}
                                        <div style="margin-top:1rem;border-top:1px solid var(--border);padding-top:.85rem;">
                                            <div style="font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--text-secondary);margin-bottom:.6rem;">Manual Label</div>
                                            <label class="form-label">Label PDF URL</label>
                                            <input id="ret-detail-label-url-${id}" class="form-input" value="${retAttr(r.labelUrl || '')}" placeholder="https://...label.pdf">
                                            <label class="form-label" style="margin-top:.6rem;">Tracking Number</label>
                                            <input id="ret-detail-tracking-${id}" class="form-input" value="${retAttr(r.trackingNumber || '')}" placeholder="9400...">
                                            <div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-top:.6rem;">
                                                <div><label class="form-label">Carrier</label>
                                                    <input id="ret-detail-carrier-${id}" class="form-input" value="${retAttr(r.carrier || '')}" placeholder="USPS"></div>
                                                <div><label class="form-label">Service</label>
                                                    <input id="ret-detail-service-${id}" class="form-input" value="${retAttr(r.service || '')}" placeholder="Ground Advantage"></div>
                                            </div>
                                            <label class="form-label" style="margin-top:.6rem;">Tracking URL</label>
                                            <input id="ret-detail-tracking-url-${id}" class="form-input" value="${retAttr(r.trackingUrl || '')}" placeholder="https://...">
                                            <button class="btn btn-secondary btn-sm" style="margin-top:.75rem;" onclick="saveManualReturnLabel('${id}', this)">Save Manual Label</button>
                                        </div>
                                    </div>

                                    <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:1rem;">
                                        <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.6rem;">
                                            <div style="font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--text-secondary);">Items Being Returned</div>
                                            ${isPartial ? `<span style="font-size:.68rem;padding:.15rem .45rem;border-radius:4px;background:rgba(251,191,36,.15);color:#fbbf24;border:1px solid rgba(251,191,36,.3);">Partial return</span>` : ''}
                                        </div>
                                        ${returnItemsHtml}
                                        ${orderItemsHtml}
                                    </div>
                                </div>
                            </div>`;
                    }

                    async function persistReturnUpdate(requestId, updates) {
                        const req = _returnsData.find(r => r.id === requestId);
                        if (!req) throw new Error('Return request not found.');
                        const { data: { session } } = await sb.auth.getSession();
                        const token = session?.access_token;
                        if (!token) throw new Error('Missing admin session token.');
                        const patch = {
                            action:          'update_return',
                            returnId:        requestId,
                            status:          updates.status          ?? req.status          ?? 'requested',
                            resolution:      updates.resolution      ?? req.resolution      ?? 'return',
                            reason:          updates.reason          ?? req.reason          ?? '',
                            notes:           updates.notes           ?? req.notes           ?? '',
                            internalNotes:   updates.internalNotes   ?? req.internalNotes   ?? '',
                            customerMessage: updates.customerMessage ?? req.customerMessage ?? '',
                            exchangeSku:     updates.exchangeSku     ?? req.exchangeSku     ?? '',
                            inspectionNotes: updates.inspectionNotes ?? req.inspectionNotes ?? '',
                            labelUrl:        updates.labelUrl        ?? req.labelUrl        ?? '',
                            trackingNumber:  updates.trackingNumber  ?? req.trackingNumber  ?? '',
                            trackingUrl:     updates.trackingUrl     ?? req.trackingUrl     ?? '',
                            carrier:         updates.carrier         ?? req.carrier         ?? '',
                            service:         updates.service         ?? req.service         ?? '',
                            labelSentAt:     updates.labelSentAt     ?? req.labelSentAt     ?? '',
                            clearLabelError: updates.clearLabelError || false,
                        };
                        const resp = await fetch('/api/admin-returns', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                            body: JSON.stringify(patch),
                        });
                        const payload = await resp.json().catch(() => ({}));
                        if (!resp.ok || !payload.success) throw new Error(payload.error || 'Could not update return.');
                        Object.assign(req, payload.request || {});
                        syncReturnsUI();
                        return req;
                    }

                    async function quickReturnStatus(requestId, status) {
                        if (status === 'denied' && !confirm('Mark this return as denied? The customer will be notified.')) return;
                        if (status === 'refunded') {
                            const req = _returnsData.find(r => r.id === requestId);
                            if (req && !retCanRefund(req)) {
                                notifyReturns('Cannot mark refunded — the item has not been received yet. Mark "Item Received" first.', 'error');
                                return;
                            }
                        }
                        try { await persistReturnUpdate(requestId, { status }); notifyReturns('Return marked ' + status.replace(/_/g, ' ') + '.', 'success'); }
                        catch (e) { notifyReturns('Could not update return: ' + e.message, 'error'); }
                    }
                    function quickMarkRefunded(requestId) {
                        const req = _returnsData.find(r => r.id === requestId);
                        /* The modal will not open on a settled order at all.
                           Disabling the button is not enough on its own — this
                           function is reachable from two buttons and from the
                           console, and the whole complaint was being walked to
                           the end before anything said no. */
                        if (!req || !retCanRefund(req)) {
                            notifyReturns(req && retOrderSettled(req)
                                ? 'This order has already been refunded — there is nothing left to refund.'
                                : 'Cannot mark refunded — the item has not been received yet. Mark "Item Received" first.', 'error');
                            return;
                        }
                        const totalStr = retMoney(req.orderTotal || 0);
                        const modal = document.createElement('div');
                        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9999;display:flex;align-items:center;justify-content:center;padding:1rem;';
                        modal.innerHTML = `
                          <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:12px;padding:1.5rem;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.5);">
                            <h3 style="margin:0 0 .25rem;font-size:1rem;">Issue Stripe Refund</h3>
                            <div style="color:var(--text-secondary);font-size:.8rem;margin-bottom:1rem;">${escapeHtml(req.customerName || req.customerEmail || '')} · ${totalStr}</div>
                            <div style="display:grid;gap:.75rem;">
                              <div>
                                <label style="font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary);display:block;margin-bottom:.3rem;">Partial Amount (leave blank for full refund)</label>
                                <input id="retrefmod-amount" type="number" min="0" step="0.01" placeholder="${req.orderTotal || ''}" style="width:100%;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:.5rem .75rem;color:var(--text-primary);font-size:.85rem;box-sizing:border-box;">
                              </div>
                              <div>
                                <label style="font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary);display:block;margin-bottom:.3rem;">Reason</label>
                                <select id="retrefmod-reason" style="width:100%;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:.5rem .75rem;color:var(--text-primary);font-size:.85rem;box-sizing:border-box;">
                                  <option value="requested_by_customer">Requested by customer</option>
                                  <option value="duplicate">Duplicate charge</option>
                                  <option value="fraudulent">Fraudulent</option>
                                </select>
                              </div>
                              <div>
                                <label style="font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary);display:block;margin-bottom:.3rem;">Customer Note (optional)</label>
                                <textarea id="retrefmod-note" rows="2" placeholder="Message to include in refund notification…" style="width:100%;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:.5rem .75rem;color:var(--text-primary);font-size:.85rem;box-sizing:border-box;resize:vertical;"></textarea>
                              </div>
                              <div>
                                <label style="font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary);display:block;margin-bottom:.3rem;">Refund Auth Code</label>
                                <input id="retrefmod-key" type="password" placeholder="Enter REFUND_SECRET" style="width:100%;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:.5rem .75rem;color:var(--text-primary);font-size:.85rem;box-sizing:border-box;">
                              </div>
                              <div id="retrefmod-err" style="display:none;color:#ef4444;font-size:.8rem;"></div>
                              <div style="display:flex;gap:.5rem;justify-content:flex-end;">
                                <button id="retrefmod-cancel" style="background:transparent;border:1px solid var(--border);color:var(--text-primary);padding:.5rem 1rem;border-radius:6px;font-size:.85rem;cursor:pointer;">Cancel</button>
                                <button id="retrefmod-submit" style="background:#ef4444;border:none;color:#fff;padding:.5rem 1.25rem;border-radius:6px;font-size:.85rem;font-weight:600;cursor:pointer;">Refund</button>
                              </div>
                            </div>
                          </div>`;
                        document.body.appendChild(modal);
                        modal.querySelector('#rst-all')?.addEventListener('click', () => {
                            modal.querySelectorAll('input[id^="rst-chk-"]').forEach((c) => { c.checked = true; });
                        });
                        modal.querySelector('#retrefmod-cancel').onclick = () => modal.remove();
                        modal.onclick = e => { if (e.target === modal) modal.remove(); };
                        modal.querySelector('#retrefmod-submit').onclick = async function() {
                            const btn = this;
                            const errEl = modal.querySelector('#retrefmod-err');
                            const amtVal = modal.querySelector('#retrefmod-amount').value.trim();
                            const reason = modal.querySelector('#retrefmod-reason').value;
                            const note = modal.querySelector('#retrefmod-note').value.trim();
                            const refundKey = modal.querySelector('#retrefmod-key').value.trim();
                            if (!refundKey) { errEl.textContent = 'Auth code is required.'; errEl.style.display = ''; return; }
                            // Validate partial-refund amount: must be > 0 and not exceed the order total
                            if (amtVal) {
                                const amtNum = parseFloat(amtVal);
                                const orderMax = Number(req.orderTotal) || 0;
                                if (isNaN(amtNum) || amtNum <= 0) { errEl.textContent = 'Refund amount must be greater than $0.'; errEl.style.display = ''; return; }
                                if (orderMax > 0 && amtNum > orderMax + 0.001) { errEl.textContent = 'Refund amount cannot exceed the order total of ' + retMoney(orderMax) + '.'; errEl.style.display = ''; return; }
                            }
                            btn.disabled = true; btn.textContent = 'Processing…';
                            errEl.style.display = 'none';
                            try {
                                const { data: { session } } = await sb.auth.getSession();
                                const token = session?.access_token;
                                if (!token) throw new Error('Missing admin session.');
                                const body = { action: 'refund', orderId: req.orderId, refundKey, accessToken: token, reason };
                                if (amtVal) body.amountCents = Math.round(parseFloat(amtVal) * 100);
                                if (note) body.customerNote = note;
                                const resp = await fetch('/api/admin-refund', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                                const data = await resp.json().catch(() => ({}));
                                /* This modal is the OTHER refund path. The Ask
                                   button went into the Receipts one only, so a
                                   limit refusing here was a dead end — which is
                                   most refunds, since a return that has come
                                   back is refunded from this workspace. */
                                if (!resp.ok && typeof window.zwRefundRefusal === 'function'
                                    && window.zwRefundRefusal(errEl, data, {
                                        token, orderId: req.orderId, note,
                                        amount: body.amountCents != null ? body.amountCents / 100 : null,
                                        onClose: () => modal.remove(),
                                    })) {
                                    btn.disabled = false; btn.textContent = 'Refund';
                                    return;
                                }
                                if (!resp.ok || !data.success) throw new Error(data.error || 'Refund failed.');
                                await persistReturnUpdate(requestId, { status: 'refunded' });
                                await logAdminAudit('return.stripe_refund', 'return_requests', requestId, { reason, amountCents: body.amountCents || null, stripeRefundId: data.stripeRefundId });
                                modal.remove();
                                notifyReturns('Refund issued successfully.', 'success');
                                await loadReturnsPage();
                                /* The item is back and paid for; the stock it
                                   came from is still down. Nothing linked those
                                   two, so a returned item stayed unsellable
                                   until somebody remembered a button — the
                                   exact inverse of the sold-out problem this
                                   whole session started with.
                                   Offered rather than done: a returned item is
                                   not always fit to sell again, and only the
                                   person holding it knows. The picker already
                                   takes each item and a quantity, so none, one
                                   or all of them is a choice made here. */
                                if (typeof window.openRestockModal === 'function') {
                                    window.openRestockModal(requestId);
                                }
                            } catch (e) {
                                errEl.textContent = e.message;
                                errEl.style.display = '';
                                btn.disabled = false; btn.textContent = 'Refund';
                            }
                        };
                    }
                    window.openRestockModal = function(requestId) {
                        const req = _returnsData.find(r => r.id === requestId);
                        if (!req) return;
                        const items = (Array.isArray(req.returnItems) && req.returnItems.length ? req.returnItems : (req.orderItems || []));
                        const modal = document.createElement('div');
                        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9999;display:flex;align-items:center;justify-content:center;padding:1rem;';
                        const itemRows = items.map((item, i) => {
                            const name = escapeHtml(item.name || item.title || item.product_title || 'Item');
                            const sku = escapeHtml(item.sku || '');
                            const size = escapeHtml(item.size || '');
                            const color = escapeHtml(item.color || item.colorName || '');
                            const qty = item.quantity || item.qty || 1;
                            const meta = [sku, size, color].filter(Boolean).join(' / ');
                            return `<div style="display:flex;align-items:center;gap:.75rem;padding:.6rem 0;border-bottom:1px solid var(--border);">
                              <input type="checkbox" id="rst-chk-${i}" style="width:16px;height:16px;flex-shrink:0;accent-color:#34d399;">
                              <div style="flex:1;min-width:0;">
                                <div style="font-weight:600;font-size:.85rem;">${name}</div>
                                <div style="color:var(--text-secondary);font-size:.75rem;">${meta}</div>
                              </div>
                              <input id="rst-qty-${i}" type="number" min="1" max="${qty}" value="${qty}" style="width:56px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:.35rem .5rem;color:var(--text-primary);font-size:.85rem;text-align:center;">
                              <input type="hidden" id="rst-sku-${i}" value="${escapeAttr(item.sku || '')}">
                              <input type="hidden" id="rst-size-${i}" value="${escapeAttr(item.size || '')}">
                              <input type="hidden" id="rst-color-${i}" value="${escapeAttr(item.color || item.colorName || '')}">
                            </div>`;
                        }).join('');
                        modal.innerHTML = `
                          <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:12px;padding:1.5rem;max-width:460px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.5);">
                            <h3 style="margin:0 0 .2rem;font-size:1rem;">Restock Returned Items</h3>
                            <!-- Nothing is ticked to begin with. This used to default to
                                 restocking everything, which was defensible while somebody
                                 had to go and find the button — it now opens by itself after
                                 every refund, and "this came back fit to sell" is a claim
                                 about physical goods that only the person holding them can
                                 make. Damaged stock quietly going back on sale is worse than
                                 one more click. -->
                            <div style="color:var(--text-secondary);font-size:.78rem;margin-bottom:.5rem;">Tick what came back in sellable condition, and how many. Anything left unticked stays out of stock.</div>
                            <button type="button" id="rst-all" style="background:none;border:0;color:#34d399;font-size:.78rem;cursor:pointer;padding:0;margin-bottom:.75rem;">Select all</button>
                            <div style="max-height:280px;overflow-y:auto;">${itemRows || '<p style="color:var(--text-secondary);font-size:.83rem;">No item data available.</p>'}</div>
                            <div id="rst-err" style="display:none;color:#ef4444;font-size:.8rem;margin-top:.75rem;"></div>
                            <div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:1rem;">
                              <button id="rst-cancel" style="background:transparent;border:1px solid var(--border);color:var(--text-primary);padding:.5rem 1rem;border-radius:6px;font-size:.85rem;cursor:pointer;">Cancel</button>
                              <button id="rst-submit" style="background:#34d399;border:none;color:#09090b;padding:.5rem 1.25rem;border-radius:6px;font-size:.85rem;font-weight:700;cursor:pointer;">+ Restock</button>
                            </div>
                          </div>`;
                        document.body.appendChild(modal);
                        modal.querySelector('#rst-cancel').onclick = () => modal.remove();
                        modal.onclick = e => { if (e.target === modal) modal.remove(); };
                        modal.querySelector('#rst-submit').onclick = async function() {
                            const btn = this;
                            const errEl = modal.querySelector('#rst-err');
                            btn.disabled = true; btn.textContent = 'Restocking…';
                            errEl.style.display = 'none';
                            try {
                                const ops = [];
                                for (let i = 0; i < items.length; i++) {
                                    const chk = modal.querySelector('#rst-chk-' + i);
                                    if (!chk?.checked) continue;
                                    const qty = parseInt(modal.querySelector('#rst-qty-' + i)?.value || '1', 10) || 1;
                                    const sku = modal.querySelector('#rst-sku-' + i)?.value?.trim() || '';
                                    const size = modal.querySelector('#rst-size-' + i)?.value?.trim() || '';
                                    const color = modal.querySelector('#rst-color-' + i)?.value?.trim() || '';
                                    if (!sku) continue;
                                    ops.push({ sku, size, color, qty });
                                }
                                if (!ops.length) { errEl.textContent = 'No items selected.'; errEl.style.display = ''; btn.disabled = false; btn.textContent = '+ Restock'; return; }
                                for (const op of ops) {
                                    const { data: prods } = await sb.from('products').select('id').eq('sku', op.sku).limit(1);
                                    const productId = prods?.[0]?.id;
                                    if (!productId) { errEl.textContent = 'Product not found for SKU: ' + op.sku; errEl.style.display = ''; btn.disabled = false; btn.textContent = '+ Restock'; return; }

                                    /* The RPC, not a lookup written here.
                                       This used to do .eq('size',…).eq('color_name',…) — exact,
                                       case- and whitespace-sensitive, with no size folding and no
                                       fallback for colour-agnostic rows. That is precisely the
                                       matching migration 0007 removed from the SELL side, so a
                                       garment stored as "cyan" was unreachable from a return
                                       saying "Cyan", and this screen refused to restock an item it
                                       had happily sold and decremented.
                                       restock_stock() and decrement_stock() now share
                                       zw_find_size_row(), so the row stock leaves is the row it
                                       comes back to, by construction rather than by both sides
                                       being maintained in step. */
                                    const { data: changed, error: rpcErr } = await sb.rpc('restock_stock', {
                                        p_product_id: productId,
                                        p_size: op.size || null,
                                        p_qty: op.qty,
                                        p_color_name: op.color || null,
                                    });
                                    if (rpcErr) throw rpcErr;
                                    /* 0 rows changed means nothing in the catalogue describes what
                                       came back. Reporting success there would tell the shop it
                                       had restocked something it had not, and the garment would
                                       sit on the shelf reading as sold out for ever. */
                                    if (!Number(changed)) {
                                        errEl.textContent = 'Nothing in the catalogue matches '
                                            + op.sku + (op.size ? ' / ' + op.size : '')
                                            + (op.color ? ' / ' + op.color : '')
                                            + ' — check the size and colour still exist on this product.';
                                        errEl.style.display = ''; btn.disabled = false; btn.textContent = '+ Restock'; return;
                                    }
                                }
                                await logAdminAudit('return.restock', 'return_requests', requestId, { ops });
                                modal.remove();
                                notifyReturns('Items restocked successfully.', 'success');
                            } catch (e) {
                                errEl.textContent = e.message;
                                errEl.style.display = '';
                                btn.disabled = false; btn.textContent = '+ Restock';
                            }
                        };
                    };
                    async function saveReturnDetails(requestId, buttonEl) {
                        /* Second guard. The dropdown no longer offers it, but
                           this function is reachable from a console and from
                           the Save Details button, and "money moved" is not a
                           claim a text field should be able to make. */
                        if (retField(`ret-detail-status-${requestId}`) === 'refunded') {
                            const req = _returnsData.find(r => r.id === requestId);
                            if (!req || req.status !== 'refunded') {
                                notifyReturns('Use "Mark refunded" to issue the refund — that is what moves the money, '
                                    + 'updates the order and emails the customer.', 'error');
                                loadReturnsPage();
                                return;
                            }
                        }
                        const oldText = buttonEl?.textContent || '';
                        if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = 'Saving...'; }
                        try {
                            await persistReturnUpdate(requestId, {
                                status:          retField(`ret-detail-status-${requestId}`),
                                resolution:      retField(`ret-detail-resolution-${requestId}`),
                                reason:          retField(`ret-detail-reason-${requestId}`),
                                notes:           retField(`ret-detail-notes-${requestId}`),
                                customerMessage: retField(`ret-detail-message-${requestId}`),
                                internalNotes:   retField(`ret-detail-internal-${requestId}`),
                                inspectionNotes: retField(`ret-detail-inspection-${requestId}`),
                                exchangeSku:     retField(`ret-detail-exchange-${requestId}`),
                            });
                            /* Named, not just "saved". The dropdowns commit on
                               change now, so this fires without anybody having
                               pressed a thing — a bare "saved" beside a control
                               you may have brushed past says nothing about what
                               moved. */
                            notifyReturns('Saved — ' + retField(`ret-detail-status-${requestId}`).replace(/_/g, ' ')
                                + ' · ' + retField(`ret-detail-resolution-${requestId}`).replace(/_/g, ' '), 'success');
                        } catch (e) {
                            notifyReturns('Could not save return: ' + e.message, 'error');
                        } finally {
                            if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = oldText || 'Save Return Details'; }
                        }
                    }
                    async function saveManualReturnLabel(requestId, buttonEl) {
                        const req = _returnsData.find(r => r.id === requestId);
                        if (!req) return;
                        const oldText = buttonEl?.textContent || '';
                        if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = 'Saving...'; }
                        const labelUrl = retField(`ret-detail-label-url-${requestId}`).trim();
                        const trackingNumber = retField(`ret-detail-tracking-${requestId}`).trim();
                        const trackingUrl = retField(`ret-detail-tracking-url-${requestId}`).trim();
                        const carrier = retField(`ret-detail-carrier-${requestId}`).trim();
                        const service = retField(`ret-detail-service-${requestId}`).trim();
                        if (!labelUrl && !trackingNumber) {
                            notifyReturns('Add a label URL or tracking number before saving a manual label.', 'error');
                            if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = oldText || 'Save Manual Label'; }
                            return;
                        }
                        try {
                            if (req.status === 'requested') {
                                if (buttonEl) buttonEl.textContent = 'Approving...';
                                await persistReturnUpdate(requestId, { status: 'approved' });
                            }
                            if (buttonEl) buttonEl.textContent = 'Saving & emailing...';
                            const { data: { session } } = await sb.auth.getSession();
                            const token = session?.access_token;
                            if (!token) throw new Error('Missing admin session token.');
                            const resp = await fetch('/api/generate-return-label', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                                body: JSON.stringify({
                                    returnId: requestId,
                                    orderId: req.orderId,
                                    force: 'true',
                                    manualLabel: { labelUrl, trackingNumber, trackingUrl, carrier, service },
                                }),
                            });
                            const payload = await resp.json().catch(() => ({}));
                            if (!resp.ok || !payload.ok) throw new Error(payload.error || 'Could not save manual label.');
                            Object.assign(req, {
                                status: 'label_sent',
                                labelUrl,
                                trackingNumber,
                                trackingUrl,
                                carrier,
                                service,
                                labelSentAt: new Date().toISOString(),
                            });
                            syncReturnsUI();
                            notifyReturns('Manual label saved and email sent to customer.', 'success');
                        } catch (e) {
                            notifyReturns('Could not save manual label: ' + e.message, 'error');
                        } finally {
                            if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = oldText || 'Save Manual Label'; }
                        }
                    }
                    /* sendReturnStatusEmail — fires a status-update email to the customer.
                       Works at any status stage. The server picks the right copy automatically
                       and includes the admin's "Message to Customer" field if set. */
                    window.sendReturnStatusEmail = async function(requestId, buttonEl) {
                        const req = _returnsData.find(r => r.id === requestId);
                        if (!req) return;
                        const oldText = buttonEl ? buttonEl.textContent : '';
                        if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = 'Sending…'; }
                        try {
                            const { data: { session } } = await sb.auth.getSession();
                            const token = session?.access_token;
                            if (!token) throw new Error('Missing admin session token.');
                            const resp = await fetch('/api/send-return-status-email', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                                body: JSON.stringify({ returnId: requestId }),
                            });
                            const payload = await resp.json().catch(() => ({}));
                            if (!resp.ok || !payload.ok) throw new Error(payload.error || 'Could not send status email.');
                            notifyReturns(`Status email sent to ${payload.sentTo} via ${payload.provider}.`, 'success');
                        } catch(e) {
                            notifyReturns('Email failed: ' + e.message, 'error');
                        } finally {
                            if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = oldText || '✉ Email Update'; }
                        }
                    };

                    /* sendReturnLabel — calls /api/generate-return-label (Shippo integration).
                       Approve the return first, then attempt to buy a prepaid label.
                       If Shippo is not yet configured, the endpoint returns a 404/500 and
                       the admin falls back to saving a manual label in the detail panel. */
                    window.sendReturnLabel = async function(requestId, buttonEl) {
                        const req = _returnsData.find(r => r.id === requestId);
                        if (!req) return;
                        const oldText = buttonEl ? buttonEl.textContent : '';
                        if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = 'Sending...'; }
                        try {
                            if (req.status === 'requested') {
                                if (buttonEl) buttonEl.textContent = 'Approving...';
                                await persistReturnUpdate(requestId, { status: 'approved' });
                            }
                            if (buttonEl) buttonEl.textContent = 'Generating label...';
                            const { data: { session } } = await sb.auth.getSession();
                            const token = session?.access_token;
                            if (!token) throw new Error('Missing admin session token.');
                            const resp = await fetch('/api/generate-return-label', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                                body: JSON.stringify({ returnId: requestId, orderId: req.orderId, force: req.labelUrl ? 'true' : 'false' }),
                            });
                            if (resp.status === 404) {
                                throw new Error('Shippo label generation is not configured yet. Use the Manual Label section to paste in an external label URL.');
                            }
                            const payload = await resp.json().catch(() => ({}));
                            if (!resp.ok || !payload.ok) {
                                const shippoErr = new Error(payload.error || 'Could not generate return label.');
                                shippoErr.payload = payload;
                                throw shippoErr;
                            }
                            Object.assign(req, {
                                status: 'label_sent',
                                labelUrl: payload.labelUrl,
                                trackingNumber: payload.trackingNumber,
                                trackingUrl: payload.trackingUrl,
                                carrier: payload.carrier,
                                service: payload.service,
                                labelSentAt: new Date().toISOString(),
                                lastLabelError: '',
                            });
                            syncReturnsUI();
                            notifyReturns('Return label generated and sent to customer.', 'success');
                        } catch(e) {
                            if (e.payload?.request) Object.assign(req, e.payload.request);
                            else Object.assign(req, { lastLabelError: e.message });
                            syncReturnsUI();
                            const hint = ' Use the Manual Label section in the detail panel to paste an external label URL.';
                            notifyReturns(e.message + hint, 'error');
                            if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = oldText || 'Send Label'; }
                        }
                    };

                    /* ── Return window ──────────────────────────────────────
                       The rule has been live and inert. returnEligibility()
                       enforces a window, the refusal message is editable, both
                       callers pass returnWindowFrom(config), and 157 lines of
                       tests cover the date cases — but returnWindowFrom()
                       defaults windowDays to 0 (no limit) and there was nowhere
                       to type a number. So every confirmation email promised
                       30-day returns while an order from three years ago was
                       still returnable.

                       Stored at commerce_config.returns, which is what
                       returnWindowFrom() reads. Read-modify-write on the blob
                       like the rest of the admin: this touches two integers and
                       carries everything else through untouched. */
                    window.loadReturnWindowCard = async function () {
                        const sum = document.getElementById('ret-window-summary');
                        const days = document.getElementById('ret-window-days');
                        const transit = document.getElementById('ret-window-transit');
                        if (!sum || !days) return;
                        try {
                            const { data: rows } = await sb.from('site_settings')
                                .select('value').eq('key', 'commerce_config').limit(1);
                            const cfg = (rows && rows[0] && rows[0].value) || {};
                            const r = (cfg.returns && typeof cfg.returns === 'object') ? cfg.returns : {};
                            const d = Math.floor(Number(r.windowDays));
                            const t = Math.floor(Number(r.transitAllowanceDays));
                            days.value = Number.isFinite(d) && d > 0 ? d : '';
                            transit.value = Number.isFinite(t) && t >= 0 ? t : '';
                            /* The summary says what the store DOES, not what is
                               configured — "no limit" is the honest description
                               of a blank field, and it is the state that has
                               been quietly true all along. */
                            sum.innerHTML = (Number.isFinite(d) && d > 0)
                                ? 'Returns close <b>' + d + ' days</b> after delivery.'
                                : '<span style="color:var(--warning);">No limit — every order is returnable for ever.</span>';
                        } catch (e) {
                            sum.textContent = 'Could not load the return window.';
                            console.warn('loadReturnWindowCard:', e && e.message);
                        }
                    };

                    window.saveReturnWindow = async function () {
                        const msg = document.getElementById('ret-window-msg');
                        const daysEl = document.getElementById('ret-window-days');
                        const transitEl = document.getElementById('ret-window-transit');
                        const say = (text, colour) => { if (msg) { msg.style.color = colour; msg.textContent = text; } };

                        const rawDays = String(daysEl.value || '').trim();
                        const rawTransit = String(transitEl.value || '').trim();
                        const d = rawDays === '' ? 0 : Math.floor(Number(rawDays));
                        const t = rawTransit === '' ? 7 : Math.floor(Number(rawTransit));

                        /* Refuse nonsense here rather than let returnWindowFrom
                           silently clamp it — a shop owner who types 400 and is
                           quietly given 3650 has been lied to about their own
                           policy. */
                        if (!Number.isFinite(d) || d < 0 || d > 3650) { say('Days to return must be between 0 and 3650.', 'var(--error)'); return; }
                        if (!Number.isFinite(t) || t < 0 || t > 60) { say('Delivery allowance must be between 0 and 60 days.', 'var(--error)'); return; }

                        say('Saving…', 'var(--text-secondary)');
                        try {
                            const { data: rows, error } = await sb.from('site_settings')
                                .select('value').eq('key', 'commerce_config').limit(1);
                            if (error) throw error;
                            const cfg = (rows && rows[0] && rows[0].value) || {};
                            cfg.returns = Object.assign({}, cfg.returns, {
                                windowDays: d,
                                transitAllowanceDays: t,
                            });
                            const { error: sErr } = await sb.from('site_settings')
                                .upsert({ key: 'commerce_config', value: cfg }, { onConflict: 'key' });
                            if (sErr) throw sErr;
                            say(d > 0
                                ? '✓ Saved. Returns now close ' + d + ' days after delivery.'
                                : '✓ Saved. No time limit on returns.', 'var(--success)');
                            loadReturnWindowCard();
                            setTimeout(() => say('', ''), 4000);
                        } catch (e) {
                            say('✗ ' + (e.message || 'Could not save'), 'var(--error)');
                        }
                    };
