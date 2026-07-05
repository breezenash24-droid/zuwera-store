                  (function() {
                    let _finLoaded = false;
                    let finRevenueChart = null;
                    let finProductChart = null;
                    let finCategoryChart = null;
                    let _chartJsReady = false;
                    let _chartJsLoading = false;
                    let _chartJsQueue = [];

                    function loadChartJs(cb) {
                      if (_chartJsReady) { cb(); return; }
                      _chartJsQueue.push(cb);
                      if (_chartJsLoading) return;
                      _chartJsLoading = true;
                      const s = document.createElement('script');
                      s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js';
                      s.onload = function() { _chartJsReady = true; _chartJsQueue.splice(0).forEach(function(f){ f(); }); };
                      s.onerror = function() { _chartJsQueue.splice(0).forEach(function(f){ f(new Error('Chart.js failed to load')); }); };
                      document.head.appendChild(s);
                    }

                    const CAT_COLORS = ['#F891A5','#a78bfa','#34d399','#fbbf24','#60a5fa','#f87171','#e879f9','#2dd4bf','#fb923c','#94a3b8'];

                    function finErr(msg) {
                      const el = sectionEl('fin-error');
                      el.textContent = msg;
                      el.style.display = 'block';
                    }
                    function fmtN(n) { return parseInt(n||0).toLocaleString(); }

                    window.finLoadData = async function() {
                      sectionEl('fin-error').style.display = 'none';

                      // Ensure Chart.js is loaded before proceeding
                      await new Promise(function(resolve, reject) { loadChartJs(function(err){ err ? reject(err) : resolve(); }); });

                      try {
                        // Fetch orders and products in parallel
                        const [ordersRes, productsRes] = await Promise.all([
                          sb.from('orders').select('total,subtotal,shipping,tax,items,created_at,status,email,customer_name,free_shipping').order('created_at', { ascending: true }),
                          sb.from('products').select('title,subtitle')
                        ]);
                        if (ordersRes.error) throw ordersRes.error;

                        const allOrders = ordersRes.data || [];

                        // Build title → category map from products table (subtitle = category)
                        const titleToCategory = {};
                        (productsRes.data || []).forEach(p => {
                          if (p.title && p.subtitle) {
                            titleToCategory[p.title.trim().toLowerCase()] = p.subtitle;
                          }
                        });

                        const confirmed = allOrders.filter(o => o.status !== 'cancelled');

                        // Month helpers
                        const now        = new Date();
                        const thisMonthKey  = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
                        const lastMonthDate = new Date(now.getFullYear(), now.getMonth()-1, 1);
                        const lastMonthKey  = lastMonthDate.getFullYear() + '-' + String(lastMonthDate.getMonth()+1).padStart(2,'0');

                        // KPI totals
                        let totalRev = 0, unitsSold = 0, totalTax = 0, totalAbsorbed = 0;
                        let thisMonthRev = 0, lastMonthRev = 0;
                        const customerMap = {};
                        const monthMap = {};

                        confirmed.forEach(o => {
                          const oTotal = parseFloat(o.total || 0);
                          const oTax   = parseFloat(o.tax   || 0);
                          const oShip  = parseFloat(o.shipping || 0);
                          const month  = (o.created_at || '').slice(0, 7);

                          totalRev += oTotal;
                          totalTax += oTax;

                          // Absorbed = we paid shipping but charged $0 to customer
                          // Use actual_shipping from Stripe metadata if available;
                          // fall back to the 'shipping' column (which = 0 for free orders)
                          // Instead: if free_shipping flag is true the 'shipping' col = 0;
                          // use 'subtotal' to back-calculate estimated carrier cost if needed.
                          // For now track 'shipping' field (what customer paid) — when free
                          // the customer paid $0 but we still bought the label.  The actual
                          // cost is not yet in the orders table, so we leave this as "charged to customer".
                          if (!o.free_shipping) totalAbsorbed += 0; // paid by customer

                          if (month === thisMonthKey) thisMonthRev += oTotal;
                          if (month === lastMonthKey) lastMonthRev += oTotal;

                          // Monthly map
                          if (!monthMap[month]) monthMap[month] = { orders: 0, revenue: 0 };
                          monthMap[month].orders++;
                          monthMap[month].revenue += oTotal;

                          // Customer map (for top customer)
                          const custKey = o.email || o.customer_name || 'Unknown';
                          if (!customerMap[custKey]) customerMap[custKey] = { name: o.customer_name || o.email || 'Unknown', total: 0, orders: 0 };
                          customerMap[custKey].total  += oTotal;
                          customerMap[custKey].orders += 1;
                        });

                        // Per-product map + category map
                        const prodMap = {};
                        const catMap = {};
                        confirmed.forEach(o => {
                          let items = [];
                          try { items = JSON.parse(o.items || '[]'); } catch(_) {}
                          items.forEach(item => {
                            const name = item.name || 'Unknown';
                            const qty = parseInt(item.quantity || 1);
                            const rev = (item.amount * qty) / 100;
                            unitsSold += qty;

                            if (!prodMap[name]) prodMap[name] = { units: 0, revenue: 0 };
                            prodMap[name].units += qty;
                            prodMap[name].revenue += rev;

                            const cat = titleToCategory[name.trim().toLowerCase()] || 'Uncategorised';
                            if (!catMap[cat]) catMap[cat] = { units: 0, revenue: 0 };
                            catMap[cat].units += qty;
                            catMap[cat].revenue += rev;
                          });
                        });

                        // Refund rate
                        const refunded = allOrders.filter(o => o.status === 'refunded').length;
                        const refundRate = allOrders.length ? (refunded / allOrders.length * 100).toFixed(1) : '0.0';

                        // Avg items per order
                        const avgItems = confirmed.length ? (unitsSold / confirmed.length).toFixed(1) : '0';

                        // Top customer
                        const topCust = Object.values(customerMap).sort((a,b) => b.total - a.total)[0];

                        // Month-over-month
                        const momChange = lastMonthRev > 0
                          ? ((thisMonthRev - lastMonthRev) / lastMonthRev * 100).toFixed(1)
                          : null;

                        const aov = confirmed.length ? totalRev / confirmed.length : 0;

                        // ── Populate stat cards ──
                        sectionEl('fin-total-rev').textContent = fmt$(totalRev);
                        sectionEl('fin-total-orders').textContent = fmtN(confirmed.length);
                        sectionEl('fin-aov').textContent = fmt$(aov);
                        sectionEl('fin-units').textContent = fmtN(unitsSold);

                        sectionEl('fin-this-month').textContent = fmt$(thisMonthRev);
                        sectionEl('fin-last-month').textContent = fmt$(lastMonthRev);
                        sectionEl('fin-tax-total').textContent  = fmt$(totalTax);
                        sectionEl('fin-shipping-absorbed').textContent = fmt$(totalAbsorbed);
                        sectionEl('fin-refund-rate').textContent = refundRate + '%';
                        sectionEl('fin-avg-items').textContent   = avgItems;

                        // MoM badge
                        const momBadge = sectionEl('fin-mom-badge');
                        if (momChange !== null) {
                          const up = parseFloat(momChange) >= 0;
                          momBadge.textContent = (up ? '▲' : '▼') + ' ' + Math.abs(momChange) + '% vs last month';
                          momBadge.style.color = up ? '#10b981' : '#ef4444';
                        }

                        // Top customer
                        if (topCust) {
                          const wrap = sectionEl('fin-top-customer-wrap');
                          if (wrap) { wrap.style.display = 'flex'; }
                          sectionEl('fin-top-customer-name').textContent = topCust.name;
                          sectionEl('fin-top-customer-stats').textContent = topCust.orders + ' order' + (topCust.orders !== 1 ? 's' : '') + ' · ' + fmt$(topCust.total) + ' total';
                        }

                        // Monthly breakdown table (last 12 months)
                        const monthlyTbody = sectionEl('fin-monthly-tbody');
                        const sortedMonths = Object.keys(monthMap).sort().reverse().slice(0, 12);
                        if (sortedMonths.length === 0) {
                          monthlyTbody.innerHTML = '<tr class="empty-row"><td colspan="5">No data</td></tr>';
                        } else {
                          monthlyTbody.innerHTML = sortedMonths.map((m, i) => {
                            const d = monthMap[m];
                            const priorKey = sortedMonths[i + 1];
                            const priorRev = priorKey ? monthMap[priorKey]?.revenue || 0 : null;
                            const chg = priorRev !== null && priorRev > 0
                              ? ((d.revenue - priorRev) / priorRev * 100).toFixed(1)
                              : null;
                            const chgHtml = chg !== null
                              ? `<span style="color:${parseFloat(chg)>=0?'#10b981':'#ef4444'}">${parseFloat(chg)>=0?'▲':'▼'} ${Math.abs(chg)}%</span>`
                              : '—';
                            const [y, mo] = m.split('-');
                            const label = new Date(parseInt(y), parseInt(mo)-1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
                            const monthAov = d.orders > 0 ? fmt$(d.revenue / d.orders) : '—';
                            return `<tr class="zw-divider">
                              <td style="padding:10px 0;">${label}</td>
                              <td style="padding:10px 0;text-align:right;">${d.orders}</td>
                              <td style="padding:10px 0;text-align:right;color:var(--accent);font-weight:600;">${fmt$(d.revenue)}</td>
                              <td style="padding:10px 0;text-align:right;">${monthAov}</td>
                              <td style="padding:10px 0;text-align:right;">${chgHtml}</td>
                            </tr>`;
                          }).join('');
                        }

                        // Product table
                        const prods = Object.entries(prodMap).sort((a,b) => b[1].revenue - a[1].revenue);
                        const tbody = sectionEl('fin-product-tbody');
                        if (prods.length === 0) {
                          tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No order items found</td></tr>';
                        } else {
                          tbody.innerHTML = prods.map(([name, d]) => {
                            const pct = totalRev > 0 ? ((d.revenue/totalRev)*100).toFixed(1) : '0.0';
                            const avgUnit = d.units > 0 ? d.revenue/d.units : 0;
                            const cat = titleToCategory[name.trim().toLowerCase()] || '—';
                            return `<tr class="zw-divider">
                              <td style="padding:12px;">${name}<span style="margin-left:8px;font-size:11px;color:var(--text-secondary);">${cat}</span></td>
                              <td style="padding:12px;text-align:right;">${d.units}</td>
                              <td style="padding:12px;text-align:right;color:var(--accent);font-weight:600;">${fmt$(d.revenue)}</td>
                              <td style="padding:12px;text-align:right;">${fmt$(avgUnit)}</td>
                              <td style="padding:12px;text-align:right;">
                                <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end;">
                                  <div style="width:60px;height:6px;background:var(--border);border-radius:3px;overflow:hidden;">
                                    <div style="width:${pct}%;height:100%;background:var(--accent);border-radius:3px;"></div>
                                  </div>
                                  ${pct}%
                                </div>
                              </td>
                            </tr>`;
                          }).join('');
                        }

                        // Revenue trend (group by day)
                        const dayMap = {};
                        confirmed.forEach(o => {
                          const day = o.created_at ? o.created_at.slice(0,10) : 'unknown';
                          dayMap[day] = (dayMap[day] || 0) + parseFloat(o.total || 0);
                        });
                        const sortedDays = Object.keys(dayMap).sort();
                        const last30 = sortedDays.slice(-30);
                        const revValues = last30.map(d => dayMap[d].toFixed(2));

                        const ctx1 = sectionEl('fin-revenue-chart').getContext('2d');
                        if (finRevenueChart) finRevenueChart.destroy();
                        finRevenueChart = new Chart(ctx1, {
                          type: 'line',
                          data: {
                            labels: last30.map(d => d.slice(5)),
                            datasets: [{ label: 'Revenue', data: revValues, borderColor: '#F891A5', backgroundColor: 'rgba(248,145,165,0.12)', fill: true, tension: 0.4, pointRadius: 3 }]
                          },
                          options: {
                            responsive: true,
                            plugins: { legend: { display: false } },
                            scales: {
                              x: { ticks: { color: '#9b9b9b', maxTicksLimit: 10 }, grid: { color: '#1e1e1e' } },
                              y: { ticks: { color: '#9b9b9b', callback: v => '$' + v }, grid: { color: '#1e1e1e' } }
                            }
                          }
                        });

                        // Product bar chart (top 8)
                        const top8 = prods.slice(0,8);
                        const ctx2 = sectionEl('fin-product-chart').getContext('2d');
                        if (finProductChart) finProductChart.destroy();
                        finProductChart = new Chart(ctx2, {
                          type: 'bar',
                          data: {
                            labels: top8.map(([n]) => n),
                            datasets: [{ label: 'Revenue', data: top8.map(([,d]) => d.revenue.toFixed(2)), backgroundColor: '#F891A5', borderRadius: 4 }]
                          },
                          options: {
                            responsive: true,
                            plugins: { legend: { display: false } },
                            scales: {
                              x: { ticks: { color: '#9b9b9b' }, grid: { display: false } },
                              y: { ticks: { color: '#9b9b9b', callback: v => '$' + v }, grid: { color: '#1e1e1e' } }
                            }
                          }
                        });

                        // Category breakdown
                        const cats = Object.entries(catMap).sort((a,b) => b[1].revenue - a[1].revenue);

                        // Category table
                        const ctbody = sectionEl('fin-category-tbody');
                        if (cats.length === 0) {
                          ctbody.innerHTML = '<tr class="empty-row"><td colspan="3">No category data</td></tr>';
                        } else {
                          ctbody.innerHTML = cats.map(([cat, d], i) => `
                            <tr class="zw-divider">
                              <td style="padding:10px 0;">
                                <div style="display:flex;align-items:center;gap:8px;">
                                  <div style="width:10px;height:10px;border-radius:50%;background:${CAT_COLORS[i % CAT_COLORS.length]};flex-shrink:0;"></div>
                                  ${cat}
                                </div>
                              </td>
                              <td style="padding:10px 0;text-align:right;">${d.units}</td>
                              <td style="padding:10px 0;text-align:right;font-weight:600;color:var(--accent);">${fmt$(d.revenue)}</td>
                            </tr>`).join('');
                        }

                        // Category doughnut chart
                        const ctx3 = sectionEl('fin-category-chart').getContext('2d');
                        if (finCategoryChart) finCategoryChart.destroy();
                        finCategoryChart = new Chart(ctx3, {
                          type: 'doughnut',
                          data: {
                            labels: cats.map(([c]) => c),
                            datasets: [{
                              data: cats.map(([,d]) => d.revenue.toFixed(2)),
                              backgroundColor: cats.map((_, i) => CAT_COLORS[i % CAT_COLORS.length]),
                              borderColor: getComputedStyle(document.body).getPropertyValue('--bg-primary').trim() || '#09090b',
                              borderWidth: 3
                            }]
                          },
                          options: {
                            responsive: true,
                            cutout: '65%',
                            plugins: {
                              legend: { position: 'bottom', labels: { color: getComputedStyle(document.body).getPropertyValue('--text-secondary').trim() || '#9b9b9b', padding: 16, font: { size: 12 } } },
                              tooltip: { callbacks: { label: ctx => ` ${ctx.label}: $${parseFloat(ctx.parsed).toFixed(2)}` } }
                            }
                          }
                        });

                      } catch(e) { finErr('Failed to load finance data: ' + e.message); }
                    };
                  })();
