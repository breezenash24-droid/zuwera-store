                  (function() {
                    let _taxLoaded = false;
                    let _taxOrders  = [];

                    // ── Rate tables (mirror of checkout-tax.js) ───────────────────────
                    const FLAT = { KY: 0.06, IN: 0.07 };

                    const OH_COUNTY = {
                      Adams:0.0725,Allen:0.0675,Ashland:0.07,Ashtabula:0.07,Athens:0.07,
                      Auglaize:0.0725,Belmont:0.0725,Brown:0.0725,Butler:0.07,Carroll:0.0725,
                      Champaign:0.0725,Clark:0.0725,Clermont:0.07,Clinton:0.0725,Columbiana:0.0725,
                      Coshocton:0.0725,Crawford:0.0725,Cuyahoga:0.08,Darke:0.0725,Defiance:0.0725,
                      Delaware:0.07,Erie:0.0675,Fairfield:0.0675,Fayette:0.0725,Franklin:0.075,
                      Fulton:0.0725,Gallia:0.0725,Geauga:0.07,Greene:0.0675,Guernsey:0.0725,
                      Hamilton:0.07,Hancock:0.0675,Hardin:0.0725,Harrison:0.0725,Henry:0.0725,
                      Highland:0.0725,Hocking:0.0725,Holmes:0.0725,Huron:0.0725,Jackson:0.0725,
                      Jefferson:0.0725,Knox:0.0725,Lake:0.0725,Lawrence:0.0725,Licking:0.0725,
                      Logan:0.0725,Lorain:0.065,Lucas:0.0725,Madison:0.07,Mahoning:0.0725,
                      Marion:0.0725,Medina:0.0675,Meigs:0.0725,Mercer:0.0725,Miami:0.0675,
                      Monroe:0.0725,Montgomery:0.075,Morgan:0.0725,Morrow:0.0725,Muskingum:0.0725,
                      Noble:0.0725,Ottawa:0.07,Paulding:0.0725,Perry:0.0725,Pickaway:0.0725,
                      Pike:0.0725,Portage:0.0725,Preble:0.07,Putnam:0.0725,Richland:0.0725,
                      Ross:0.0725,Sandusky:0.0725,Scioto:0.0725,Seneca:0.0725,Shelby:0.0725,
                      Stark:0.065,Summit:0.0675,Trumbull:0.0725,Tuscarawas:0.0725,Union:0.07,
                      VanWert:0.0725,Vinton:0.0725,Warren:0.0675,Washington:0.0725,Wayne:0.0675,
                      Williams:0.0725,Wood:0.0675,Wyandot:0.0725,
                    };

                    const OH_ZIP3 = {
                      '430':'Franklin','431':'Franklin','432':'Franklin','433':'Marion','434':'Wood',
                      '435':'Defiance','436':'Lucas','437':'Muskingum','438':'Coshocton',
                      '440':'Lorain','441':'Cuyahoga','442':'Summit','443':'Summit',
                      '444':'Mahoning','445':'Mahoning','446':'Stark','447':'Stark','448':'Stark',
                      '449':'Richland',
                      '450':'Hamilton','451':'Clermont','452':'Hamilton','453':'Miami','454':'Montgomery',
                      '455':'Clark','456':'Ross','457':'Athens','458':'Allen','459':'Allen',
                    };

                    const IL_ZIP3 = {
                      '600':0.0825,'601':0.0725,'602':0.0725,'603':0.07,'604':0.0825,'605':0.0725,
                      '606':0.1025,'607':0.1025,'608':0.0825,'609':0.075,
                      '610':0.0825,'611':0.08,'612':0.0825,'613':0.0625,'614':0.085,'615':0.085,
                      '616':0.0825,'617':0.0625,'618':0.0725,'619':0.0725,
                      '620':0.0835,'621':0.0725,'622':0.0625,'623':0.085,'624':0.085,'625':0.09,
                      '626':0.085,'627':0.085,'628':0.0625,'629':0.0725,
                    };

                    const STATE_RATES = {
                      AL:0.04,AK:0,AZ:0.056,AR:0.065,CA:0.0725,CO:0.029,CT:0.0635,DE:0,
                      FL:0.06,GA:0.04,HI:0.04,ID:0.06,IL:0.0625,IN:0.07,IA:0.06,KS:0.065,
                      KY:0.06,LA:0.05,ME:0.055,MD:0.06,MA:0.0625,MI:0.06,MN:0.06875,
                      MS:0.07,MO:0.04225,MT:0,NE:0.055,NV:0.0685,NH:0,NJ:0.06625,
                      NM:0.05125,NY:0.04,NC:0.0475,ND:0.05,OH:0.0575,OK:0.045,OR:0,
                      PA:0.06,RI:0.07,SC:0.06,SD:0.042,TN:0.07,TX:0.0625,UT:0.061,
                      VT:0.06,VA:0.053,WA:0.065,WV:0.06,WI:0.05,WY:0.04,DC:0.06,
                    };

                    const STATE_NAMES = {
                      AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',
                      CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',
                      HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',
                      KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',
                      MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',
                      MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',
                      NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',
                      OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',
                      SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',
                      VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',
                      WY:'Wyoming',DC:'D.C.',
                    };

                    const NO_TAX = new Set(['AK','DE','MT','NH','OR']);

                    function getConfiguredRate(state, zip) {
                      const s = (state||'').toUpperCase().slice(0,2);
                      if (!s) return 0;
                      if (FLAT[s] !== undefined) return FLAT[s];
                      const z = String(zip||'').replace(/\D/g,'');
                      if (s === 'OH' && z.length >= 3) {
                        const county = OH_ZIP3[z.slice(0,3)];
                        return (county && OH_COUNTY[county]) ? OH_COUNTY[county] : 0.0725;
                      }
                      if (s === 'IL' && z.length >= 3) return IL_ZIP3[z.slice(0,3)] ?? 0.0625;
                      return STATE_RATES[s] || 0;
                    }

                    function fmtPct(r) { return (r*100).toFixed(2) + '%'; }

                    function taxErr(msg) {
                      const el = document.getElementById('tax-error');
                      if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
                    }

                    // ── Filing Calendar ───────────────────────────────────────────────
                    function buildCalendar() {
                      const now  = new Date();
                      const year = now.getFullYear();
                      const quarters = [
                        { q:'Q1', period:`Jan–Mar ${year}`,   due: new Date(year,3,23) },
                        { q:'Q2', period:`Apr–Jun ${year}`,   due: new Date(year,6,23) },
                        { q:'Q3', period:`Jul–Sep ${year}`,   due: new Date(year,9,23) },
                        { q:'Q4', period:`Oct–Dec ${year}`,   due: new Date(year+1,0,23) },
                      ];
                      const fmtDate = d => d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
                      const tb = document.getElementById('tax-calendar-tbody');
                      if (!tb) return;
                      tb.innerHTML = quarters.map(q => {
                        const daysLeft = Math.round((q.due - now) / 86400000);
                        let status, color;
                        if (daysLeft < 0)         { status = 'Past due — file ASAP'; color = '#ef4444'; }
                        else if (daysLeft === 0)   { status = 'Due today'; color = '#f59e0b'; }
                        else if (daysLeft <= 14)   { status = `Due in ${daysLeft} days`; color = '#f59e0b'; }
                        else if (daysLeft <= 45)   { status = `${daysLeft} days away`; color = '#34d399'; }
                        else                       { status = 'Upcoming'; color = 'var(--text-secondary)'; }
                        return `<tr class="zw-divider">
                          <td style="padding:10px 0;font-weight:600;">${q.q}</td>
                          <td style="padding:10px 0;color:var(--text-secondary);">${q.period}</td>
                          <td style="padding:10px 0;">${fmtDate(q.due)}</td>
                          <td style="padding:10px 0;color:${color};font-size:12px;">${status}</td>
                        </tr>`;
                      }).join('');

                      // Filing alert banner
                      const upcoming = quarters.find(q => { const d=Math.round((q.due-now)/86400000); return d>=0&&d<=21; });
                      const overdue  = quarters.find(q => Math.round((q.due-now)/86400000) < 0 && Math.round((q.due-now)/86400000) > -60);
                      const alert    = document.getElementById('tax-filing-alert');
                      if (alert) {
                        if (overdue) {
                          alert.style.display = 'block';
                          alert.style.background = '#2a1a1a';
                          alert.style.border = '1px solid #ef4444';
                          alert.style.color = '#ef4444';
                          alert.innerHTML = `⚠️ Ohio ${overdue.q} filing (${overdue.period}) appears overdue. File your UST-1 at <b>tax.ohio.gov</b> as soon as possible.`;
                        } else if (upcoming) {
                          alert.style.display = 'block';
                          alert.style.background = 'rgba(245,158,11,.08)';
                          alert.style.border = '1px solid #f59e0b';
                          alert.style.color = '#f59e0b';
                          const d = Math.round((upcoming.due-now)/86400000);
                          alert.innerHTML = `📅 Ohio ${upcoming.q} filing due in <b>${d} day${d===1?'':'s'}</b> (${fmtDate(upcoming.due)}). File UST-1 at <b>tax.ohio.gov</b>.`;
                        } else {
                          alert.style.display = 'none';
                        }
                      }
                    }

                    // ── Rate Lookup ───────────────────────────────────────────────────
                    window.taxDoLookup = function() {
                      const state = (document.getElementById('tax-lkp-state').value||'').trim().toUpperCase();
                      const zip   = (document.getElementById('tax-lkp-zip').value||'').trim();
                      const el    = document.getElementById('tax-lkp-result');
                      if (!el) return;
                      if (!state) { el.innerHTML = '<p style="color:#f87171;font-size:13px;">Enter a state code.</p>'; return; }
                      if (NO_TAX.has(state)) {
                        el.innerHTML = `<div style="padding:14px;background:var(--bg-primary);border-radius:8px;font-size:13px;"><b>${STATE_NAMES[state]||state}</b> has no state sales tax.</div>`;
                        return;
                      }
                      const rate   = getConfiguredRate(state, zip);
                      const isFlat = FLAT[state] !== undefined;
                      let county   = '';
                      if (state === 'OH' && zip.length >= 3) county = OH_ZIP3[zip.slice(0,3)] || 'Unknown (defaulting to 7.25%)';
                      if (state === 'IL' && zip.length >= 3) county = `ZIP prefix ${zip.slice(0,3)}`;
                      el.innerHTML = `<div style="padding:14px;background:var(--bg-primary);border-radius:8px;font-size:13px;line-height:1.8;">
                        <div style="font-size:24px;font-weight:700;color:var(--accent);margin-bottom:4px;">${fmtPct(rate)}</div>
                        <div><b>${STATE_NAMES[state]||state}</b>${county ? ' · ' + county + ' County' : ''}</div>
                        ${isFlat ? `<div style="color:var(--text-secondary);font-size:12px;">Flat statewide rate — ZIP has no effect.</div>` : ''}
                        ${state==='OH'&&!county ? `<div style="color:#f59e0b;font-size:12px;">ZIP prefix not mapped — using 7.25% default.</div>` : ''}
                      </div>`;
                    };
                    document.getElementById('tax-lkp-zip')?.addEventListener('keydown', e => { if(e.key==='Enter') taxDoLookup(); });

                    // ── Rate Reference Tabs ───────────────────────────────────────────
                    window.taxRateTab = function(tab, btn) {
                      document.querySelectorAll('[id^="tax-rtab-"]').forEach(b => {
                        b.style.borderBottomColor = 'transparent';
                        b.style.color = 'var(--text-secondary)';
                        b.style.fontWeight = '400';
                      });
                      btn.style.borderBottomColor = 'var(--accent)';
                      btn.style.color = 'var(--text-primary)';
                      btn.style.fontWeight = '600';
                      const el = document.getElementById('tax-rate-content');
                      if (!el) return;

                      if (tab === 'OH') {
                        const rows = Object.entries(OH_COUNTY).sort((a,b)=>a[0].localeCompare(b[0])).map(([county,rate]) => {
                          const zip3s = Object.entries(OH_ZIP3).filter(([,c])=>c===county).map(([z])=>z).join(', ');
                          return `<tr class="zw-divider">
                            <td style="padding:8px 12px;">${county}</td>
                            <td style="padding:8px 12px;color:var(--text-secondary);font-size:12px;">${zip3s||'—'}</td>
                            <td style="padding:8px 12px;text-align:right;font-weight:600;">${fmtPct(rate)}</td>
                            <td style="padding:8px 12px;text-align:right;color:var(--text-secondary);">${fmtPct(rate-0.0575)} county</td>
                          </tr>`;
                        }).join('');
                        el.innerHTML = `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:13px;">
                          <thead><tr class="zw-divider-2">
                            <th style="text-align:left;padding:8px 12px;color:var(--text-secondary);font-weight:500;">County</th>
                            <th style="text-align:left;padding:8px 12px;color:var(--text-secondary);font-weight:500;">ZIP Prefixes</th>
                            <th style="text-align:right;padding:8px 12px;color:var(--text-secondary);font-weight:500;">Combined Rate</th>
                            <th style="text-align:right;padding:8px 12px;color:var(--text-secondary);font-weight:500;">County Add-On</th>
                          </tr></thead><tbody>${rows}</tbody></table></div>
                          <p style="font-size:11px;color:var(--text-secondary);margin-top:12px;">State base: 5.75%. Verify at tax.ohio.gov before filing.</p>`;

                      } else if (tab === 'KY') {
                        el.innerHTML = `<div style="padding:16px;background:var(--bg-primary);border-radius:8px;">
                          <div style="font-size:24px;font-weight:700;color:var(--accent);margin-bottom:6px;">6.00%</div>
                          <p style="font-size:13px;color:var(--text-primary);">Kentucky has a uniform statewide rate — no county or local sales taxes. Every ZIP in KY uses 6.00%.</p>
                          <p style="font-size:12px;color:var(--text-secondary);margin-top:8px;">Verify at: revenue.ky.gov</p>
                        </div>`;

                      } else if (tab === 'IN') {
                        el.innerHTML = `<div style="padding:16px;background:var(--bg-primary);border-radius:8px;">
                          <div style="font-size:24px;font-weight:700;color:var(--accent);margin-bottom:6px;">7.00%</div>
                          <p style="font-size:13px;color:var(--text-primary);">Indiana has a uniform statewide rate — no county or local sales taxes. Every ZIP in IN uses 7.00%.</p>
                          <p style="font-size:12px;color:var(--text-secondary);margin-top:8px;">Verify at: in.gov/dor</p>
                        </div>`;

                      } else if (tab === 'IL') {
                        const rows = Object.entries(IL_ZIP3).sort((a,b)=>a[0].localeCompare(b[0])).map(([zip3,rate]) =>
                          `<tr class="zw-divider">
                            <td style="padding:8px 12px;">${zip3}xx</td>
                            <td style="padding:8px 12px;text-align:right;font-weight:600;">${fmtPct(rate)}</td>
                          </tr>`
                        ).join('');
                        el.innerHTML = `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:13px;">
                          <thead><tr class="zw-divider-2">
                            <th style="text-align:left;padding:8px 12px;color:var(--text-secondary);font-weight:500;">ZIP Prefix</th>
                            <th style="text-align:right;padding:8px 12px;color:var(--text-secondary);font-weight:500;">Rate</th>
                          </tr></thead><tbody>${rows}</tbody></table></div>
                          <p style="font-size:11px;color:var(--text-secondary);margin-top:12px;">State base: 6.25%. Illinois rates vary significantly by municipality — individual cities may add their own taxes. Verify at tax.illinois.gov.</p>`;

                      } else if (tab === 'ALL') {
                        const rows = Object.entries(STATE_RATES).sort((a,b)=>a[0].localeCompare(b[0])).map(([s,r]) => {
                          const note = FLAT[s] ? ' (flat)' : s==='OH'?' (county-level)':s==='IL'?' (ZIP-level)':'';
                          const noTax = r === 0;
                          return `<tr class="zw-divider">
                            <td style="padding:8px 12px;">${STATE_NAMES[s]||s} (${s})</td>
                            <td style="padding:8px 12px;text-align:right;font-weight:600;color:${noTax?'var(--text-secondary)':'inherit'}">${noTax ? 'No tax' : fmtPct(r)}</td>
                            <td style="padding:8px 12px;color:var(--text-secondary);font-size:12px;">${note}</td>
                          </tr>`;
                        }).join('');
                        el.innerHTML = `<div style="overflow-x:auto;max-height:400px;overflow-y:auto;"><table style="width:100%;border-collapse:collapse;font-size:13px;">
                          <thead style="position:sticky;top:0;background:var(--bg-secondary);"><tr class="zw-divider-2">
                            <th style="text-align:left;padding:8px 12px;color:var(--text-secondary);font-weight:500;">State</th>
                            <th style="text-align:right;padding:8px 12px;color:var(--text-secondary);font-weight:500;">Base Rate</th>
                            <th style="text-align:left;padding:8px 12px;color:var(--text-secondary);font-weight:500;">Notes</th>
                          </tr></thead><tbody>${rows}</tbody></table></div>
                          <p style="font-size:11px;color:var(--text-secondary);margin-top:12px;">OH, KY, IN, IL have county/ZIP-level lookups. All others use the state base rate shown. County add-ons in other states are not yet configured.</p>`;
                      }
                    };

                    // ── Main data load ────────────────────────────────────────────────
                    window.taxLoadData = async function() {
                      if (!window.sb) return;
                      taxErr('');
                      buildCalendar();
                      // Load saved overrides first, then render the editor so it shows correct values
                      await taxReLoadSaved();
                      const reBtn = document.getElementById('tax-re-tab-state');
                      if (reBtn && !document.getElementById('tax-re-content')?.children.length) taxReTab('state', reBtn);

                      // Default to OH tab
                      const ohBtn = document.getElementById('tax-rtab-OH');
                      if (ohBtn && document.getElementById('tax-rate-content')?.innerHTML === '') {
                        taxRateTab('OH', ohBtn);
                      }

                      try {
                        const { data: orders, error } = await sb.from('orders')
                          .select('subtotal,tax,created_at,status,ship_state,ship_zip')
                          .order('created_at', { ascending: false });
                        if (error) throw error;

                        _taxOrders = (orders || []).filter(o => o.status !== 'cancelled' && o.status !== 'refunded');

                        const now      = new Date();
                        const thisYM   = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
                        const lastM    = new Date(now.getFullYear(), now.getMonth()-1, 1);
                        const lastYM   = `${lastM.getFullYear()}-${String(lastM.getMonth()+1).padStart(2,'0')}`;
                        const yearStart = new Date(now.getFullYear(), 0, 1);

                        let totalTax=0, thisMonthTax=0, lastMonthTax=0, taxableOrders=0, totalTaxable=0;
                        const byState = {};
                        const ytdByState = {};

                        _taxOrders.forEach(o => {
                          const tax  = parseFloat(o.tax  || 0);
                          const sub  = parseFloat(o.subtotal || 0);
                          const dt   = o.created_at ? o.created_at.slice(0,7) : '';
                          const s    = (o.ship_state || '').toUpperCase().trim();

                          totalTax += tax;
                          if (tax > 0) { taxableOrders++; totalTaxable += sub; }
                          if (dt === thisYM) thisMonthTax += tax;
                          if (dt === lastYM) lastMonthTax += tax;

                          if (s) {
                            if (!byState[s]) byState[s] = { orders:0, subtotal:0, tax:0 };
                            byState[s].orders++;
                            byState[s].subtotal += sub;
                            byState[s].tax += tax;

                            const created = new Date(o.created_at);
                            if (created >= yearStart) {
                              if (!ytdByState[s]) ytdByState[s] = { orders:0, revenue:0 };
                              ytdByState[s].orders++;
                              ytdByState[s].revenue += sub;
                            }
                          }
                        });

                        const avgRate = totalTaxable > 0 ? totalTax / totalTaxable : 0;

                        // KPIs
                        document.getElementById('tax-kpi-total').textContent  = fmt$(totalTax);
                        document.getElementById('tax-kpi-month').textContent  = fmt$(thisMonthTax);
                        document.getElementById('tax-kpi-last').textContent   = fmt$(lastMonthTax);
                        document.getElementById('tax-kpi-orders').textContent = taxableOrders.toLocaleString();
                        document.getElementById('tax-kpi-rate').textContent   = fmtPct(avgRate);
                        document.getElementById('tax-kpi-states').textContent = Object.keys(byState).filter(s=>byState[s].tax>0).length;

                        // ── Nexus tracker ─────────────────────────────────────────────
                        const nexusTb = document.getElementById('tax-nexus-tbody');
                        const nexusStates = Object.keys(ytdByState).sort();
                        if (!nexusStates.length) {
                          nexusTb.innerHTML = '<tr class="empty-row"><td colspan="6">No orders recorded yet for this calendar year.</td></tr>';
                        } else {
                          const REV_THRESHOLD = 100000;
                          const ORD_THRESHOLD = 200;
                          nexusTb.innerHTML = nexusStates.map(s => {
                            const d = ytdByState[s];
                            const revPct = Math.min(d.revenue / REV_THRESHOLD, 1);
                            const ordPct = Math.min(d.orders / ORD_THRESHOLD, 1);
                            const isOH   = s === 'OH';
                            const noTaxState = NO_TAX.has(s);

                            let status, statusColor;
                            if (noTaxState) {
                              status = 'No sales tax'; statusColor = 'var(--text-secondary)';
                            } else if (isOH) {
                              status = '🟢 Physical nexus — always collecting'; statusColor = '#34d399';
                            } else if (d.revenue >= REV_THRESHOLD || d.orders >= ORD_THRESHOLD) {
                              status = '🔴 Economic nexus — register & collect'; statusColor = '#ef4444';
                            } else if (revPct >= 0.6 || ordPct >= 0.6) {
                              status = '🟡 Approaching threshold'; statusColor = '#f59e0b';
                            } else {
                              status = '⚪ Monitoring'; statusColor = 'var(--text-secondary)';
                            }

                            const bar = (pct, color) => `<div style="background:var(--bg-primary);border-radius:4px;height:6px;width:100%;min-width:80px;margin-top:4px;"><div style="background:${color};height:6px;border-radius:4px;width:${Math.round(pct*100)}%;"></div></div><div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">${Math.round(pct*100)}% of limit</div>`;

                            return `<tr class="zw-divider">
                              <td style="padding:10px 12px;font-weight:600;">${s} <span style="font-weight:400;color:var(--text-secondary);font-size:12px;">${STATE_NAMES[s]||''}</span></td>
                              <td style="padding:10px 12px;text-align:right;">${d.orders.toLocaleString()}</td>
                              <td style="padding:10px 12px;text-align:right;">${fmt$(d.revenue)}</td>
                              <td style="padding:10px 12px;">${noTaxState||isOH ? '—' : bar(revPct, revPct>=1?'#ef4444':revPct>=0.6?'#f59e0b':'#34d399')}</td>
                              <td style="padding:10px 12px;">${noTaxState||isOH ? '—' : bar(ordPct, ordPct>=1?'#ef4444':ordPct>=0.6?'#f59e0b':'#34d399')}</td>
                              <td style="padding:10px 12px;font-size:12px;color:${statusColor};">${status}</td>
                            </tr>`;
                          }).join('');
                        }

                        // ── Tax by state ──────────────────────────────────────────────
                        const stateTb = document.getElementById('tax-state-tbody');
                        const sortedStates = Object.entries(byState).sort((a,b)=>b[1].tax-a[1].tax);
                        if (!sortedStates.length) {
                          stateTb.innerHTML = '<tr class="empty-row"><td colspan="5">No orders with state data yet.</td></tr>';
                        } else {
                          stateTb.innerHTML = sortedStates.map(([s, d]) => {
                            const rate = d.subtotal > 0 ? d.tax / d.subtotal : 0;
                            const isOH = s === 'OH';
                            return `<tr style="border-bottom:1px solid var(--border);${isOH?'background:rgba(52,211,153,.04);':''}">
                              <td style="padding:10px 12px;font-weight:${isOH?'700':'400'};">${s} ${isOH?'<span style="font-size:11px;background:rgba(52,211,153,.15);color:#34d399;padding:2px 6px;border-radius:3px;margin-left:4px;">home</span>':''}</td>
                              <td style="padding:10px 12px;text-align:right;">${d.orders.toLocaleString()}</td>
                              <td style="padding:10px 12px;text-align:right;">${fmt$(d.subtotal)}</td>
                              <td style="padding:10px 12px;text-align:right;font-weight:600;">${fmt$(d.tax)}</td>
                              <td style="padding:10px 12px;text-align:right;color:var(--text-secondary);">${fmtPct(rate)}</td>
                            </tr>`;
                          }).join('');
                        }

                        // ── Ohio county breakdown ─────────────────────────────────────
                        const ohOrders = _taxOrders.filter(o => (o.ship_state||'').toUpperCase() === 'OH');
                        const ohWrap = document.getElementById('tax-oh-wrap');
                        if (ohOrders.length && ohWrap) {
                          ohWrap.style.display = 'block';
                          const byCounty = {};
                          ohOrders.forEach(o => {
                            const zip3   = String(o.ship_zip||'').replace(/\D/g,'').slice(0,3);
                            const county = OH_ZIP3[zip3] || 'Other / Unmapped';
                            const rate   = county !== 'Other / Unmapped' ? OH_COUNTY[county] || 0.0725 : 0.0725;
                            if (!byCounty[county]) byCounty[county] = { zip3s: new Set(), orders:0, subtotal:0, tax:0, rate };
                            byCounty[county].zip3s.add(zip3 || '???');
                            byCounty[county].orders++;
                            byCounty[county].subtotal += parseFloat(o.subtotal || 0);
                            byCounty[county].tax      += parseFloat(o.tax || 0);
                          });
                          const ohTb = document.getElementById('tax-oh-tbody');
                          ohTb.innerHTML = Object.entries(byCounty).sort((a,b)=>b[1].tax-a[1].tax).map(([county, d]) =>
                            `<tr class="zw-divider">
                              <td style="padding:10px 12px;font-weight:600;">${county}</td>
                              <td style="padding:10px 12px;color:var(--text-secondary);font-size:12px;">${[...d.zip3s].join(', ')}xx</td>
                              <td style="padding:10px 12px;text-align:right;">${d.orders.toLocaleString()}</td>
                              <td style="padding:10px 12px;text-align:right;">${fmt$(d.subtotal)}</td>
                              <td style="padding:10px 12px;text-align:right;font-weight:600;">${fmt$(d.tax)}</td>
                              <td style="padding:10px 12px;text-align:right;color:var(--text-secondary);">${fmtPct(d.rate)}</td>
                            </tr>`
                          ).join('');
                        } else if (ohWrap) {
                          ohWrap.style.display = 'none';
                        }

                      } catch(e) { taxErr('Failed to load tax data: ' + e.message); }
                    };

                    // ── CSV Export ────────────────────────────────────────────────────
                    window.taxExportCSV = function() {
                      if (!_taxOrders.length) { alert('Load the tax page first.'); return; }
                      const headers = ['Date','State','ZIP','County (OH)','Taxable Revenue','Tax Collected','Effective Rate'];
                      const rows = _taxOrders.map(o => {
                        const s      = (o.ship_state||'').toUpperCase();
                        const zip    = String(o.ship_zip||'');
                        const zip3   = zip.replace(/\D/g,'').slice(0,3);
                        const county = s==='OH' ? (OH_ZIP3[zip3]||'Unknown') : '';
                        const sub    = parseFloat(o.subtotal||0);
                        const tax    = parseFloat(o.tax||0);
                        const rate   = sub > 0 ? (tax/sub) : 0;
                        return [
                          (o.created_at||'').slice(0,10),
                          s, zip, county,
                          sub.toFixed(2), tax.toFixed(2),
                          (rate*100).toFixed(2)+'%'
                        ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(',');
                      });
                      const csv  = [headers.join(','), ...rows].join('\n');
                      const blob = new Blob([csv], { type: 'text/csv' });
                      const a    = document.createElement('a');
                      a.href     = URL.createObjectURL(blob);
                      a.download = `zuwera-tax-${new Date().toISOString().slice(0,10)}.csv`;
                      a.click();
                    };

                    // ── Rate Editor ───────────────────────────────────────────────────
                    let _reEdited = {};

                    function taxReMsg(msg, isErr) {
                      const el = document.getElementById('tax-re-msg');
                      if (!el) return;
                      el.style.display = 'block';
                      el.style.background = isErr ? '#2a1a1a' : 'rgba(16,185,129,.08)';
                      el.style.border = '1px solid ' + (isErr ? '#ef4444' : '#10b981');
                      el.style.color = isErr ? '#f87171' : '#34d399';
                      el.textContent = msg;
                      setTimeout(() => { if (el.textContent === msg) el.style.display = 'none'; }, 5000);
                    }

                    function taxReMarkEdit(section, key, newVal) {
                      if (isNaN(newVal) || !isFinite(newVal)) return;
                      if (!_reEdited[section]) _reEdited[section] = {};
                      const tbl = section==='stateRates'?STATE_RATES:section==='ohCountyRates'?OH_COUNTY:section==='ilZip3Rates'?IL_ZIP3:FLAT;
                      const orig = tbl[key] || 0;
                      if (Math.abs(newVal - orig) < 0.000001) delete _reEdited[section][key];
                      else _reEdited[section][key] = newVal;
                      const prefix = section==='stateRates'?'S':section==='ohCountyRates'?'C':section==='ilZip3Rates'?'IL':'F';
                      const diffEl = document.getElementById('tax-re-diff-'+prefix+'-'+key);
                      if (diffEl) {
                        const diff = newVal - orig;
                        if (Math.abs(diff) < 0.000001) { diffEl.textContent = ''; }
                        else {
                          diffEl.textContent = (diff>0?'+':'')+(diff*100).toFixed(4)+'%';
                          diffEl.style.color = diff>0 ? 'var(--error)' : 'var(--success)';
                        }
                      }
                    }

                    window.taxReTab = function(tab, btn) {
                      document.querySelectorAll('[id^="tax-re-tab-"]').forEach(b => {
                        b.style.borderBottomColor = 'transparent';
                        b.style.color = 'var(--text-secondary)';
                        b.style.fontWeight = '400';
                      });
                      btn.style.borderBottomColor = 'var(--accent)';
                      btn.style.color = 'var(--text-primary)';
                      btn.style.fontWeight = '600';
                      const el = document.getElementById('tax-re-content');
                      if (!el) return;

                      const inStyle = 'width:72px;text-align:right;padding:4px 7px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:13px;';
                      const thStyle = 'padding:8px 12px;font-size:12px;color:var(--text-secondary);font-weight:500;';

                      if (tab === 'state') {
                        const rows = Object.entries(STATE_RATES).sort((a,b)=>a[0].localeCompare(b[0])).map(([s,r]) => {
                          const skip = FLAT[s]!==undefined||s==='OH'||s==='IL';
                          const cur = _reEdited.stateRates?.[s] ?? r;
                          return `<tr class="zw-divider">
                            <td style="padding:8px 12px;font-size:13px;">${STATE_NAMES[s]||s} <span style="color:var(--text-secondary);font-size:11px;">(${s})</span></td>
                            <td style="padding:8px 12px;text-align:right;">${skip
                              ? `<span style="font-size:13px;color:var(--text-secondary);">${fmtPct(r)}</span>`
                              : `<input type="number" step="0.01" min="0" max="20" value="${(cur*100).toFixed(4)}"
                                  data-section="stateRates" data-key="${s}"
                                  oninput="taxReMarkEdit('stateRates','${s}',parseFloat(this.value)/100)"
                                  style="${inStyle}"> %`}</td>
                            <td style="padding:8px 12px;text-align:right;font-size:12px;color:var(--text-secondary);">default: ${fmtPct(r)}</td>
                            <td id="tax-re-diff-S-${s}" style="padding:8px 12px;font-size:12px;width:80px;"></td>
                            <td style="padding:8px 12px;font-size:11px;color:var(--text-secondary);">${skip?'use dedicated tab':''}</td>
                          </tr>`;
                        }).join('');
                        el.innerHTML = `<div style="overflow-x:auto;max-height:480px;overflow-y:auto;">
                          <table style="width:100%;border-collapse:collapse;">
                            <thead style="position:sticky;top:0;background:var(--bg-secondary);">
                              <tr class="zw-divider-2">
                                <th style="text-align:left;${thStyle}">State</th>
                                <th style="text-align:right;${thStyle}">Rate (%)</th>
                                <th style="text-align:right;${thStyle}">Default</th>
                                <th style="${thStyle}">Change</th>
                                <th style="${thStyle}">Note</th>
                              </tr>
                            </thead>
                            <tbody>${rows}</tbody>
                          </table>
                        </div>
                        <p style="font-size:11px;color:var(--text-secondary);margin-top:12px;">Enter as percentage (e.g. 6.5 for 6.5%). OH/KY/IN/IL use dedicated tabs.</p>`;

                      } else if (tab === 'oh') {
                        const rows = Object.entries(OH_COUNTY).sort((a,b)=>a[0].localeCompare(b[0])).map(([county,r]) => {
                          const zip3s = Object.entries(OH_ZIP3).filter(([,c])=>c===county).map(([z])=>z).join(', ');
                          const cur = _reEdited.ohCountyRates?.[county] ?? r;
                          return `<tr class="zw-divider">
                            <td style="padding:8px 12px;font-size:13px;">${county}</td>
                            <td style="padding:8px 12px;font-size:12px;color:var(--text-secondary);">${zip3s||'—'}xx</td>
                            <td style="padding:8px 12px;text-align:right;">
                              <input type="number" step="0.01" min="0" max="20" value="${(cur*100).toFixed(4)}"
                                data-section="ohCountyRates" data-key="${county}"
                                oninput="taxReMarkEdit('ohCountyRates','${county}',parseFloat(this.value)/100)"
                                style="${inStyle}"> %
                            </td>
                            <td style="padding:8px 12px;font-size:12px;color:var(--text-secondary);">default: ${fmtPct(r)}</td>
                            <td id="tax-re-diff-C-${county}" style="padding:8px 12px;font-size:12px;width:80px;"></td>
                          </tr>`;
                        }).join('');
                        el.innerHTML = `<div style="overflow-x:auto;max-height:480px;overflow-y:auto;">
                          <table style="width:100%;border-collapse:collapse;">
                            <thead style="position:sticky;top:0;background:var(--bg-secondary);">
                              <tr class="zw-divider-2">
                                <th style="text-align:left;${thStyle}">County</th>
                                <th style="text-align:left;${thStyle}">ZIP Prefixes</th>
                                <th style="text-align:right;${thStyle}">Rate (%)</th>
                                <th style="${thStyle}">Default</th>
                                <th style="${thStyle}">Change</th>
                              </tr>
                            </thead>
                            <tbody>${rows}</tbody>
                          </table>
                        </div>
                        <p style="font-size:11px;color:var(--warning);margin-top:12px;">County changes require redeploying checkout-tax.js. Verify at tax.ohio.gov.</p>`;

                      } else if (tab === 'il') {
                        const rows = Object.entries(IL_ZIP3).sort((a,b)=>a[0].localeCompare(b[0])).map(([zip3,r]) => {
                          const cur = _reEdited.ilZip3Rates?.[zip3] ?? r;
                          return `<tr class="zw-divider">
                            <td style="padding:8px 12px;font-size:13px;">${zip3}xx</td>
                            <td style="padding:8px 12px;text-align:right;">
                              <input type="number" step="0.01" min="0" max="20" value="${(cur*100).toFixed(4)}"
                                data-section="ilZip3Rates" data-key="${zip3}"
                                oninput="taxReMarkEdit('ilZip3Rates','${zip3}',parseFloat(this.value)/100)"
                                style="${inStyle}"> %
                            </td>
                            <td style="padding:8px 12px;font-size:12px;color:var(--text-secondary);">default: ${fmtPct(r)}</td>
                            <td id="tax-re-diff-IL-${zip3}" style="padding:8px 12px;font-size:12px;width:80px;"></td>
                          </tr>`;
                        }).join('');
                        el.innerHTML = `<div style="overflow-x:auto;max-height:400px;overflow-y:auto;">
                          <table style="width:100%;border-collapse:collapse;">
                            <thead style="position:sticky;top:0;background:var(--bg-secondary);">
                              <tr class="zw-divider-2">
                                <th style="text-align:left;${thStyle}">ZIP Prefix</th>
                                <th style="text-align:right;${thStyle}">Rate (%)</th>
                                <th style="${thStyle}">Default</th>
                                <th style="${thStyle}">Change</th>
                              </tr>
                            </thead>
                            <tbody>${rows}</tbody>
                          </table>
                        </div>
                        <p style="font-size:11px;color:var(--warning);margin-top:12px;">IL ZIP3 changes require redeploying checkout-tax.js. Verify at tax.illinois.gov.</p>`;

                      } else if (tab === 'flat') {
                        const rows = Object.entries(FLAT).map(([s,r]) => {
                          const cur = _reEdited.flatRates?.[s] ?? r;
                          return `<tr class="zw-divider">
                            <td style="padding:12px;font-size:13px;">${STATE_NAMES[s]||s} <span style="color:var(--text-secondary);font-size:11px;">(${s})</span></td>
                            <td style="padding:12px;text-align:right;">
                              <input type="number" step="0.01" min="0" max="20" value="${(cur*100).toFixed(4)}"
                                data-section="flatRates" data-key="${s}"
                                oninput="taxReMarkEdit('flatRates','${s}',parseFloat(this.value)/100)"
                                style="${inStyle}"> %
                            </td>
                            <td style="padding:12px;font-size:12px;color:var(--text-secondary);">default: ${fmtPct(r)}</td>
                            <td id="tax-re-diff-F-${s}" style="padding:12px;font-size:12px;width:80px;"></td>
                          </tr>`;
                        }).join('');
                        el.innerHTML = `<table style="width:100%;border-collapse:collapse;">
                          <thead>
                            <tr class="zw-divider-2">
                              <th style="text-align:left;${thStyle}">State</th>
                              <th style="text-align:right;${thStyle}">Rate (%)</th>
                              <th style="${thStyle}">Default</th>
                              <th style="${thStyle}">Change</th>
                            </tr>
                          </thead>
                          <tbody>${rows}</tbody>
                        </table>
                        <p style="font-size:11px;color:var(--text-secondary);margin-top:12px;">KY and IN have uniform statewide rates with no local add-ons.</p>`;
                      }
                    };

                    window.taxReReset = function() {
                      _reEdited = {};
                      const active = document.querySelector('[id^="tax-re-tab-"][style*="var(--accent)"]');
                      if (active) active.click();
                    };

                    window.taxReCopyJSON = function() {
                      const merged = { ...STATE_RATES, ...(_reEdited.stateRates || {}) };
                      const json = JSON.stringify(merged, null, 2);
                      navigator.clipboard?.writeText(json)
                        .then(() => taxReMsg('STATE_TAX_RATES JSON copied — paste into Cloudflare Pages env vars.'))
                        .catch(() => taxReMsg('Copy failed. Open console to retrieve.', true));
                    };

                    window.taxReSave = async function() {
                      if (!window.sb) { taxReMsg('Supabase not ready.', true); return; }
                      // Flush any input values not yet captured by oninput (e.g. on mobile tap-to-save)
                      document.querySelectorAll('#tax-re-content input[type="number"][data-section][data-key]').forEach(function(inp) {
                        const val = parseFloat(inp.value);
                        if (!isNaN(val) && isFinite(val)) taxReMarkEdit(inp.dataset.section, inp.dataset.key, val / 100);
                      });
                      const payload = {
                        stateRates:    { ...STATE_RATES,  ...(_reEdited.stateRates    || {}) },
                        ohCountyRates: { ...OH_COUNTY,    ...(_reEdited.ohCountyRates  || {}) },
                        ilZip3Rates:   { ...IL_ZIP3,      ...(_reEdited.ilZip3Rates    || {}) },
                        flatRates:     { ...FLAT,         ...(_reEdited.flatRates      || {}) },
                        updatedAt:     new Date().toISOString(),
                        editedKeys:    JSON.parse(JSON.stringify(_reEdited)),
                      };
                      const { error } = await window.sb.from('site_settings')
                        .upsert({ key: 'tax_rate_overrides', value: payload }, { onConflict: 'key' });
                      if (error) { taxReMsg('Save failed: ' + error.message, true); return; }
                      // Apply all overrides to local tables so the editor reflects saved state
                      if (_reEdited.stateRates)    Object.assign(STATE_RATES, _reEdited.stateRates);
                      if (_reEdited.flatRates)     Object.assign(FLAT,        _reEdited.flatRates);
                      if (_reEdited.ohCountyRates) Object.assign(OH_COUNTY,   _reEdited.ohCountyRates);
                      if (_reEdited.ilZip3Rates)   Object.assign(IL_ZIP3,     _reEdited.ilZip3Rates);
                      _reEdited = {};
                      taxReMsg('Saved! State changes are live. County/ZIP changes take effect after redeploying checkout-tax.js.');
                      // Reload active tab to clear diff indicators
                      const active = document.querySelector('[id^="tax-re-tab-"][style*="var(--accent)"]');
                      if (active) active.click();
                    };

                    // Load saved overrides into local tables on Tax page open
                    async function taxReLoadSaved() {
                      try {
                        const { data } = await window.sb?.from('site_settings').select('value').eq('key','tax_rate_overrides').maybeSingle() || {};
                        if (!data?.value) return;
                        const ov = typeof data.value === 'object' ? data.value : JSON.parse(data.value);
                        if (ov.stateRates)    Object.assign(STATE_RATES, ov.stateRates);
                        if (ov.ohCountyRates) Object.assign(OH_COUNTY,   ov.ohCountyRates);
                        if (ov.ilZip3Rates)   Object.assign(IL_ZIP3,     ov.ilZip3Rates);
                        if (ov.flatRates)     Object.assign(FLAT,         ov.flatRates);
                      } catch(_) {}
                    }

                    // Auto-init calendar (no DB needed)
                    buildCalendar();
                    taxRateTab('OH', document.getElementById('tax-rtab-OH'));
                  })();
