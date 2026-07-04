                  (function(){
                    // State
                    let _anaProds = [], _anaOrders = [], _anaReturns = [];
                    let _anaPeriod = 'all';
                    let _anaCatSort = { key:'title', dir:'asc' };
                    let _anaInvSort = { key:'stock', dir:'asc' };
                    let _anaInvFilter = 'all';
                    let _anaLoaded = false;

                    // ── Period filter ──
                    function filteredOrders() {
                      if (_anaPeriod === 'all') return _anaOrders;
                      const days = parseInt(_anaPeriod);
                      const cutoff = new Date(Date.now() - days * 864e5);
                      return _anaOrders.filter(o => new Date(o.created_at) >= cutoff);
                    }
                    function prevPeriodOrders() {
                      if (_anaPeriod === 'all') return [];
                      const days = parseInt(_anaPeriod);
                      const now = Date.now();
                      const start = new Date(now - days * 2 * 864e5);
                      const end   = new Date(now - days * 864e5);
                      return _anaOrders.filter(o => { const d = new Date(o.created_at); return d >= start && d < end; });
                    }
                    function momArrow(cur, prev) {
                      if (!prev) return '';
                      const pct = ((cur - prev) / prev * 100).toFixed(1);
                      const up = cur >= prev;
                      return `<span style="color:${up?'#10b981':'#ef4444'}">${up?'▲':'▼'} ${Math.abs(pct)}% vs prev period</span>`;
                    }
                    function orderTotal(o) { return Number(o.total) || Number(o.total_amount) || 0; }
                    function parseItems(o) {
                      try { if (Array.isArray(o.items)) return o.items; return JSON.parse(o.items) || []; } catch(_) { return []; }
                    }

                    // Period button wiring
                    document.getElementById('ana-period-btns').addEventListener('click', e => {
                      const btn = e.target.closest('[data-period]');
                      if (!btn) return;
                      _anaPeriod = btn.dataset.period;
                      document.querySelectorAll('#ana-period-btns .ana-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
                      if (_anaLoaded) anaRefreshViews();
                    });

                    function anaErr(msg) {
                      const d = document.createElement('div');
                      d.className = 'ana-err'; d.textContent = msg;
                      sectionEl('ana-error-container').appendChild(d);
                    }

                    // ── Bar chart helper ──
                    function anaBarChart(containerId, entries, colorMap) {
                      const c = sectionEl(containerId); if (!c) return;
                      c.innerHTML = '';
                      const maxVal = Math.max(...entries.map(e => e.val), 1);
                      entries.forEach(e => {
                        const pct = (e.val / maxVal) * 100;
                        const item = document.createElement('div');
                        item.className = 'ana-bar-item';
                        item.innerHTML = `
                          <div class="ana-bar ${colorMap[e.key] || ''}" style="height:${pct}%">
                            <div class="ana-bar-val">${e.val}</div>
                          </div>
                          <div class="ana-bar-label">${e.label}</div>`;
                        c.appendChild(item);
                      });
                    }

                    // ── Data loaders ──
                    async function anaLoadProds() {
                      const { data: prods } = await sb.from('products').select('*');
                      const { data: sizes } = await sb.from('product_sizes').select('*');
                      const { data: colors } = await sb.from('color_variants').select('*');
                      const { data: images } = await sb.from('product_images').select('*');
                      _anaProds = (prods || []).map(p => ({
                        ...p,
                        product_sizes: (sizes || []).filter(s => s.product_id === p.id),
                        color_variants: (colors || []).filter(c => c.product_id === p.id),
                        product_images: (images || []).filter(i => i.product_id === p.id)
                      }));
                    }

                    async function anaLoadOrders() {
                      const [ordRes, retRes] = await Promise.all([
                        sb.from('orders').select('*'),
                        sb.from('returns').select('order_id,status').catch(() => ({data:[]}))
                      ]);
                      if (!ordRes.error) _anaOrders = ordRes.data || [];
                      _anaReturns = retRes.data || [];
                    }

                    async function anaLoadEngagement() {
                      const { data: favs } = await sb.from('favorites').select('*');
                      const { data: waitlist } = await sb.from('waitlist').select('*');
                      sectionEl('ana-totalFavorites').textContent = favs ? favs.length : 0;
                      sectionEl('ana-totalWaitlist').textContent = waitlist ? waitlist.length : 0;

                      // Top favorites
                      const fc = {};
                      (favs || []).forEach(f => { fc[f.product_name] = (fc[f.product_name] || 0) + 1; });
                      const top = Object.entries(fc).sort((a,b) => b[1]-a[1]).slice(0,5);
                      const favEl = sectionEl('ana-topFavorites');
                      favEl.innerHTML = top.length
                        ? top.map(([name,cnt]) => `<div class="ana-prod-card"><div class="ana-prod-title">${name}</div><div style="color:var(--text-secondary);font-size:.85rem;">${cnt} saves</div></div>`).join('')
                        : '<p style="color:var(--text-secondary)">No favorites yet.</p>';
                    }

                    // ── Render helpers ──
                    function anaUpdateCards() {
                      const live = _anaProds.filter(p => (p.status||'').toLowerCase() === 'live').length;
                      let inv = 0, low = 0, colors = 0;
                      _anaProds.forEach(p => {
                        const sizes = p.product_sizes || [];
                        if (sizes.length === 0) { low++; }
                        sizes.forEach(s => {
                          inv += s.stock_quantity || 0;
                          if ((s.stock_quantity || 0) <= (p.low_stock_threshold || 10)) low++;
                        });
                        colors += p.color_variants?.length || 0;
                      });
                      const prices = _anaProds.filter(p => p.current_price).map(p => Number(p.current_price));
                      const avgPrice = prices.length ? (prices.reduce((a,b)=>a+b,0)/prices.length) : 0;
                      sectionEl('ana-totalProducts').textContent = _anaProds.length;
                      sectionEl('ana-liveProducts').textContent = live;
                      sectionEl('ana-totalInventory').textContent = inv.toLocaleString();
                      sectionEl('ana-lowStockAlerts').textContent = low;
                      sectionEl('ana-avgPrice').textContent = `$${avgPrice.toFixed(2)}`;
                      sectionEl('ana-colorVariants').textContent = colors;
                    }

                    function anaUpdateOrders() {
                      const orders = filteredOrders();
                      const prev   = prevPeriodOrders();
                      const tot = orders.length;
                      const rev = orders.reduce((s,o) => s + orderTotal(o), 0);
                      const aov = tot ? rev/tot : 0;
                      const prevRev = prev.reduce((s,o) => s + orderTotal(o), 0);
                      const prevTot = prev.length;
                      const prevAov = prevTot ? prevRev/prevTot : 0;

                      // Unique customers
                      const emailSet = new Set(orders.map(o => (o.email||'').toLowerCase()).filter(Boolean));
                      const prevEmailSet = new Set(prev.map(o => (o.email||'').toLowerCase()).filter(Boolean));

                      // Repeat rate: customers with 2+ orders (all-time)
                      const custCounts = {};
                      _anaOrders.forEach(o => { const e=(o.email||'').toLowerCase(); if(e) custCounts[e]=(custCounts[e]||0)+1; });
                      const repeats = Object.values(custCounts).filter(n=>n>=2).length;
                      const total_custs = Object.keys(custCounts).length;
                      const repeatRate = total_custs ? (repeats/total_custs*100).toFixed(1)+'%' : '—';

                      // Return rate
                      const retOrderIds = new Set((_anaReturns||[]).map(r=>r.order_id));
                      const returnedInPeriod = orders.filter(o => retOrderIds.has(o.id)).length;
                      const returnRate = tot ? (returnedInPeriod/tot*100).toFixed(1)+'%' : '—';

                      sectionEl('ana-totalOrders').textContent = tot;
                      sectionEl('ana-totalRevenue').textContent = `$${rev.toFixed(2)}`;
                      sectionEl('ana-avgOrderValue').textContent = `$${aov.toFixed(2)}`;
                      sectionEl('ana-repeatRate').textContent = repeatRate;
                      sectionEl('ana-returnRate').textContent = returnRate;
                      sectionEl('ana-newCustomers').textContent = emailSet.size;
                      if (_anaPeriod !== 'all') {
                        sectionEl('ana-rev-mom').innerHTML = momArrow(rev, prevRev);
                        sectionEl('ana-ord-mom').innerHTML = momArrow(tot, prevTot);
                        sectionEl('ana-aov-mom').innerHTML = momArrow(aov, prevAov);
                        sectionEl('ana-cust-mom').innerHTML = momArrow(emailSet.size, prevEmailSet.size);
                      } else {
                        ['ana-rev-mom','ana-ord-mom','ana-aov-mom','ana-cust-mom'].forEach(id => sectionEl(id).innerHTML = '');
                      }

                      // Order status breakdown
                      const statusMap = {};
                      orders.forEach(o => { const s = o.status||'confirmed'; statusMap[s]=(statusMap[s]||0)+1; });
                      const statusColors = {paid:'#10b981',confirmed:'#10b981',shipped:'#3b82f6',delivered:'#6366f1',refunded:'#ef4444',cancelled:'#9ca3af',pending:'#f59e0b'};
                      const statusEl = sectionEl('ana-statusBreakdown');
                      if (!tot) { statusEl.innerHTML = '<p style="color:var(--text-secondary)">No orders in this period.</p>'; }
                      else {
                        const total = Object.values(statusMap).reduce((a,b)=>a+b,0);
                        statusEl.innerHTML = `<div style="display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1rem;">
                          ${Object.entries(statusMap).sort((a,b)=>b[1]-a[1]).map(([s,n])=>{
                            const col = statusColors[s.toLowerCase()] || '#6b7280';
                            const pct = (n/total*100).toFixed(1);
                            return `<div style="background:var(--bg-tertiary,#1a1a1e);border-radius:8px;padding:.9rem 1.2rem;min-width:120px;">
                              <div style="font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-secondary);margin-bottom:.4rem;">${s}</div>
                              <div style="font-size:1.6rem;font-weight:700;color:${col};">${n}</div>
                              <div style="font-size:.75rem;color:var(--text-secondary);">${pct}%</div>
                            </div>`;
                          }).join('')}
                        </div>
                        <div style="display:flex;height:10px;border-radius:6px;overflow:hidden;gap:2px;">
                          ${Object.entries(statusMap).sort((a,b)=>b[1]-a[1]).map(([s,n])=>{
                            const col = statusColors[s.toLowerCase()] || '#6b7280';
                            return `<div style="flex:${n};background:${col};min-width:4px;" title="${s}: ${n}"></div>`;
                          }).join('')}
                        </div>`;
                      }

                      // Revenue by product
                      const prodRev = {};
                      orders.forEach(o => {
                        parseItems(o).forEach(item => {
                          const key = item.name || item.title || item.product_id || 'Unknown';
                          const rev = itemRev(item);
                          if (!prodRev[key]) prodRev[key] = { name:key, units:0, revenue:0, orders:0 };
                          prodRev[key].units  += itemQty(item);
                          prodRev[key].revenue += rev;
                          prodRev[key].orders++;
                        });
                      });
                      const prodList = Object.values(prodRev).sort((a,b)=>b.revenue-a.revenue);
                      const maxProdRev = prodList[0]?.revenue || 1;
                      const revEl = sectionEl('ana-revByProduct');
                      if (!prodList.length) { revEl.innerHTML = '<p style="color:var(--text-secondary)">No order data yet.</p>'; }
                      else {
                        revEl.innerHTML = `<table><thead><tr><th>Product</th><th>Revenue</th><th>Units</th><th>Orders</th><th style="width:160px"></th></tr></thead><tbody>
                          ${prodList.map(p => `<tr>
                            <td style="font-weight:600">${p.name}</td>
                            <td style="color:var(--accent)">$${p.revenue.toFixed(2)}</td>
                            <td>${p.units}</td>
                            <td>${p.orders}</td>
                            <td><div style="height:6px;background:var(--bg-tertiary,#1a1a1e);border-radius:3px;"><div style="height:100%;width:${(p.revenue/maxProdRev*100).toFixed(1)}%;background:var(--accent);border-radius:3px;"></div></div></td>
                          </tr>`).join('')}
                        </tbody></table>`;
                      }

                      // Top customers
                      const custMap = {};
                      orders.forEach(o => {
                        const key = (o.email||'').toLowerCase() || o.id;
                        const name = o.customer_name || o.email || 'Guest';
                        if (!custMap[key]) custMap[key] = { name, email:o.email||'', orders:0, revenue:0 };
                        custMap[key].orders++;
                        custMap[key].revenue += orderTotal(o);
                      });
                      const custList = Object.values(custMap).sort((a,b)=>b.revenue-a.revenue).slice(0,10);
                      const custEl = sectionEl('ana-topCustomers');
                      if (!custList.length) { custEl.innerHTML = '<p style="color:var(--text-secondary)">No customers yet.</p>'; }
                      else {
                        custEl.innerHTML = `<table><thead><tr><th>Customer</th><th>Email</th><th>Orders</th><th>Total Spend</th><th>Repeat?</th></tr></thead><tbody>
                          ${custList.map(c => `<tr>
                            <td style="font-weight:600">${c.name}</td>
                            <td style="color:var(--text-secondary);font-size:.85rem;">${c.email}</td>
                            <td>${c.orders}</td>
                            <td style="color:var(--accent)">$${c.revenue.toFixed(2)}</td>
                            <td>${c.orders>=2?'<span style="color:#10b981;font-size:.75rem;font-weight:700;">YES</span>':'<span style="color:var(--text-secondary);font-size:.75rem;">—</span>'}</td>
                          </tr>`).join('')}
                        </tbody></table>`;
                      }

                      // Geographic distribution
                      const stateMap = {};
                      orders.forEach(o => {
                        const state = o.ship_state || o.shipping_state || o.state || (o.shipping_address && (typeof o.shipping_address === 'object' ? o.shipping_address.state : null)) || '';
                        if (state && state.length <= 3) stateMap[state.toUpperCase()] = (stateMap[state.toUpperCase()]||0) + 1;
                      });
                      const stateList = Object.entries(stateMap).sort((a,b)=>b[1]-a[1]);
                      const maxState = stateList[0]?.[1] || 1;
                      const geoEl = sectionEl('ana-geoTable');
                      if (!stateList.length) { geoEl.innerHTML = '<p style="color:var(--text-secondary)">No state data in orders yet.</p>'; }
                      else {
                        geoEl.innerHTML = `<table><thead><tr><th>State</th><th>Orders</th><th style="width:200px"></th></tr></thead><tbody>
                          ${stateList.slice(0,15).map(([st,n]) => `<tr>
                            <td style="font-weight:600">${st}</td>
                            <td>${n}</td>
                            <td><div style="height:6px;background:var(--bg-tertiary,#1a1a1e);border-radius:3px;"><div style="height:100%;width:${(n/maxState*100).toFixed(1)}%;background:var(--accent);border-radius:3px;"></div></div></td>
                          </tr>`).join('')}
                        </tbody></table>`;
                      }

                      // Recent orders table
                      const c = sectionEl('ana-ordersTable');
                      if (!tot) { c.innerHTML = '<p style="color:var(--text-secondary);padding:1.5rem 0;">No orders in this period.</p>'; return; }
                      const statusBadgeClass = s => { const k=(s||'').toLowerCase(); return k==='shipped'?'badge-coming-soon':k==='refunded'||k==='cancelled'?'badge-sold-out':k==='delivered'?'badge-draft':'badge-live'; };
                      const rows = [...orders].sort((a,b) => new Date(b.created_at)-new Date(a.created_at)).slice(0,20)
                        .map(o => {
                          const amt = orderTotal(o);
                          return `<tr>
                            <td style="font-family:monospace;font-size:.82rem">#${(o.id||'').substring(0,8).toUpperCase()}</td>
                            <td>${new Date(o.created_at).toLocaleDateString()}</td>
                            <td>${o.email||'Guest'}</td>
                            <td>$${amt.toFixed(2)}</td>
                            <td><span class="ana-status-badge ${statusBadgeClass(o.status)}">${o.status||'Confirmed'}</span></td>
                          </tr>`;
                        }).join('');
                      c.innerHTML = `<table><thead><tr><th>Order ID</th><th>Date</th><th>Customer</th><th>Total</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
                    }

                    // CSV export helpers
                    function anaExportCSV(filename, headers, rows) {
                      const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
                      const a = document.createElement('a');
                      a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
                      a.download = filename; a.click();
                    }
                    window.anaExportOrders = function() {
                      const orders = filteredOrders();
                      anaExportCSV(`orders_${_anaPeriod}_${new Date().toISOString().slice(0,10)}.csv`,
                        ['Order ID','Date','Email','Customer','Total','Status'],
                        orders.map(o => [(o.id||'').substring(0,8).toUpperCase(), new Date(o.created_at).toLocaleDateString(), o.email||'', o.customer_name||'', orderTotal(o).toFixed(2), o.status||'confirmed']));
                    };
                    window.anaExportRevByProduct = function() {
                      const orders = filteredOrders();
                      const prodRev = {};
                      orders.forEach(o => parseItems(o).forEach(item => {
                        const key = item.name || item.title || 'Unknown';
                        if (!prodRev[key]) prodRev[key] = { units:0, revenue:0 };
                        prodRev[key].units += itemQty(item);
                        prodRev[key].revenue += itemRev(item);
                      }));
                      anaExportCSV(`revenue_by_product_${new Date().toISOString().slice(0,10)}.csv`,
                        ['Product','Units Sold','Revenue'],
                        Object.entries(prodRev).sort((a,b)=>b[1].revenue-a[1].revenue).map(([name,d]) => [name, d.units, d.revenue.toFixed(2)]));
                    };

                    // ── Shared item helpers ──────────────────────────────────────────
                    // Persisted order items store price as `amount` in CENTS (Stripe unit);
                    // older/guest snapshots may carry `price` in dollars. Normalise here so
                    // every revenue calc agrees. (function decls → hoisted, safe to use above.)
                    function itemQty(it)  { return Number(it.quantity || it.qty || 1) || 1; }
                    function itemUnit(it) { return it.amount != null ? (Number(it.amount) || 0) / 100 : (Number(it.price) || 0); }
                    function itemRev(it)  { return itemUnit(it) * itemQty(it); }
                    function itemName(it) { return it.name || it.title || it.productId || it.product_id || 'Unknown'; }
                    function anaProdMaps() {
                      const byId = {}, byTitle = {};
                      _anaProds.forEach(p => { byId[p.id] = p; if (p.title) byTitle[String(p.title).toLowerCase()] = p; });
                      return { byId, byTitle };
                    }
                    function itemProd(it, maps) {
                      return maps.byId[it.productId] || maps.byId[it.product_id]
                        || maps.byTitle[String(it.name || it.title || '').toLowerCase()] || null;
                    }
                    function cmpArrow(cur, prev, label) {
                      if (!prev) return '';
                      const pct = ((cur - prev) / prev * 100).toFixed(0);
                      const up = cur >= prev;
                      return `<span style="color:${up?'#10b981':'#ef4444'}">${up?'▲':'▼'} ${Math.abs(pct)}% ${label||''}</span>`;
                    }
                    function anaCurrencyBars(containerId, entries, color) {
                      const c = sectionEl(containerId); if (!c) return;
                      const max = Math.max(...entries.map(e => e.val), 1);
                      c.innerHTML = '';
                      entries.forEach(e => {
                        const pct = (e.val / max) * 100;
                        const item = document.createElement('div'); item.className = 'ana-bar-item';
                        item.innerHTML = `<div class="ana-bar" style="height:${e.val>0?Math.max(pct,3):0}%;background:${color||'var(--accent)'}"><div class="ana-bar-val">$${Math.round(e.val).toLocaleString()}</div></div><div class="ana-bar-label">${e.label}</div>`;
                        c.appendChild(item);
                      });
                    }

                    // ── Live "Today" strip (period-independent) ──────────────────────
                    function anaRenderToday() {
                      const now = new Date();
                      const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
                      const lwStart = new Date(todayStart.getTime() - 7*864e5);
                      const lwEnd   = new Date(now.getTime() - 7*864e5);
                      const tOrders  = _anaOrders.filter(o => new Date(o.created_at) >= todayStart);
                      const lwOrders = _anaOrders.filter(o => { const d = new Date(o.created_at); return d >= lwStart && d <= lwEnd; });
                      const tRev  = tOrders.reduce((s,o) => s + orderTotal(o), 0);
                      const lwRev = lwOrders.reduce((s,o) => s + orderTotal(o), 0);
                      const setT = (id,v) => { const e = sectionEl(id); if (e) e.textContent = v; };
                      setT('ana-today-rev', `$${tRev.toFixed(2)}`);
                      setT('ana-today-ord', tOrders.length);
                      setT('ana-today-aov', `$${(tOrders.length ? tRev/tOrders.length : 0).toFixed(2)}`);
                      const rc = sectionEl('ana-today-rev-cmp');
                      if (rc) rc.innerHTML = lwOrders.length ? cmpArrow(tRev, lwRev, 'vs last wk') : '<span style="color:var(--text-secondary)">no orders last wk</span>';
                      const oc = sectionEl('ana-today-ord-cmp');
                      if (oc) oc.innerHTML = lwOrders.length ? cmpArrow(tOrders.length, lwOrders.length, 'vs last wk') : '';
                      const latest = [..._anaOrders].sort((a,b) => new Date(b.created_at) - new Date(a.created_at)).slice(0,5);
                      const le = sectionEl('ana-today-latest');
                      if (le) le.innerHTML = latest.length
                        ? latest.map(o => `<div style="display:flex;justify-content:space-between;gap:.6rem;padding:.12rem 0;"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${o.email||'Guest'}</span><span style="color:var(--accent);white-space:nowrap;">$${orderTotal(o).toFixed(2)}</span></div>`).join('')
                        : 'No orders yet.';
                      const up = sectionEl('ana-today-updated');
                      if (up) up.textContent = 'Updated ' + now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) + ' · auto-refreshes';
                    }
                    let _anaTodayTimer = null;
                    function anaStartTodayAutoRefresh() {
                      if (_anaTodayTimer) return;
                      _anaTodayTimer = setInterval(async () => {
                        const pg = document.getElementById('analytics');
                        if (!pg || !pg.classList.contains('active') || document.hidden) return;
                        try { await anaLoadOrders(); anaRenderToday(); } catch(_) {}
                      }, 45000);
                    }

                    // ── When customers buy: day-of-week + hour-of-day (period-aware) ──
                    function anaRenderTiming() {
                      const orders = filteredOrders();
                      const dow = [0,0,0,0,0,0,0];
                      const hod = new Array(24).fill(0);
                      orders.forEach(o => { const d = new Date(o.created_at); const t = orderTotal(o); dow[d.getDay()] += t; hod[d.getHours()] += t; });
                      const dl = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
                      anaCurrencyBars('ana-dowChart', dl.map((l,i) => ({label:l, val:dow[i]})), '#6366f1');
                      const c = sectionEl('ana-hodChart');
                      if (c) {
                        const max = Math.max(...hod, 1);
                        c.innerHTML = hod.map((v,h) => {
                          const intensity = v / max;
                          const bg = v > 0 ? `rgba(16,185,129,${(0.18 + intensity*0.82).toFixed(2)})` : 'var(--bg-tertiary,#1a1a1e)';
                          const lbl = (h % 3 === 0) ? String(h) : '';
                          return `<div title="${h}:00 – $${Math.round(v).toLocaleString()}" style="flex:1;min-width:0;">
                            <div style="height:${Math.max(6, Math.round(intensity*64))}px;background:${bg};border-radius:2px;"></div>
                            <div style="text-align:center;font-size:.6rem;color:var(--text-secondary);margin-top:2px;height:12px;">${lbl}</div>
                          </div>`;
                        }).join('');
                      }
                    }

                    // ── New vs returning revenue (period-aware; first order = all-time) ──
                    function anaRenderCohorts() {
                      const el = sectionEl('ana-cohortSplit'); if (!el) return;
                      const orders = filteredOrders();
                      if (!orders.length) { el.innerHTML = '<span style="color:var(--text-secondary)">No orders in this period.</span>'; return; }
                      const first = {};
                      _anaOrders.forEach(o => { const e = (o.email||'').toLowerCase(); if (!e) return; const d = +new Date(o.created_at); if (first[e] == null || d < first[e]) first[e] = d; });
                      let newRev = 0, retRev = 0, newN = 0, retN = 0;
                      orders.forEach(o => {
                        const e = (o.email||'').toLowerCase(); const t = orderTotal(o); const d = +new Date(o.created_at);
                        const isNew = !e || first[e] == null || d <= first[e];
                        if (isNew) { newRev += t; newN++; } else { retRev += t; retN++; }
                      });
                      const tot = (newRev + retRev) || 1;
                      const nPct = newRev/tot*100, rPct = retRev/tot*100;
                      el.innerHTML = `
                        <div style="display:flex;height:14px;border-radius:7px;overflow:hidden;margin-bottom:.9rem;">
                          <div style="width:${nPct}%;background:#3b82f6;" title="New"></div>
                          <div style="width:${rPct}%;background:#10b981;" title="Returning"></div>
                        </div>
                        <div class="ana-stat-row"><span class="ana-stat-label"><span style="color:#3b82f6">●</span> New customers</span><span class="ana-stat-val">$${newRev.toFixed(2)} · ${nPct.toFixed(0)}%</span></div>
                        <div class="ana-stat-row"><span class="ana-stat-label"><span style="color:#10b981">●</span> Returning</span><span class="ana-stat-val">$${retRev.toFixed(2)} · ${rPct.toFixed(0)}%</span></div>
                        <div class="ana-stat-row"><span class="ana-stat-label">Orders (new / returning)</span><span class="ana-stat-val">${newN} / ${retN}</span></div>`;
                    }

                    // ── Full-price vs sale revenue (item price paid vs product MSRP) ──
                    function anaRenderDiscount() {
                      const el = sectionEl('ana-discountSplit'); if (!el) return;
                      const orders = filteredOrders(); const maps = anaProdMaps();
                      let fullRev = 0, saleRev = 0, saleUnits = 0, discSum = 0, anyMsrp = false;
                      orders.forEach(o => parseItems(o).forEach(it => {
                        const unit = itemUnit(it), qty = itemQty(it), rev = unit*qty;
                        const p = itemProd(it, maps); const msrp = p ? Number(p.msrp)||0 : 0;
                        if (msrp > 0) {
                          anyMsrp = true;
                          if (unit < msrp*0.995) { saleRev += rev; saleUnits += qty; discSum += ((msrp-unit)/msrp)*qty; }
                          else fullRev += rev;
                        } else fullRev += rev;
                      }));
                      const tot = fullRev + saleRev;
                      if (!tot) { el.innerHTML = '<span style="color:var(--text-secondary)">No sales in this period.</span>'; return; }
                      const salePct = saleRev/tot*100, fullPct = fullRev/tot*100;
                      const avgDisc = saleUnits ? discSum/saleUnits*100 : 0;
                      el.innerHTML = `
                        <div style="display:flex;height:14px;border-radius:7px;overflow:hidden;margin-bottom:.9rem;">
                          <div style="width:${fullPct}%;background:#10b981;" title="Full price"></div>
                          <div style="width:${salePct}%;background:#f59e0b;" title="Sale"></div>
                        </div>
                        <div class="ana-stat-row"><span class="ana-stat-label"><span style="color:#10b981">●</span> Full-price revenue</span><span class="ana-stat-val">$${fullRev.toFixed(2)} · ${fullPct.toFixed(0)}%</span></div>
                        <div class="ana-stat-row"><span class="ana-stat-label"><span style="color:#f59e0b">●</span> Sale revenue</span><span class="ana-stat-val">$${saleRev.toFixed(2)} · ${salePct.toFixed(0)}%</span></div>
                        <div class="ana-stat-row"><span class="ana-stat-label">Avg discount depth (sale items)</span><span class="ana-stat-val">${avgDisc.toFixed(1)}%</span></div>
                        ${anyMsrp ? '' : '<div style="font-size:.72rem;color:var(--text-secondary);margin-top:.5rem;">No MSRP set on sold products — all counted as full price.</div>'}`;
                    }

                    // ── Revenue by category (item → product.category) ────────────────
                    function anaRenderCategory() {
                      const el = sectionEl('ana-categoryTable'); if (!el) return;
                      const orders = filteredOrders(); const maps = anaProdMaps();
                      const cat = {};
                      orders.forEach(o => parseItems(o).forEach(it => {
                        const p = itemProd(it, maps); const c = (p && p.category) ? p.category : 'Uncategorized';
                        if (!cat[c]) cat[c] = { cat:c, rev:0, units:0 };
                        cat[c].rev += itemRev(it); cat[c].units += itemQty(it);
                      }));
                      const list = Object.values(cat).sort((a,b) => b.rev - a.rev);
                      if (!list.length) { el.innerHTML = '<p style="color:var(--text-secondary)">No sales in this period.</p>'; return; }
                      const max = list[0].rev || 1;
                      el.innerHTML = `<table><thead><tr><th>Category</th><th>Revenue</th><th>Units</th><th style="width:180px"></th></tr></thead><tbody>
                        ${list.map(r => `<tr><td style="font-weight:600">${r.cat}</td><td style="color:var(--accent)">$${r.rev.toFixed(2)}</td><td>${r.units}</td>
                          <td><div style="height:6px;background:var(--bg-tertiary,#1a1a1e);border-radius:3px;"><div style="height:100%;width:${(r.rev/max*100).toFixed(1)}%;background:var(--accent);border-radius:3px;"></div></div></td></tr>`).join('')}
                      </tbody></table>`;
                    }

                    // ── Sell-through velocity (units/day + days of stock left) ────────
                    function anaComputeVelocity() {
                      const orders = filteredOrders(); const maps = anaProdMaps();
                      const sold = {};
                      orders.forEach(o => parseItems(o).forEach(it => {
                        const p = itemProd(it, maps); const key = p ? p.id : (it.productId || it.name || '?');
                        if (!sold[key]) sold[key] = { units:0, rev:0 };
                        sold[key].units += itemQty(it); sold[key].rev += itemRev(it);
                      }));
                      const days = _anaPeriod === 'all' ? null : parseInt(_anaPeriod);
                      const now = Date.now();
                      const rows = [];
                      _anaProds.forEach(p => {
                        const s = sold[p.id]; if (!s || !s.units) return;
                        const stock = (p.product_sizes||[]).reduce((a,x) => a + (x.stock_quantity||0), 0);
                        const baseDays = days || Math.max(1, (now - new Date(p.created_at||now)) / 864e5);
                        const vel = s.units / baseDays;
                        const daysLeft = vel > 0 ? stock / vel : Infinity;
                        rows.push({ title:p.title, units:s.units, rev:s.rev, stock, vel, daysLeft });
                      });
                      rows.sort((a,b) => b.vel - a.vel);
                      return rows;
                    }
                    function anaRenderVelocity() {
                      const el = sectionEl('ana-velocityTable'); if (!el) return;
                      const rows = anaComputeVelocity();
                      if (!rows.length) { el.innerHTML = '<p style="color:var(--text-secondary)">No units sold in this period.</p>'; return; }
                      const fmtLeft = d => !isFinite(d) ? '—' : d > 365 ? '>1yr' : d >= 1 ? Math.round(d)+'d' : '<1d';
                      el.innerHTML = `<table><thead><tr><th>Product</th><th>Units sold</th><th>Units/day</th><th>Stock left</th><th>Days of stock</th></tr></thead><tbody>
                        ${rows.slice(0,20).map(r => {
                          const risk = isFinite(r.daysLeft) && r.daysLeft < 14 && r.stock > 0;
                          const gone = r.stock <= 0;
                          return `<tr>
                            <td style="font-weight:600">${r.title}</td>
                            <td>${r.units}</td>
                            <td>${r.vel.toFixed(2)}</td>
                            <td>${gone ? '<span style="color:#ef4444;font-weight:600">0</span>' : r.stock}</td>
                            <td>${gone ? '<span style="color:#ef4444;font-weight:600">Out</span>' : `<span style="${risk?'color:#f59e0b;font-weight:600':''}">${fmtLeft(r.daysLeft)}</span>`}</td>
                          </tr>`;
                        }).join('')}
                      </tbody></table>`;
                    }
                    window.anaExportVelocity = function() {
                      const rows = anaComputeVelocity();
                      anaExportCSV(`sell_through_${_anaPeriod}_${new Date().toISOString().slice(0,10)}.csv`,
                        ['Product','Units Sold','Units/Day','Stock Left','Days of Stock'],
                        rows.map(r => [r.title, r.units, r.vel.toFixed(2), r.stock, isFinite(r.daysLeft) ? Math.round(r.daysLeft) : 'inf']));
                    };

                    // ── Frequently bought together (product-pair co-occurrence) ──────
                    function anaRenderAffinity() {
                      const el = sectionEl('ana-affinityTable'); if (!el) return;
                      const orders = filteredOrders();
                      const pairs = {};
                      orders.forEach(o => {
                        const keys = [...new Set(parseItems(o).map(itemName))];
                        for (let i=0;i<keys.length;i++) for (let j=i+1;j<keys.length;j++) {
                          const a = keys[i], b = keys[j];
                          const k = a < b ? a+' ||| '+b : b+' ||| '+a;
                          pairs[k] = (pairs[k]||0) + 1;
                        }
                      });
                      const list = Object.entries(pairs).sort((a,b) => b[1]-a[1]).slice(0,10);
                      if (!list.length) { el.innerHTML = '<p style="color:var(--text-secondary)">Not enough multi-product orders yet.</p>'; return; }
                      el.innerHTML = `<table><thead><tr><th>Product pair</th><th>Bought together</th></tr></thead><tbody>
                        ${list.map(([k,n]) => { const [a,b] = k.split(' ||| '); return `<tr><td><strong>${a}</strong> <span style="color:var(--text-secondary)">+</span> <strong>${b}</strong></td><td>${n}×</td></tr>`; }).join('')}
                      </tbody></table>`;
                    }

                    // ── Traffic & conversion (PostHog via server proxy) ──────────────
                    function anaTrafficSetupHTML() {
                      return `<div style="background:var(--bg-secondary);border:1px dashed var(--border-color);border-radius:8px;padding:1.4rem 1.6rem;">
                        <div style="font-weight:600;margin-bottom:.5rem;">Connect PostHog to see traffic &amp; funnel data</div>
                        <p style="color:var(--text-secondary);font-size:.88rem;margin:0 0 .8rem;">Visitors, sessions, top pages, referrers, devices and the view → cart → checkout → purchase funnel show up here once a PostHog personal API key is set. Data is already being collected — this only unlocks reading it.</p>
                        <ol style="color:var(--text-secondary);font-size:.86rem;margin:0 0 .2rem 1.1rem;line-height:1.7;">
                          <li>PostHog → <strong>Settings → Personal API keys</strong> → create a key with <em>Query Read</em> scope.</li>
                          <li>Cloudflare Pages → your project → <strong>Settings → Variables and Secrets</strong> → add <code>POSTHOG_PERSONAL_API_KEY</code> = that key (Production + Preview).</li>
                          <li>Redeploy. This panel fills in automatically.</li>
                        </ol>
                      </div>`;
                    }
                    function anaTrafficHTML(d) {
                      const nf = n => Number(n||0).toLocaleString();
                      const conv = d.funnel.visited ? (d.funnel.purchased / d.funnel.visited * 100) : 0;
                      const steps = [
                        { label:'Visited',        val:d.funnel.visited },
                        { label:'Viewed product', val:d.funnel.viewed },
                        { label:'Added to cart',  val:d.funnel.added },
                        { label:'Checkout',       val:d.funnel.checkout },
                        { label:'Purchased',      val:d.funnel.purchased },
                      ];
                      const base = steps[0].val || 1;
                      const funnelRows = steps.map((s,i) => {
                        const pct = s.val / base * 100;
                        const prev = i > 0 ? steps[i-1].val : null;
                        const drop = (prev && prev > 0) ? ((prev - s.val) / prev * 100) : null;
                        return `<div style="margin-bottom:.6rem;">
                          <div style="display:flex;justify-content:space-between;font-size:.85rem;margin-bottom:.25rem;">
                            <span>${s.label}</span>
                            <span style="color:var(--text-secondary)">${nf(s.val)} · ${pct.toFixed(0)}%${drop!=null?` <span style="color:#ef4444">▼${drop.toFixed(0)}%</span>`:''}</span>
                          </div>
                          <div style="height:10px;background:var(--bg-tertiary,#1a1a1e);border-radius:5px;overflow:hidden;"><div style="height:100%;width:${pct.toFixed(1)}%;background:var(--accent);"></div></div>
                        </div>`;
                      }).join('');
                      const pagesTbl = d.topPages.length ? `<table><thead><tr><th>Page</th><th>Views</th></tr></thead><tbody>${d.topPages.map(p=>`<tr><td style="font-family:'IBM Plex Mono',monospace;font-size:.8rem;word-break:break-all;">${p.path}</td><td>${nf(p.views)}</td></tr>`).join('')}</tbody></table>` : '<p style="color:var(--text-secondary)">No page views yet.</p>';
                      const refsTbl  = d.referrers.length ? `<table><thead><tr><th>Source</th><th>Visitors</th></tr></thead><tbody>${d.referrers.map(x=>`<tr><td style="word-break:break-all;">${x.ref}</td><td>${nf(x.visitors)}</td></tr>`).join('')}</tbody></table>` : '<p style="color:var(--text-secondary)">No referrer data yet.</p>';
                      const devTbl   = d.devices.length ? `<table><thead><tr><th>Device</th><th>Visitors</th></tr></thead><tbody>${d.devices.map(x=>`<tr><td style="text-transform:capitalize">${x.device}</td><td>${nf(x.visitors)}</td></tr>`).join('')}</tbody></table>` : '<p style="color:var(--text-secondary)">No device data yet.</p>';
                      return `
                        <div class="ana-overview-grid" style="margin-bottom:1.4rem;">
                          <div class="ana-card"><div class="ana-card-label">Visitors</div><div class="ana-card-value">${nf(d.totals.visitors)}</div></div>
                          <div class="ana-card"><div class="ana-card-label">Pageviews</div><div class="ana-card-value">${nf(d.totals.pageviews)}</div></div>
                          <div class="ana-card"><div class="ana-card-label">Sessions</div><div class="ana-card-value">${nf(d.totals.sessions)}</div></div>
                          <div class="ana-card"><div class="ana-card-label">Visitor → Purchase</div><div class="ana-card-value">${conv.toFixed(1)}%</div><div class="ana-card-sub">${nf(d.funnel.purchased)} purchased</div></div>
                        </div>
                        <div class="ana-section" style="margin-bottom:1.4rem;">
                          <h2>Conversion Funnel</h2>
                          <p style="font-size:.78rem;color:var(--text-secondary);margin:-.4rem 0 1rem;">Distinct visitors who reached each step in the period.</p>
                          ${funnelRows}
                        </div>
                        <div class="ana-stats-grid">
                          <div class="ana-section" style="margin-bottom:0;"><h2>Top Pages</h2>${pagesTbl}</div>
                          <div class="ana-section" style="margin-bottom:0;"><h2>Traffic Sources</h2>${refsTbl}</div>
                          <div class="ana-section" style="margin-bottom:0;"><h2>Devices</h2>${devTbl}</div>
                        </div>`;
                    }
                    let _anaTrafficBusy = false;
                    async function anaLoadTraffic() {
                      const body = sectionEl('ana-traffic-body'); if (!body) return;
                      if (_anaTrafficBusy) return; _anaTrafficBusy = true;
                      body.className = 'ana-loading'; body.textContent = 'Loading traffic…';
                      const days = _anaPeriod === 'all' ? 365 : parseInt(_anaPeriod);
                      let token = '';
                      try { const s = await sb.auth.getSession(); token = s && s.data && s.data.session && s.data.session.access_token || ''; } catch(_) {}
                      try {
                        const r = await fetch(`/api/posthog-summary?range=${days}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
                        const d = await r.json().catch(() => ({}));
                        body.className = '';
                        if (!d.ok) { body.innerHTML = `<div class="ana-err">Traffic data unavailable: ${d.error || ('HTTP ' + r.status)}</div>`; return; }
                        if (!d.configured) { body.innerHTML = anaTrafficSetupHTML(); return; }
                        body.innerHTML = anaTrafficHTML(d);
                      } catch (e) {
                        body.className = '';
                        body.innerHTML = `<div class="ana-err">Could not reach the analytics service: ${e.message}</div>`;
                      } finally { _anaTrafficBusy = false; }
                    }

                    // Re-run all period-dependent views without refetching
                    function anaRefreshViews() {
                      anaUpdateOrders();
                      anaUpdateCharts();
                      anaUpdateInvStats();
                      anaRenderTiming();
                      anaRenderCohorts();
                      anaRenderDiscount();
                      anaRenderCategory();
                      anaRenderVelocity();
                      anaRenderAffinity();
                      anaLoadTraffic();
                    }

                    function anaUpdateCharts() {
                      // Status chart
                      const statuses = { draft:0, coming_soon:0, live:0, sold_out:0 };
                      _anaProds.forEach(p => { const k=(p.status||'draft').toLowerCase().replace(/\s/g,'_'); if(k in statuses) statuses[k]++; });
                      anaBarChart('ana-statusChart', [
                        {key:'draft',label:'Draft',val:statuses.draft},
                        {key:'coming_soon',label:'Coming Soon',val:statuses.coming_soon},
                        {key:'live',label:'Live',val:statuses.live},
                        {key:'sold_out',label:'Sold Out',val:statuses.sold_out}
                      ], { draft:'bar-draft', coming_soon:'bar-coming', live:'bar-live', sold_out:'bar-sold' });

                      // Gender chart
                      const genders = { men:0, women:0, unisex:0, kids:0 };
                      _anaProds.forEach(p => { const k=(p.gender||'').toLowerCase(); if(k in genders) genders[k]++; });
                      anaBarChart('ana-genderChart', [
                        {key:'men',label:'Men',val:genders.men},
                        {key:'women',label:'Women',val:genders.women},
                        {key:'unisex',label:'Unisex',val:genders.unisex},
                        {key:'kids',label:'Kids',val:genders.kids}
                      ], { men:'bar-men', women:'bar-women', unisex:'bar-unisex', kids:'bar-kids' });

                      // Revenue timeline (respects period)
                      const rc = sectionEl('ana-revenueChart');
                      const periodOrders = filteredOrders();
                      if (!periodOrders.length) { rc.innerHTML = '<p style="color:var(--text-secondary);padding:2rem;">No sales data yet.</p>'; return; }
                      const byDate = {};
                      periodOrders.forEach(o => {
                        const d = new Date(o.created_at).toLocaleDateString(undefined,{month:'numeric',day:'numeric'});
                        byDate[d] = (byDate[d]||0) + orderTotal(o);
                      });
                      const maxBars = _anaPeriod==='7d'?7:_anaPeriod==='30d'?14:_anaPeriod==='90d'?18:20;
                      const dates = Object.keys(byDate).sort((a,b)=>new Date(a)-new Date(b)).slice(-maxBars);
                      const maxRev = Math.max(...dates.map(d=>byDate[d]),1);
                      rc.innerHTML = '';
                      dates.forEach(d => {
                        const pct=(byDate[d]/maxRev)*100;
                        const item=document.createElement('div'); item.className='ana-bar-item';
                        item.innerHTML=`<div class="ana-bar" style="height:${pct}%;background:var(--accent)"><div class="ana-bar-val">$${Math.round(byDate[d])}</div></div><div class="ana-bar-label" style="font-size:.72rem">${d}</div>`;
                        rc.appendChild(item);
                      });
                    }

                    function anaUpdatePrices() {
                      const m=_anaProds.filter(p=>Number(p.msrp)>0), cp=_anaProds.filter(p=>Number(p.current_price)>0), mp=_anaProds.filter(p=>Number(p.member_price)>0);
                      const avg=(arr,key)=>arr.length?arr.reduce((s,p)=>s+Number(p[key]),0)/arr.length:0;
                      const onSale=_anaProds.filter(p=>Number(p.current_price)<Number(p.msrp)).length;
                      const saleProd=_anaProds.filter(p=>Number(p.msrp)>Number(p.current_price)&&Number(p.current_price)>0);
                      const disc=saleProd.length?saleProd.reduce((s,p)=>s+((Number(p.msrp)-Number(p.current_price))/Number(p.msrp)*100),0)/saleProd.length:0;
                      sectionEl('ana-avgMSRP').textContent=`$${avg(m,'msrp').toFixed(2)}`;
                      sectionEl('ana-avgCurrentPrice').textContent=`$${avg(cp,'current_price').toFixed(2)}`;
                      sectionEl('ana-avgMemberPrice').textContent=`$${avg(mp,'member_price').toFixed(2)}`;
                      sectionEl('ana-productsOnSale').textContent=onSale;
                      sectionEl('ana-salePercentage').textContent=`${_anaProds.length?((onSale/_anaProds.length)*100).toFixed(1):0}%`;
                      sectionEl('ana-avgDiscount').textContent=`${disc.toFixed(1)}%`;
                    }

                    async function anaUpdateReviews() {
                      try {
                        const { data: reviews } = await sb.from('reviews').select('rating, product_id');
                        const byProd = {}; const ratings = [];
                        (reviews||[]).forEach(r => { if(!byProd[r.product_id]) byProd[r.product_id]=[]; byProd[r.product_id].push(r); if(r.rating) ratings.push(r.rating); });
                        const avg = ratings.length?(ratings.reduce((a,b)=>a+b,0)/ratings.length).toFixed(2):0;
                        sectionEl('ana-avgRating').textContent=`${avg} ⭐`;
                        sectionEl('ana-totalReviews').textContent=reviews?.length||0;
                        sectionEl('ana-noReviewsCount').textContent=_anaProds.filter(p=>!byProd[p.id]).length;
                        const top=_anaProds.filter(p=>byProd[p.id]).map(p=>{
                          const rs=byProd[p.id]; const ar=rs.reduce((s,r)=>s+(r.rating||0),0)/rs.length;
                          return {...p,avgRating:ar,reviewCount:rs.length};
                        }).sort((a,b)=>b.avgRating-a.avgRating).slice(0,5);
                        sectionEl('ana-topProducts').innerHTML=top.length
                          ?top.map(p=>`<div class="ana-prod-card"><div class="ana-prod-title">${p.title}</div><div>${'⭐'.repeat(Math.round(p.avgRating))} ${p.avgRating.toFixed(1)}</div><div style="color:var(--text-secondary);font-size:.82rem">${p.reviewCount} reviews</div></div>`).join('')
                          :'<p style="color:var(--text-secondary)">No reviews yet.</p>';
                      } catch(e) {
                        sectionEl('ana-avgRating').textContent='—'; sectionEl('ana-totalReviews').textContent='—';
                        sectionEl('ana-noReviewsCount').textContent='—';
                      }
                    }

                    // ── Stock level helpers ──
                    function _invLevel(stock, thresh) {
                      if (stock <= 0) return 'out';
                      if (stock <= 3) return 'critical';
                      if (stock <= thresh) return 'low';
                      return 'ok';
                    }
                    const _invLvlLabel = { out:'Out', critical:'Critical', low:'Low', ok:'In Stock' };

                    function anaUpdateInvStats() {
                      let total=0, ok=0, low=0, crit=0, out=0;
                      _anaProds.forEach(p => {
                        const thresh = p.low_stock_threshold || 10;
                        (p.product_sizes||[]).forEach(s => {
                          const q = s.stock_quantity||0;
                          total += q;
                          const lv = _invLevel(q, thresh);
                          if (lv==='ok') ok++; else if (lv==='low') low++; else if (lv==='critical') crit++; else out++;
                        });
                      });
                      const set = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=v; };
                      set('inv-total',total); set('inv-ok',ok); set('inv-low',low); set('inv-crit',crit); set('inv-out',out);
                    }

                    async function anaInlineStockSave(sizeId, td, newVal) {
                      const num = parseInt(newVal, 10);
                      if (isNaN(num) || num < 0) { td.textContent = td.dataset.origStock; return; }
                      const prev = parseInt(td.dataset.origStock, 10) || 0;
                      td.style.opacity = '.45'; td.textContent = '…';
                      const { error } = await sb.from('product_sizes').update({ stock_quantity: num }).eq('id', sizeId);
                      if (error) { td.style.opacity=''; td.textContent = td.dataset.origStock; typeof notifyAdmin!=='undefined' && notifyAdmin('Stock update failed: ' + error.message, 'error'); return; }
                      td.dataset.origStock = String(num);
                      td.style.opacity = '';
                      // Update local state
                      _anaProds.forEach(p => { const s=(p.product_sizes||[]).find(s=>s.id===sizeId); if(s) s.stock_quantity=num; });
                      // Audit log
                      try { await logAdminAudit('inventory.edit','product_sizes',sizeId,{from:prev,to:num}); } catch(_){}
                      anaRenderInventory();
                    }

                    function anaStockCellClick(td, sizeId, currentStock) {
                      if (td.querySelector('input')) return;
                      td.dataset.origStock = String(currentStock);
                      const inp = document.createElement('input');
                      inp.type='number'; inp.min='0'; inp.value=currentStock;
                      inp.style.cssText='width:64px;background:var(--bg-secondary);border:1px solid var(--accent);border-radius:4px;padding:3px 6px;color:var(--text-primary);font-size:.85rem;text-align:center;';
                      td.textContent=''; td.appendChild(inp);
                      inp.focus(); inp.select();
                      const commit=()=>anaInlineStockSave(sizeId,td,inp.value);
                      inp.addEventListener('blur',commit);
                      inp.addEventListener('keydown',e=>{
                        if(e.key==='Enter'){e.preventDefault();inp.blur();}
                        if(e.key==='Escape'){td.textContent=currentStock;}
                      });
                    }

                    function anaRenderInventory() {
                      const search=(document.getElementById('ana-invSearch')?.value||'').toLowerCase();
                      let rows=[];
                      _anaProds.forEach(p=>{
                        const sizes=p.product_sizes||[];
                        const thresh=p.low_stock_threshold||10;
                        if(!sizes.length){ rows.push({title:p.title,sku:p.sku,size:'—',stock:0,thresh,status:p.status,sizeId:null}); }
                        else sizes.forEach(s=>rows.push({title:p.title,sku:p.sku,size:s.size,stock:s.stock_quantity||0,thresh,status:p.status,sizeId:s.id}));
                      });
                      // filter
                      if(_anaInvFilter==='in') rows=rows.filter(r=>r.stock>r.thresh);
                      else if(_anaInvFilter==='low') rows=rows.filter(r=>r.stock>3&&r.stock<=r.thresh);
                      else if(_anaInvFilter==='critical') rows=rows.filter(r=>r.stock>0&&r.stock<=3);
                      else if(_anaInvFilter==='out') rows=rows.filter(r=>r.stock<=0);
                      if(search) rows=rows.filter(r=>String(r.sku||'').toLowerCase().includes(search)||String(r.title||'').toLowerCase().includes(search)||String(r.size||'').toLowerCase().includes(search));
                      rows.sort((a,b)=>{
                        const av=a[_anaInvSort.key],bv=b[_anaInvSort.key];
                        if(typeof av==='string') return _anaInvSort.dir==='asc'?String(av).localeCompare(String(bv)):String(bv).localeCompare(String(av));
                        return _anaInvSort.dir==='asc'?av-bv:bv-av;
                      });
                      anaUpdateInvStats();
                      const c=document.getElementById('ana-inventoryTable');
                      if(!rows.length){c.innerHTML='<p style="color:var(--text-secondary);padding:1.5rem 0;">No records found.</p>';return;}
                      const arr=k=>_anaInvSort.key===k?(_anaInvSort.dir==='asc'?' ↑':' ↓'):'';
                      c.innerHTML=`<table><thead><tr>
                        <th data-ana-inv-key="title">Product${arr('title')}</th>
                        <th data-ana-inv-key="sku">SKU${arr('sku')}</th>
                        <th data-ana-inv-key="size">Size${arr('size')}</th>
                        <th data-ana-inv-key="stock">Stock ✎${arr('stock')}</th>
                        <th>Level</th>
                        <th data-ana-inv-key="status">Status${arr('status')}</th>
                      </tr></thead><tbody>
                      ${rows.map((r,i)=>{
                        const lv=_invLevel(r.stock,r.thresh);
                        return `<tr>
                          <td>${r.title}</td>
                          <td style="font-family:'IBM Plex Mono',monospace;font-size:.8rem">${r.sku}</td>
                          <td>${r.size}</td>
                          <td data-inv-row="${i}" style="${r.sizeId?'cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;':''}" title="${r.sizeId?'Click to edit':''}"><strong>${r.stock}</strong></td>
                          <td><span class="inv-lvl-${lv}">${_invLvlLabel[lv]}</span></td>
                          <td><span class="ana-status-badge badge-${(r.status||'draft').toLowerCase().replace(/\s+/g,'-')}">${r.status}</span></td>
                        </tr>`;
                      }).join('')}
                      </tbody></table>`;
                      c.querySelectorAll('[data-ana-inv-key]').forEach(th=>{
                        th.addEventListener('click',()=>{
                          const k=th.dataset.anaInvKey;
                          _anaInvSort.dir=_anaInvSort.key===k?(_anaInvSort.dir==='asc'?'desc':'asc'):'asc';
                          _anaInvSort.key=k; anaRenderInventory();
                        });
                      });
                      c.querySelectorAll('[data-inv-row]').forEach(td=>{
                        const i=parseInt(td.dataset.invRow,10),r=rows[i];
                        if(!r?.sizeId) return;
                        td.addEventListener('click',()=>anaStockCellClick(td,r.sizeId,r.stock));
                      });
                    }

                    function anaOpenBulkAdjust() {
                      const products=_anaProds.filter(p=>(p.product_sizes||[]).length>0);
                      if(!products.length){typeof notifyAdmin!=='undefined'&&notifyAdmin('No products with sizes found.','error');return;}
                      const overlay=document.createElement('div');
                      overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:9999;display:flex;align-items:center;justify-content:center;';
                      overlay.innerHTML=`<div style="background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:8px;padding:2rem;width:min(480px,92vw);max-height:82vh;overflow-y:auto;">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.4rem;">
                          <h3 style="font-family:'Barlow Condensed',sans-serif;font-size:1.3rem;letter-spacing:.06em;margin:0;">Bulk Stock Adjust</h3>
                          <button id="ba-close" style="background:none;border:none;color:var(--text-secondary);font-size:1.5rem;cursor:pointer;line-height:1;padding:0 4px;">×</button>
                        </div>
                        <label style="font-size:.75rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:.35rem;">Product</label>
                        <select id="ba-prod" style="width:100%;background:var(--bg-primary);border:1px solid var(--border-color);color:var(--text-primary);padding:.5rem .7rem;border-radius:4px;font-size:.88rem;margin-bottom:1rem;">
                          <option value="">— Select product —</option>
                          ${products.map(p=>`<option value="${p.id}">${p.title} (${(p.product_sizes||[]).length} sizes)</option>`).join('')}
                        </select>
                        <label style="font-size:.75rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:.35rem;">Mode</label>
                        <div style="display:flex;gap:.5rem;margin-bottom:1rem;">
                          <button class="ba-mode" data-m="set" style="flex:1;padding:.5rem;border-radius:4px;cursor:pointer;border:1px solid var(--accent);background:var(--accent);color:#09090b;font-size:.85rem;font-weight:600;">Set all to</button>
                          <button class="ba-mode" data-m="add" style="flex:1;padding:.5rem;border-radius:4px;cursor:pointer;border:1px solid var(--border-color);background:none;color:var(--text-primary);font-size:.85rem;">Add / subtract</button>
                        </div>
                        <label id="ba-val-lbl" style="font-size:.75rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:.35rem;">Set all sizes to</label>
                        <input id="ba-val" type="number" value="0" style="width:100%;background:var(--bg-primary);border:1px solid var(--border-color);color:var(--text-primary);padding:.55rem;border-radius:4px;font-size:1.1rem;text-align:center;margin-bottom:1rem;">
                        <div id="ba-preview" style="background:var(--bg-primary);border:1px solid var(--border-color);border-radius:4px;padding:.75rem;margin-bottom:1rem;font-size:.82rem;color:var(--text-secondary);min-height:42px;max-height:180px;overflow-y:auto;">Select a product above to preview.</div>
                        <button id="ba-apply" style="width:100%;background:var(--accent);border:none;color:#09090b;padding:.8rem;border-radius:4px;font-weight:700;font-size:.95rem;cursor:pointer;">Apply to All Sizes</button>
                      </div>`;
                      document.body.appendChild(overlay);
                      let baMode='set';
                      const close=()=>overlay.remove();
                      overlay.querySelector('#ba-close').onclick=close;
                      overlay.onclick=e=>{if(e.target===overlay)close();};
                      overlay.querySelectorAll('.ba-mode').forEach(btn=>{
                        btn.onclick=()=>{
                          baMode=btn.dataset.m;
                          overlay.querySelectorAll('.ba-mode').forEach(b=>{
                            const on=b===btn;
                            b.style.background=on?'var(--accent)':'none';
                            b.style.color=on?'#09090b':'var(--text-primary)';
                            b.style.borderColor=on?'var(--accent)':'var(--border-color)';
                            b.style.fontWeight=on?'600':'400';
                          });
                          overlay.querySelector('#ba-val-lbl').textContent=baMode==='set'?'Set all sizes to':'Adjust all sizes by (use negative to subtract)';
                          updatePreview();
                        };
                      });
                      function updatePreview(){
                        const pid=overlay.querySelector('#ba-prod').value;
                        const val=parseInt(overlay.querySelector('#ba-val').value,10)||0;
                        const p=_anaProds.find(x=>x.id===pid);
                        const pv=overlay.querySelector('#ba-preview');
                        if(!p){pv.textContent='Select a product above to preview.';return;}
                        const sizes=p.product_sizes||[];
                        if(!sizes.length){pv.textContent='No sizes on this product.';return;}
                        pv.innerHTML=sizes.map(s=>{
                          const curr=s.stock_quantity||0;
                          const next=Math.max(0,baMode==='set'?val:curr+val);
                          const arrow=curr!==next?` → <strong style="color:${next>curr?'#10b981':'#ef4444'}">${next}</strong>`:`→ ${next}`;
                          return `<div style="padding:.18rem 0;border-bottom:1px solid var(--border-color);">${s.size}: <span style="color:var(--text-primary)">${curr}</span> ${arrow}</div>`;
                        }).join('');
                      }
                      overlay.querySelector('#ba-prod').addEventListener('change',updatePreview);
                      overlay.querySelector('#ba-val').addEventListener('input',updatePreview);
                      overlay.querySelector('#ba-apply').onclick=async()=>{
                        const pid=overlay.querySelector('#ba-prod').value;
                        const val=parseInt(overlay.querySelector('#ba-val').value,10);
                        if(!pid||isNaN(val)) return;
                        const p=_anaProds.find(x=>x.id===pid);
                        if(!p?.product_sizes?.length) return;
                        const applyBtn=overlay.querySelector('#ba-apply');
                        applyBtn.textContent='Saving…'; applyBtn.disabled=true;
                        let errored=false;
                        for(const s of p.product_sizes){
                          const curr=s.stock_quantity||0;
                          const next=Math.max(0,baMode==='set'?val:curr+val);
                          const {error}=await sb.from('product_sizes').update({stock_quantity:next}).eq('id',s.id);
                          if(error){errored=true;break;}
                          s.stock_quantity=next;
                          try{await logAdminAudit('inventory.bulk','product_sizes',s.id,{from:curr,to:next});}catch(_){}
                        }
                        if(!errored){applyBtn.textContent='Done ✓';setTimeout(()=>{close();anaRenderInventory();},700);}
                        else{applyBtn.textContent='Some failed';applyBtn.disabled=false;}
                      };
                    }

                    function anaRenderCatalog() {
                      const search=(sectionEl('ana-catSearch')?.value||'').toLowerCase();
                      let rows=_anaProds.map(p=>({
                        id:p.id,sku:p.sku,title:p.title,gender:p.gender||'N/A',colorway:p.colorway||'N/A',
                        msrp:Number(p.msrp)||0,currentPrice:Number(p.current_price)||0,status:p.status,
                        totalStock:(p.product_sizes||[]).reduce((s,i)=>s+(i.stock_quantity||0),0),
                        colorCount:p.color_variants?.length||0, imageCount:p.product_images?.length||0
                      }));
                      if(search) rows=rows.filter(r=>String(r.sku||'').toLowerCase().includes(search)||String(r.title||'').toLowerCase().includes(search)||String(r.colorway||'').toLowerCase().includes(search));
                      rows.sort((a,b)=>{
                        const av=a[_anaCatSort.key],bv=b[_anaCatSort.key];
                        if(typeof av==='string') return _anaCatSort.dir==='asc'?String(av).localeCompare(String(bv)):String(bv).localeCompare(String(av));
                        return _anaCatSort.dir==='asc'?av-bv:bv-av;
                      });
                      const c=sectionEl('ana-catalogTable');
                      if(!rows.length){c.innerHTML='<p style="color:var(--text-secondary);padding:1.5rem 0;">No products found.</p>';return;}
                      c.innerHTML=`<table><thead><tr>
                        <th data-ana-cat-key="sku">SKU</th><th data-ana-cat-key="title">Title</th>
                        <th data-ana-cat-key="gender">Gender</th><th data-ana-cat-key="colorway">Colorway</th>
                        <th data-ana-cat-key="msrp">MSRP</th><th data-ana-cat-key="currentPrice">Price</th>
                        <th data-ana-cat-key="status">Status</th><th data-ana-cat-key="totalStock">Stock</th>
                        <th data-ana-cat-key="colorCount">Colors</th><th data-ana-cat-key="imageCount">Images</th>
                      </tr></thead><tbody>
                        ${rows.map(r=>`<tr>
                          <td>${r.sku}</td><td>${r.title}</td><td>${r.gender}</td><td>${r.colorway}</td>
                          <td>$${r.msrp.toFixed(2)}</td><td>$${r.currentPrice.toFixed(2)}</td>
                          <td><span class="ana-status-badge badge-${(r.status||'draft').toLowerCase().replace(/\s+/g,'-')}">${r.status}</span></td>
                          <td>${r.totalStock}</td><td>${r.colorCount}</td><td>${r.imageCount}</td>
                        </tr>`).join('')}
                      </tbody></table>`;
                      c.querySelectorAll('[data-ana-cat-key]').forEach(th=>{
                        th.addEventListener('click',()=>{
                          const k=th.dataset.anaCatKey;
                          _anaCatSort.dir=_anaCatSort.key===k?(_anaCatSort.dir==='asc'?'desc':'asc'):'asc';
                          _anaCatSort.key=k; anaRenderCatalog();
                        });
                      });
                    }

                    // ── Search listeners ──
                    document.getElementById('ana-invSearch').addEventListener('input', anaRenderInventory);
                    document.getElementById('ana-catSearch').addEventListener('input', anaRenderCatalog);

                    // ── Inventory filter buttons ──
                    document.querySelectorAll('[data-ana-filter]').forEach(btn=>{
                      btn.addEventListener('click',e=>{
                        document.querySelectorAll('[data-ana-filter]').forEach(b=>b.classList.remove('active'));
                        e.target.classList.add('active');
                        _anaInvFilter=e.target.dataset.anaFilter;
                        anaRenderInventory();
                      });
                    });

                    // ── Bulk Adjust ──
                    document.getElementById('inv-bulk-btn').addEventListener('click', anaOpenBulkAdjust);

                    // ── Inventory CSV Export (per-size with level) ──
                    document.getElementById('inv-export-btn').addEventListener('click',()=>{
                      const rows=[];
                      _anaProds.forEach(p=>{
                        const thresh=p.low_stock_threshold||10;
                        const sizes=p.product_sizes||[];
                        if(!sizes.length){rows.push({sku:p.sku,title:p.title,status:p.status,size:'N/A',stock:0,level:'Out'});}
                        else sizes.forEach(s=>{
                          const q=s.stock_quantity||0;
                          rows.push({sku:p.sku,title:p.title,status:p.status,size:s.size,stock:q,level:_invLvlLabel[_invLevel(q,thresh)]});
                        });
                      });
                      const hdrs=['SKU','Product','Status','Size','Stock','Level'];
                      const csv=hdrs.join(',')+'\n'+rows.map(r=>[r.sku,r.title,r.status,r.size,r.stock,r.level].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
                      const a=document.createElement('a');
                      a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
                      a.download=`zuwera-inventory-${new Date().toISOString().split('T')[0]}.csv`;
                      a.click();
                    });

                    // ── Catalog CSV Export ──
                    document.getElementById('ana-exportBtn').addEventListener('click',()=>{
                      const rows=_anaProds.map(p=>({
                        sku:p.sku,title:p.title,gender:p.gender||'N/A',colorway:p.colorway||'N/A',
                        msrp:Number(p.msrp)||0,price:Number(p.current_price)||0,status:p.status,
                        stock:(p.product_sizes||[]).reduce((s,i)=>s+(i.stock_quantity||0),0),
                        colors:p.color_variants?.length||0,images:p.product_images?.length||0
                      }));
                      const hdrs=['SKU','Title','Gender','Colorway','MSRP','Current Price','Status','Stock','Colors','Images'];
                      let csv=hdrs.join(',')+'\n'+rows.map(r=>[r.sku,r.title,r.gender,r.colorway,r.msrp,r.price,r.status,r.stock,r.colors,r.images].map(v=>`"${v}"`).join(',')).join('\n');
                      const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
                      a.download=`zuwera-catalog-${new Date().toISOString().split('T')[0]}.csv`; a.click();
                    });

                    // ── Main load ──
                    window.anaLoadData = async function() {
                      sectionEl('ana-error-container').innerHTML='';
                      try {
                        await anaLoadProds();
                        await Promise.all([anaLoadOrders(), anaLoadEngagement()]);
                        anaUpdateCards(); anaUpdateOrders(); anaUpdateCharts();
                        anaUpdatePrices(); anaUpdateInvStats(); anaRenderInventory(); anaRenderCatalog();
                        anaRenderTiming(); anaRenderCohorts(); anaRenderDiscount();
                        anaRenderCategory(); anaRenderVelocity(); anaRenderAffinity();
                        anaRenderToday(); anaStartTodayAutoRefresh();
                        anaLoadTraffic();
                        await anaUpdateReviews();
                        _anaLoaded=true;
                      } catch(e) { anaErr('Failed to load analytics: '+e.message); }
                    };

                    // Expose for the tab switch handler
                    window._anaLoaded = () => _anaLoaded;
                  })();
