                  (function() {
                    let _shipLoaded = false;
                    let _shipListenersAttached = false;
                    let _retShipListenerAttached = false;
                    let _shipOrders = [];
                    let _shipReturns = [];
                    let _shipPage = 1;
                    const PAGE_SIZE = 25;

                    function shipErr(msg) {
                      const el = sectionEl('ship-error');
                      el.textContent = msg;
                      el.style.display = 'block';
                    }
                    function shipRenderOrders(orders, page) {
                      const tbody = sectionEl('ship-orders-tbody');
                      const start = (page-1)*PAGE_SIZE;
                      const slice = orders.slice(start, start+PAGE_SIZE);
                      if (slice.length === 0) {
                        tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No orders found</td></tr>';
                      } else {
                        tbody.innerHTML = slice.map(o => {
                          const carrier = escapeHtml([o.shipping_provider, o.shipping_service].filter(Boolean).join(' — ') || '—');
                          const safeTrackingUrl = safeHttpUrl(o.tracking_url);
                          const trackingNumber = escapeHtml(o.tracking_number || '');
                          const trackCell = o.tracking_number
                            ? (safeTrackingUrl
                                ? `<a href="${escapeAttr(safeTrackingUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);text-decoration:none;">${trackingNumber}</a>`
                                : trackingNumber)
                            : '—';
                          return `<tr class="zw-divider">
                            <td style="padding:12px;">${fmtDate(o.created_at)}</td>
                            <td style="padding:12px;">${escapeHtml(o.customer_name || o.email || '—')}</td>
                            <td style="padding:12px;color:var(--text-secondary);">${carrier}</td>
                            <td style="padding:12px;">${trackCell}</td>
                            <td style="padding:12px;text-align:right;color:var(--accent);font-weight:600;">${fmt$(o.shipping)}</td>
                            <td style="padding:12px;text-align:right;">${fmt$(o.total)}</td>
                          </tr>`;
                        }).join('');
                      }

                      // Pagination
                      const pages = Math.ceil(orders.length / PAGE_SIZE);
                      const pag = sectionEl('ship-pagination');
                      if (pages <= 1) { pag.innerHTML = ''; return; }
                      pag.innerHTML = Array.from({length:pages},(_,i)=>i+1).map(p =>
                        `<button onclick="window._shipGoPage(${p})" style="padding:6px 12px;border:1px solid var(--border);border-radius:6px;background:${p===page?'var(--accent)':'var(--bg-primary)'};color:${p===page?'#09090b':'var(--text-primary)'};cursor:pointer;font-size:12px;">${p}</button>`
                      ).join('');
                    }

                    window._shipGoPage = function(p) {
                      _shipPage = p;
                      const q = sectionEl('ship-search')?.value.toLowerCase() || '';
                      const filtered = q ? _shipOrders.filter(o =>
                        (o.customer_name||'').toLowerCase().includes(q) ||
                        (o.email||'').toLowerCase().includes(q) ||
                        (o.shipping_provider||'').toLowerCase().includes(q) ||
                        (o.shipping_service||'').toLowerCase().includes(q) ||
                        (o.tracking_number||'').toLowerCase().includes(q)
                      ) : _shipOrders;
                      shipRenderOrders(filtered, p);
                    };

                    window.shipLoadData = async function() {
                      sectionEl('ship-error').style.display = 'none';
                      retShipLoad();

                      try {
                        const { data: orders, error } = await sb.from('orders')
                          .select('created_at,email,customer_name,shipping,total,shipping_provider,shipping_service,tracking_number,tracking_url,status')
                          .order('created_at', { ascending: false });
                        if (error) throw error;

                        const all = (orders || []);
                        _shipOrders = all;

                        // Aggregate
                        let totalShip = 0, withShip = 0, freeShip = 0;
                        all.forEach(o => {
                          const s = parseFloat(o.shipping || 0);
                          totalShip += s;
                          if (s > 0) withShip++;
                          else freeShip++;
                        });
                        const avg = withShip > 0 ? totalShip / withShip : 0;

                        sectionEl('ship-total').textContent = fmt$(totalShip);
                        sectionEl('ship-count').textContent = withShip.toLocaleString();
                        sectionEl('ship-avg').textContent = fmt$(avg);
                        sectionEl('ship-free').textContent = freeShip.toLocaleString();

                        // Carrier breakdown
                        const carrierMap = {};
                        all.forEach(o => {
                          const key = [o.shipping_provider, o.shipping_service].filter(Boolean).join(' — ') || 'Unknown';
                          if (!carrierMap[key]) carrierMap[key] = { count: 0, total: 0 };
                          carrierMap[key].count++;
                          carrierMap[key].total += parseFloat(o.shipping || 0);
                        });
                        const carriers = Object.entries(carrierMap).sort((a,b) => b[1].total - a[1].total);
                        const ctbody = sectionEl('ship-carrier-tbody');
                        if (carriers.length === 0) {
                          ctbody.innerHTML = '<tr class="empty-row"><td colspan="4">No data</td></tr>';
                        } else {
                          ctbody.innerHTML = carriers.map(([name, d]) => `
                            <tr class="zw-divider">
                              <td style="padding:12px;">${escapeHtml(name)}</td>
                              <td style="padding:12px;text-align:right;">${d.count}</td>
                              <td style="padding:12px;text-align:right;color:var(--accent);font-weight:600;">${fmt$(d.total)}</td>
                              <td style="padding:12px;text-align:right;">${fmt$(d.count > 0 ? d.total/d.count : 0)}</td>
                            </tr>`).join('');
                        }

                        // Individual orders
                        shipRenderOrders(_shipOrders, 1);

                        // Search (guard against re-registration on reload)
                        if (!_shipListenersAttached) {
                          _shipListenersAttached = true;
                          sectionEl('ship-search').addEventListener('input', function() {
                            _shipPage = 1;
                            const q = this.value.toLowerCase();
                            const filtered = q ? _shipOrders.filter(o =>
                              (o.customer_name||'').toLowerCase().includes(q) ||
                              (o.email||'').toLowerCase().includes(q) ||
                              (o.shipping_provider||'').toLowerCase().includes(q) ||
                              (o.shipping_service||'').toLowerCase().includes(q)
                            ) : _shipOrders;
                            shipRenderOrders(filtered, 1);
                          });
                        }

                      } catch(e) { shipErr('Failed to load shipping data: ' + e.message); }
                    };

                    const RET_STATUS_COLORS = {
                      requested:'#f59e0b', approved:'#22c55e', label_sent:'#38bdf8',
                      item_received:'#34d399', exchange_in_progress:'#a78bfa',
                      completed:'#a78bfa', refunded:'#6b7280', closed:'#6b7280', denied:'#ef4444',
                    };

                    function retShipRender(list) {
                      const tbody = sectionEl('ret-ship-tbody');
                      if (!list.length) {
                        tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No return requests found.</td></tr>';
                        return;
                      }
                      tbody.innerHTML = list.map(r => {
                        const color = RET_STATUS_COLORS[r.status] || 'var(--text-secondary)';
                        const badge = `<span style="font-size:.7rem;letter-spacing:.07em;text-transform:uppercase;color:${color};border:1px solid ${color};padding:2px 7px;border-radius:4px;white-space:nowrap;">${escapeHtml(r.status || '—')}</span>`;
                        const safeTrack = r.trackingUrl && /^https?:\/\//i.test(r.trackingUrl) ? r.trackingUrl : null;
                        const trackCell = r.trackingNumber
                          ? (safeTrack
                              ? `<a href="${escapeAttr(safeTrack)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);text-decoration:none;">${escapeHtml(r.trackingNumber)}</a>`
                              : escapeHtml(r.trackingNumber))
                          : '—';
                        const carrier = escapeHtml([r.carrier, r.service].filter(Boolean).join(' — ') || (r.trackingNumber ? '' : '—'));
                        return `<tr class="zw-divider">
                          <td style="padding:12px;white-space:nowrap;color:var(--text-secondary);font-size:.82rem;">${fmtDate(r.createdAt)}</td>
                          <td style="padding:12px;"><div style="font-weight:600;">${escapeHtml(r.customerName || '—')}</div><div style="color:var(--text-secondary);font-size:.75rem;">${escapeHtml(r.customerEmail || '')}</div></td>
                          <td style="padding:12px;font-family:monospace;font-size:.82rem;">${escapeHtml(r.orderLabel || '—')}<div style="font-family:inherit;color:var(--text-secondary);font-size:.72rem;">${r.orderTotal != null ? fmt$(r.orderTotal) : ''}</div></td>
                          <td style="padding:12px;color:var(--text-secondary);font-size:.82rem;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeAttr(r.reason || '')}">${escapeHtml(r.reason || '—')}</td>
                          <td style="padding:12px;"><div style="color:var(--text-secondary);font-size:.78rem;">${carrier}</div><div>${trackCell}</div></td>
                          <td style="padding:12px;">${badge}</td>
                        </tr>`;
                      }).join('');
                    }

                    async function retShipLoad() {
                      try {
                        const { data: { session } } = await sb.auth.getSession();
                        const token = session?.access_token;
                        if (!token) return;
                        const resp = await fetch('/api/admin-returns', { headers: { Authorization: `Bearer ${token}` } });
                        const payload = resp.ok ? await resp.json().catch(() => ({})) : {};
                        _shipReturns = Array.isArray(payload.requests) ? payload.requests.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) : [];

                        sectionEl('ret-ship-total').textContent   = _shipReturns.length;
                        sectionEl('ret-ship-labels').textContent  = _shipReturns.filter(r => r.labelUrl || r.trackingNumber).length;
                        sectionEl('ret-ship-transit').textContent = _shipReturns.filter(r => r.status === 'label_sent').length;
                        sectionEl('ret-ship-received').textContent= _shipReturns.filter(r => r.status === 'item_received').length;

                        retShipRender(_shipReturns);

                        if (!_retShipListenerAttached) {
                          _retShipListenerAttached = true;
                          sectionEl('ret-ship-search').addEventListener('input', function() {
                            const q = this.value.toLowerCase();
                            const filtered = q ? _shipReturns.filter(r =>
                              (r.customerName||'').toLowerCase().includes(q) ||
                              (r.customerEmail||'').toLowerCase().includes(q) ||
                              (r.orderLabel||'').toLowerCase().includes(q) ||
                              (r.trackingNumber||'').toLowerCase().includes(q)
                            ) : _shipReturns;
                            retShipRender(filtered);
                          });
                        }
                      } catch { /* non-fatal — outbound shipping data still shows */ }
                    }
                  })();
