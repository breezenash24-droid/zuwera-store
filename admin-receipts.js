                  (function() {
                    let _recLoaded = false;
                    let _recListenersAttached = false;
                    let _allReceipts = [];
                    let _filteredReceipts = [];
                    // Export current (filtered) orders to CSV. Defined here so it can
                    // read the receipts-scoped arrays; uses the global zwExportCSV.
                    window.exportOrdersCSV = function() {
                      const rows = (_filteredReceipts && _filteredReceipts.length ? _filteredReceipts : _allReceipts) || [];
                      window.zwExportCSV('orders-{date}.csv', rows, [
                        { label: 'Order', get: o => String(o.stripe_payment_intent_id || o.id || '').slice(-8).toUpperCase() },
                        { label: 'Date', get: o => (o.created_at || '').slice(0, 10) },
                        { label: 'Customer', get: o => o.customer_name || '' },
                        { label: 'Email', get: o => o.email || '' },
                        { label: 'Total', get: o => Number(o.total || 0).toFixed(2) },
                        { label: 'Status', get: o => o.status || '' },
                        { label: 'Tracking', get: o => o.tracking_number || '' }
                      ]);
                    };

                    function recErr(msg) {
                      const el = sectionEl('rec-error');
                      el.textContent = msg;
                      el.style.display = 'block';
                    }
                    function sortReceipts(receipts, sortBy) {
                      const sorted = [...receipts];
                      if (sortBy === 'newest') {
                        sorted.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
                      } else if (sortBy === 'oldest') {
                        sorted.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
                      } else if (sortBy === 'highest') {
                        sorted.sort((a, b) => (b.total || 0) - (a.total || 0));
                      } else if (sortBy === 'lowest') {
                        sorted.sort((a, b) => (a.total || 0) - (b.total || 0));
                      }
                      return sorted;
                    }

                    function renderReceipts() {
                      const sortBy = sectionEl('rec-sort')?.value || 'newest';
                      const sorted = sortReceipts(_filteredReceipts, sortBy);
                      const container = sectionEl('rec-list-container');

                      if (sorted.length === 0) {
                        container.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:40px;font-size:13px;">No receipts found.</p>';
                        return;
                      }

                      container.innerHTML = sorted.map(order => {
                        const orderNum = (order.stripe_payment_intent_id || 'N/A').slice(-8).toUpperCase();
                        const items = (() => {
                          try {
                            return typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []);
                          } catch {
                            return [];
                          }
                        })();

                        const itemsHtml = items.length > 0 ? items.map(item => `
                          <div style="display:flex;gap:12px;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--border);">
                            ${safeHttpUrl(item.image) ? `<img src="${escapeAttr(safeHttpUrl(item.image))}" alt="${escapeAttr(item.name || 'Product image')}" style="width:60px;height:60px;border-radius:4px;object-fit:cover;">` : ''}
                            <div style="flex:1;">
                              <p style="font-weight:500;margin-bottom:4px;">${escapeHtml(item.name || 'Unknown Product')}</p>
                              <p style="color:var(--text-secondary);font-size:12px;">Qty: ${item.qty || 1} × ${fmt$(item.price || 0)}</p>
                            </div>
                          </div>
                        `).join('') : '<p style="color:var(--text-secondary);font-size:12px;">No items</p>';

                        const safeTrackingUrl = safeHttpUrl(order.tracking_url);
                        const trackingLink = safeTrackingUrl ? `<a href="${escapeAttr(safeTrackingUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);text-decoration:none;cursor:pointer;">Track Shipment</a>` : '—';

                        return `
                          <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;padding:24px;">
                            <!-- Header -->
                            <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:20px;padding-bottom:16px;border-bottom:2px solid var(--border);">
                              <div>
                                <p style="font-size:13px;color:var(--text-secondary);margin-bottom:4px;">ORDER #${orderNum}</p>
                                <p style="font-size:13px;color:var(--text-secondary);">${fmtDate(order.created_at)}</p>
                              </div>
                              <div style="text-align:right;">
                                <p style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary);margin-bottom:4px;">Status</p>
                                <span style="display:inline-block;padding:4px 10px;border-radius:4px;font-size:11px;font-weight:600;background:${order.status === 'refunded' ? '#ef4444' : order.status === 'completed' ? '#10b981' : '#f59e0b'};color:#fff;">${escapeHtml(order.status || 'unknown')}</span>
                              </div>
                            </div>

                            <!-- Customer Info -->
                            <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border);">
                              <p class="zw-eyebrow">Customer</p>
                              <p style="font-weight:500;margin-bottom:2px;">${escapeHtml(order.customer_name || 'N/A')}</p>
                              <p style="font-size:12px;color:var(--text-secondary);">${escapeHtml(order.email || 'N/A')}</p>
                            </div>

                            <!-- Items -->
                            <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border);">
                              <p style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary);margin-bottom:12px;">Items Ordered</p>
                              ${itemsHtml}
                            </div>

                            <!-- Order Summary -->
                            <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border);background:var(--bg-primary);padding:16px;border-radius:6px;">
                              <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                                <span style="color:var(--text-secondary);">Subtotal</span>
                                <span>${fmt$(order.subtotal || 0)}</span>
                              </div>
                              <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                                <span style="color:var(--text-secondary);">Shipping</span>
                                <span>${fmt$(order.shipping || 0)}</span>
                              </div>
                              <div style="display:flex;justify-content:space-between;margin-bottom:8px;border-bottom:1px solid var(--border);padding-bottom:8px;">
                                <span style="color:var(--text-secondary);">Tax</span>
                                <span>${fmt$(order.tax || 0)}</span>
                              </div>
                              <div style="display:flex;justify-content:space-between;font-weight:700;font-size:14px;">
                                <span>Total</span>
                                <span style="color:var(--accent);">${fmt$(order.total || 0)}</span>
                              </div>
                            </div>

                            <!-- Shipping Address -->
                            <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border);">
                              <p class="zw-eyebrow">Shipping Address</p>
                              <p style="font-size:12px;line-height:1.6;">
                                ${escapeHtml(order.ship_line1 || 'N/A')}${order.ship_line2 ? ', ' + escapeHtml(order.ship_line2) : ''}<br>
                                ${order.ship_city ? escapeHtml(order.ship_city) + ', ' : ''}${escapeHtml(order.ship_state || '')} ${escapeHtml(order.ship_zip || '')}<br>
                                ${escapeHtml(order.ship_country || '')}
                              </p>
                            </div>

                            <!-- Tracking -->
                            <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border);">
                              <p class="zw-eyebrow">Tracking Information</p>
                              <p style="font-size:12px;margin-bottom:4px;">
                                <strong>${escapeHtml(order.shipping_provider || 'N/A')}</strong>
                                ${order.shipping_service ? ' — ' + escapeHtml(order.shipping_service) : ''}
                              </p>
                              <p style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;">
                                ${escapeHtml(order.tracking_number || '—')}
                              </p>
                              ${trackingLink}
                            </div>

                            <!-- Action Button -->
                            ${order.status !== 'refunded' ? `<button onclick="window._recMarkRefunded('${escapeAttr(order.id)}')" style="background:var(--bg-primary);border:1px solid #ef4444;color:#ef4444;padding:8px 16px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;transition:all 0.2s;">Mark Refunded</button>` : '<p style="font-size:12px;color:var(--text-secondary);">This order has been refunded.</p>'}
                          </div>
                        `;
                      }).join('');
                    }

                    function updateStats() {
                      const allOrders = _allReceipts;
                      const total = allOrders.length;
                      const revenue = allOrders.reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0);
                      const avg = total > 0 ? revenue / total : 0;

                      sectionEl('rec-total-orders').textContent = total.toLocaleString();
                      sectionEl('rec-total-revenue').textContent = fmt$(revenue);
                      sectionEl('rec-avg-order').textContent = fmt$(avg);
                    }

                    function filterReceipts() {
                      const q = sectionEl('rec-search')?.value.toLowerCase() || '';
                      _filteredReceipts = q ? _allReceipts.filter(o => {
                        const customerName = (o.customer_name || '').toLowerCase();
                        const email        = (o.email || '').toLowerCase();
                        const orderNum     = (o.stripe_payment_intent_id || '').slice(-8).toLowerCase();
                        const amount       = fmt$(o.total || 0).toLowerCase();
                        const tracking     = (o.tracking_number || '').toLowerCase();
                        return customerName.includes(q) || email.includes(q) || orderNum.includes(q) || amount.includes(q) || tracking.includes(q);
                      }) : _allReceipts;
                      renderReceipts();
                    }

                    window._recMarkRefunded = function(orderId) {
                      const order = _allReceipts.find(o => o.id === orderId);
                      if (!order) return;
                      const totalStr = fmt$(order.total || 0);
                      const modal = document.createElement('div');
                      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:9999;display:flex;align-items:center;justify-content:center;padding:1rem;';
                      modal.innerHTML = `
                        <div style="background:var(--bg-primary);border:1px solid var(--border);border-radius:12px;padding:1.5rem;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.5);">
                          <h3 style="margin:0 0 .25rem;font-size:1rem;">Issue Stripe Refund</h3>
                          <div style="color:var(--text-secondary);font-size:.8rem;margin-bottom:1rem;">${escapeHtml(order.customer_name || order.email || '')} · ${totalStr}</div>
                          <div style="display:grid;gap:.75rem;">
                            <div>
                              <label style="font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary);display:block;margin-bottom:.3rem;">Partial Amount (leave blank for full refund)</label>
                              <input id="refmod-amount" type="number" min="0" step="0.01" placeholder="${order.total || ''}" style="width:100%;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:.5rem .75rem;color:var(--text-primary);font-size:.85rem;box-sizing:border-box;">
                            </div>
                            <div>
                              <label style="font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary);display:block;margin-bottom:.3rem;">Reason</label>
                              <select id="refmod-reason" style="width:100%;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:.5rem .75rem;color:var(--text-primary);font-size:.85rem;box-sizing:border-box;">
                                <option value="requested_by_customer">Requested by customer</option>
                                <option value="duplicate">Duplicate charge</option>
                                <option value="fraudulent">Fraudulent</option>
                              </select>
                            </div>
                            <div>
                              <label style="font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary);display:block;margin-bottom:.3rem;">Customer Note (optional)</label>
                              <textarea id="refmod-note" rows="2" placeholder="Message to include in refund notification…" style="width:100%;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:.5rem .75rem;color:var(--text-primary);font-size:.85rem;box-sizing:border-box;resize:vertical;"></textarea>
                            </div>
                            <div>
                              <label style="font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary);display:block;margin-bottom:.3rem;">Refund Auth Code</label>
                              <input id="refmod-key" type="password" placeholder="Enter REFUND_SECRET" style="width:100%;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:.5rem .75rem;color:var(--text-primary);font-size:.85rem;box-sizing:border-box;">
                            </div>
                            <div id="refmod-err" style="display:none;color:#ef4444;font-size:.8rem;"></div>
                            <div style="display:flex;gap:.5rem;justify-content:flex-end;">
                              <button id="refmod-cancel" style="background:transparent;border:1px solid var(--border);color:var(--text-primary);padding:.5rem 1rem;border-radius:6px;font-size:.85rem;cursor:pointer;">Cancel</button>
                              <button id="refmod-submit" style="background:#ef4444;border:none;color:#fff;padding:.5rem 1.25rem;border-radius:6px;font-size:.85rem;font-weight:600;cursor:pointer;">Refund</button>
                            </div>
                          </div>
                        </div>`;
                      document.body.appendChild(modal);
                      modal.querySelector('#refmod-cancel').onclick = () => modal.remove();
                      modal.onclick = e => { if (e.target === modal) modal.remove(); };
                      modal.querySelector('#refmod-submit').onclick = async function() {
                        const btn = this;
                        const errEl = modal.querySelector('#refmod-err');
                        const amtVal = modal.querySelector('#refmod-amount').value.trim();
                        const reason = modal.querySelector('#refmod-reason').value;
                        const note = modal.querySelector('#refmod-note').value.trim();
                        const refundKey = modal.querySelector('#refmod-key').value.trim();
                        if (!refundKey) { errEl.textContent = 'Auth code is required.'; errEl.style.display = ''; return; }
                        btn.disabled = true; btn.textContent = 'Processing…';
                        errEl.style.display = 'none';
                        try {
                          const { data: { session } } = await sb.auth.getSession();
                          const token = session?.access_token;
                          if (!token) throw new Error('Missing admin session.');
                          const body = { action: 'refund', orderId, refundKey, accessToken: token, reason };
                          if (amtVal) body.amountCents = Math.round(parseFloat(amtVal) * 100);
                          if (note) body.customerNote = note;
                          const resp = await fetch('/api/admin-refund', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                          const data = await resp.json().catch(() => ({}));
                          if (!resp.ok || !data.success) throw new Error(data.error || 'Refund failed.');
                          await logAdminAudit('order.stripe_refund', 'orders', orderId, { reason, amountCents: body.amountCents || null, stripeRefundId: data.stripeRefundId });
                          modal.remove();
                          _recLoaded = false;
                          window.receiptsLoadData();
                        } catch (e) {
                          errEl.textContent = e.message;
                          errEl.style.display = '';
                          btn.disabled = false; btn.textContent = 'Refund';
                        }
                      };
                    };

                    window.receiptsLoadData = async function() {
                      sectionEl('rec-error').style.display = 'none';

                      try {
                        const { data: orders, error } = await sb.from('orders')
                          .select('id,stripe_payment_intent_id,created_at,customer_name,email,items,subtotal,shipping,tax,total,free_shipping,status,ship_line1,ship_line2,ship_city,ship_state,ship_zip,ship_country,shipping_provider,shipping_service,tracking_number,tracking_url')
                          .order('created_at', { ascending: false });

                        if (error) throw error;

                        _allReceipts = orders || [];
                        _filteredReceipts = _allReceipts;

                        updateStats();
                        renderReceipts();

                        // Attach event listeners once — guard against re-registration on reload
                        if (!_recListenersAttached) {
                          _recListenersAttached = true;
                          sectionEl('rec-search').addEventListener('input', filterReceipts);
                          sectionEl('rec-sort').addEventListener('change', renderReceipts);
                        }

                      } catch (e) {
                        recErr('Failed to load receipts: ' + e.message);
                      }
                    };
                  })();
