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
                    /* ── What you owe for a period you can file ────────────────
                       The KPIs are this month and last month, which no state
                       asks for. A return covers a filing PERIOD — Ohio bills
                       this store semi-annually — so the number that matters is
                       "everything collected between these two dates, split by
                       state", and the page could not produce it.

                       Reads _taxOrders, the same list the rest of the page
                       reads, so the totals here cannot disagree with the totals
                       above. A second query would be a second answer. */
                    function taxPeriodRange(key, now = new Date()) {
                      const y = now.getFullYear();
                      const m = now.getMonth();
                      const at = (yy, mm, dd) => new Date(yy, mm, dd, 0, 0, 0, 0);
                      /* Exclusive upper bound: the instant the next period
                         starts. Using "the last day" drops everything ordered
                         after midnight on it, which is a whole day of tax
                         missing from a return and impossible to spot. */
                      switch (key) {
                        case 'today':       return { from: at(y, m, now.getDate()), to: at(y, m, now.getDate() + 1), label: 'Today' };
                        case 'month':       return { from: at(y, m, 1), to: at(y, m + 1, 1), label: 'This month' };
                        case 'lastmonth':   return { from: at(y, m - 1, 1), to: at(y, m, 1), label: 'Last month' };
                        case 'quarter': {
                          const q = Math.floor(m / 3) * 3;
                          return { from: at(y, q, 1), to: at(y, q + 3, 1), label: 'Q' + (q / 3 + 1) + ' ' + y };
                        }
                        case 'lastquarter': {
                          const q = Math.floor(m / 3) * 3 - 3;
                          const from = at(y, q, 1);
                          return { from, to: at(y, q + 3, 1), label: 'Q' + (Math.floor(from.getMonth() / 3) + 1) + ' ' + from.getFullYear() };
                        }
                        case 'half': {
                          const h = m < 6 ? 0 : 6;
                          return { from: at(y, h, 1), to: at(y, h + 6, 1), label: (h ? 'Jul–Dec ' : 'Jan–Jun ') + y };
                        }
                        case 'lasthalf': {
                          const h = m < 6 ? -6 : 0;
                          const from = at(y, h, 1);
                          return { from, to: at(y, h + 6, 1), label: (from.getMonth() ? 'Jul–Dec ' : 'Jan–Jun ') + from.getFullYear() };
                        }
                        case 'year':        return { from: at(y, 0, 1), to: at(y + 1, 0, 1), label: y + ' to date' };
                        default:            return null;   // custom — read from the inputs
                      }
                    }

                    function taxPeriodSelected() {
                      const key = document.getElementById('tax-period-select')?.value || 'half';
                      const custom = document.getElementById('tax-period-custom');
                      if (custom) custom.style.display = key === 'custom' ? 'flex' : 'none';
                      if (key !== 'custom') return taxPeriodRange(key);

                      const f = document.getElementById('tax-period-from')?.value;
                      const t = document.getElementById('tax-period-to')?.value;
                      if (!f || !t) return null;
                      const from = new Date(f + 'T00:00:00');
                      /* +1 day so the "to" date the user picked is INCLUDED —
                         nobody means "up to but not including" when they pick
                         an end date on a tax return. */
                      const to = new Date(t + 'T00:00:00');
                      to.setDate(to.getDate() + 1);
                      return { from, to, label: f + ' to ' + t };
                    }

                    let _taxPeriodRows = [];

                    window.taxPeriodRender = function() {
                      const range = taxPeriodSelected();
                      const labelEl = document.getElementById('tax-period-label');
                      const totalEl = document.getElementById('tax-period-total');
                      const subEl   = document.getElementById('tax-period-sub');
                      const tb      = document.getElementById('tax-period-tbody');
                      if (!tb) return;

                      if (!range) {
                        if (labelEl) labelEl.textContent = 'Pick both dates';
                        if (totalEl) totalEl.textContent = '—';
                        if (subEl)   subEl.textContent = '';
                        tb.innerHTML = '<tr class="empty-row"><td colspan="5">Choose a start and end date.</td></tr>';
                        return;
                      }

                      const inRange = _taxOrders.filter(o => {
                        if (!o.created_at) return false;
                        const d = new Date(o.created_at);
                        return d >= range.from && d < range.to;
                      });

                      const byState = {};
                      let total = 0, taxable = 0;
                      inRange.forEach(o => {
                        const tax = parseFloat(o.tax || 0);
                        const sub = parseFloat(o.subtotal || 0);
                        const s   = (o.ship_state || '').toUpperCase().trim() || '—';
                        total += tax;
                        if (tax > 0) taxable += sub;
                        if (!byState[s]) byState[s] = { orders: 0, subtotal: 0, tax: 0 };
                        byState[s].orders++;
                        byState[s].subtotal += sub;
                        byState[s].tax += tax;
                      });

                      _taxPeriodRows = Object.entries(byState).sort((a, b) => b[1].tax - a[1].tax);

                      if (labelEl) labelEl.textContent = range.label;
                      if (totalEl) totalEl.textContent = fmt$(total);

                      /* Collected minus what has already been remitted. The
                         gross figure stops being the useful one the moment you
                         have filed once. */
                      const filed = taxFiledFor(range.label);
                      const outstanding = total - filed;
                      const outEl = document.getElementById('tax-outstanding');
                      const noteEl = document.getElementById('tax-filed-note');
                      if (outEl) {
                        outEl.textContent = fmt$(Math.max(0, outstanding));
                        outEl.style.color = outstanding > 0.005 ? 'var(--text-primary)' : '#34d399';
                      }
                      if (noteEl) {
                        noteEl.textContent = filed > 0
                          ? fmt$(filed) + ' already remitted for ' + range.label
                          : 'Nothing recorded as filed for ' + range.label + ' yet.';
                      }
                      if (subEl) {
                        subEl.textContent = inRange.length.toLocaleString() + ' order' + (inRange.length === 1 ? '' : 's')
                          + ' · ' + fmt$(taxable) + ' taxable sales'
                          + ' · ' + _taxPeriodRows.filter(([, d]) => d.tax > 0).length + ' state(s) to file in';
                      }

                      if (!_taxPeriodRows.length) {
                        tb.innerHTML = '<tr class="empty-row"><td colspan="5">No orders in this period.</td></tr>';
                        return;
                      }

                      tb.innerHTML = _taxPeriodRows.map(([s, d]) => {
                        /* Ohio is the one this store is registered in. Anywhere
                           else showing collected tax is money held for a state
                           that may not know you exist — worth flagging on the
                           row rather than leaving it to be noticed. */
                        const isOH = s === 'OH';
                        const owed = d.tax > 0;
                        const reg = isOH
                          ? '<span style="color:#34d399;">Registered</span>'
                          : owed
                            ? '<span style="color:#f59e0b;">Collected — check registration</span>'
                            : '<span style="color:var(--text-secondary);">No tax collected</span>';
                        return `<tr class="zw-divider">
                          <td style="padding:10px 12px;font-weight:${isOH ? '700' : '400'};">${s} <span style="font-weight:400;color:var(--text-secondary);font-size:12px;">${STATE_NAMES[s] || ''}</span></td>
                          <td style="padding:10px 12px;text-align:right;">${d.orders.toLocaleString()}</td>
                          <td style="padding:10px 12px;text-align:right;">${fmt$(d.subtotal)}</td>
                          <td style="padding:10px 12px;text-align:right;font-weight:600;">${fmt$(d.tax)}</td>
                          <td style="padding:10px 12px;font-size:12px;">${reg}</td>
                        </tr>`;
                      }).join('');
                    };

                    window.taxPeriodCSV = function() {
                      const range = taxPeriodSelected();
                      if (!range || !_taxPeriodRows.length) { alert('Nothing to export for this period.'); return; }
                      const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
                      const lines = [['Period', 'State', 'Orders', 'Taxable sales', 'Tax collected'].map(esc).join(',')];
                      _taxPeriodRows.forEach(([s, d]) => {
                        lines.push([range.label, s, d.orders, d.subtotal.toFixed(2), d.tax.toFixed(2)].map(esc).join(','));
                      });
                      const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
                      const a = document.createElement('a');
                      a.href = URL.createObjectURL(blob);
                      a.download = 'tax-' + range.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.csv';
                      a.click();
                      URL.revokeObjectURL(a.href);
                    };

                    /* ── (1) Collected vs expected, and (4) the odd ones out ───
                       Asks /api/tax-quote what each address SHOULD have been
                       charged. Deliberately the endpoint rather than the tables
                       loaded on this page: the endpoint runs whichever engine
                       actually prices checkout, so this compares against the
                       thing that charges rather than against a second opinion
                       that could be wrong in the same direction.

                       One request per DISTINCT jurisdiction, not per order —
                       a hundred Cincinnati orders are one question. */
                    const _expectedCache = {};

                    async function expectedRate(state, zip) {
                      const s = String(state || '').toUpperCase().trim();
                      const z = String(zip || '').replace(/\D/g, '').slice(0, 5);
                      const key = s + '|' + z;
                      if (key in _expectedCache) return _expectedCache[key];
                      try {
                        const r = await fetch('/api/tax-quote?state=' + encodeURIComponent(s) + '&zip=' + encodeURIComponent(z));
                        const d = r.ok ? await r.json() : null;
                        _expectedCache[key] = (d && !d.unavailable && Number.isFinite(Number(d.rate))) ? Number(d.rate) : null;
                      } catch (_) { _expectedCache[key] = null; }
                      return _expectedCache[key];
                    }

                    /* A cap, because this is one network call per jurisdiction and
                       an admin clicking a button should not fire hundreds. */
                    const EXPECTED_MAX_JURISDICTIONS = 60;

                    window.taxCheckExpected = async function() {
                      const out = document.getElementById('tax-expected-out');
                      const btn = document.getElementById('tax-check-btn');
                      const range = taxPeriodSelected();
                      if (!out) return;
                      if (!range) { out.textContent = 'Pick a period first.'; return; }

                      const orders = _taxOrders.filter(o => {
                        if (!o.created_at) return false;
                        const d = new Date(o.created_at);
                        return d >= range.from && d < range.to;
                      });
                      if (!orders.length) { out.textContent = 'No orders in this period.'; return; }

                      const jurisdictions = [...new Set(orders.map(o =>
                        (o.ship_state || '').toUpperCase().trim() + '|' + String(o.ship_zip || '').replace(/\D/g, '').slice(0, 5)
                      ))].filter(k => k !== '|');

                      if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
                      out.innerHTML = 'Asking the tax engine about ' + jurisdictions.length + ' address' + (jurisdictions.length === 1 ? '' : 'es') + '…';

                      const capped = jurisdictions.slice(0, EXPECTED_MAX_JURISDICTIONS);
                      for (const k of capped) { const [s, z] = k.split('|'); await expectedRate(s, z); }

                      let expectedTotal = 0, actualTotal = 0, checked = 0, unknown = 0;
                      const byState = {};
                      const anomalies = [];

                      orders.forEach(o => {
                        const s = (o.ship_state || '').toUpperCase().trim();
                        const z = String(o.ship_zip || '').replace(/\D/g, '').slice(0, 5);
                        const rate = _expectedCache[s + '|' + z];
                        const sub = parseFloat(o.subtotal || 0);
                        const tax = parseFloat(o.tax || 0);
                        if (rate == null) { unknown++; return; }
                        checked++;
                        const exp = sub * rate;
                        expectedTotal += exp;
                        actualTotal += tax;
                        if (!byState[s]) byState[s] = { expected: 0, actual: 0, orders: 0 };
                        byState[s].expected += exp;
                        byState[s].actual += tax;
                        byState[s].orders++;
                        /* Zero charged where the engine says tax was due. A cent
                           of tolerance, because a rounded zero is not the same
                           as nothing being charged. */
                        if (tax < 0.01 && exp >= 0.01) {
                          anomalies.push({ o, s, z, expected: exp });
                        }
                      });

                      const diff = actualTotal - expectedTotal;
                      const off = Math.abs(diff) >= 0.01;
                      const under = diff < 0;
                      const colour = !off ? '#34d399' : under ? '#ef4444' : '#f59e0b';
                      const verdict = !off
                        ? 'Everything matches what the engine would charge today.'
                        : (under ? 'Under-collected by ' : 'Over-collected by ') + fmt$(Math.abs(diff))
                          + (under ? ' — this is money you owe the state but did not take from customers.'
                                   : ' — customers were charged more than the engine says is due.');

                      const rows = Object.entries(byState).sort((a, b) => Math.abs(b[1].actual - b[1].expected) - Math.abs(a[1].actual - a[1].expected));
                      out.innerHTML =
                        '<p style="font-size:20px;font-weight:700;color:' + colour + ';margin-bottom:4px;">' + verdict + '</p>'
                        + '<p style="font-size:12px;color:var(--text-secondary);margin-bottom:14px;">Collected ' + fmt$(actualTotal)
                        + ' · expected ' + fmt$(expectedTotal) + ' · ' + checked + ' order(s) checked'
                        + (unknown ? ' · ' + unknown + ' skipped (no address)' : '')
                        + (jurisdictions.length > capped.length ? ' · capped at ' + EXPECTED_MAX_JURISDICTIONS + ' addresses' : '')
                        + '</p>'
                        + '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:13px;">'
                        + '<thead><tr class="zw-divider-2">'
                        + '<th style="text-align:left;padding:8px 12px;font-weight:600;color:var(--text-secondary);">State</th>'
                        + '<th style="text-align:right;padding:8px 12px;font-weight:600;color:var(--text-secondary);">Collected</th>'
                        + '<th style="text-align:right;padding:8px 12px;font-weight:600;color:var(--text-secondary);">Expected</th>'
                        + '<th style="text-align:right;padding:8px 12px;font-weight:600;color:var(--text-secondary);">Difference</th>'
                        + '</tr></thead><tbody>'
                        + rows.map(([s, d]) => {
                            const dd = d.actual - d.expected;
                            const c = Math.abs(dd) < 0.01 ? 'var(--text-secondary)' : dd < 0 ? '#ef4444' : '#f59e0b';
                            return '<tr class="zw-divider"><td style="padding:10px 12px;font-weight:600;">' + s + '</td>'
                              + '<td style="padding:10px 12px;text-align:right;">' + fmt$(d.actual) + '</td>'
                              + '<td style="padding:10px 12px;text-align:right;">' + fmt$(d.expected) + '</td>'
                              + '<td style="padding:10px 12px;text-align:right;color:' + c + ';font-weight:600;">'
                              + (Math.abs(dd) < 0.01 ? '—' : (dd < 0 ? '−' : '+') + fmt$(Math.abs(dd))) + '</td></tr>';
                          }).join('')
                        + '</tbody></table></div>'
                        + '<p style="font-size:11px;color:var(--text-secondary);margin-top:12px;line-height:1.6;">Expected is what the engine would charge <b style="color:var(--text-primary);">now</b>. A rate that changed since an order was placed shows here as a difference and is not necessarily an error.</p>';

                      // ── (4) the orders that look wrong ──────────────────────
                      const wrap = document.getElementById('tax-anomaly-wrap');
                      const tb = document.getElementById('tax-anomaly-tbody');
                      if (wrap && tb) {
                        if (!anomalies.length) {
                          wrap.style.display = 'none';
                        } else {
                          wrap.style.display = 'block';
                          tb.innerHTML = anomalies.slice(0, 50).map(a =>
                            '<tr class="zw-divider">'
                            + '<td style="padding:10px 12px;">' + (a.o.created_at || '').slice(0, 10) + '</td>'
                            + '<td style="padding:10px 12px;">' + a.s + ' ' + a.z + '</td>'
                            + '<td style="padding:10px 12px;text-align:right;">' + fmt$(parseFloat(a.o.subtotal || 0)) + '</td>'
                            + '<td style="padding:10px 12px;text-align:right;color:#ef4444;font-weight:600;">no tax charged</td>'
                            + '<td style="padding:10px 12px;text-align:right;color:var(--text-secondary);">expected ' + fmt$(a.expected) + '</td>'
                            + '</tr>'
                          ).join('') + (anomalies.length > 50
                            ? '<tr><td colspan="5" style="padding:10px 12px;color:var(--text-secondary);font-size:12px;">…and ' + (anomalies.length - 50) + ' more.</td></tr>'
                            : '');
                        }
                      }

                      if (btn) { btn.disabled = false; btn.textContent = 'Check rates'; }
                    };

                    /* ── (2) What has already been remitted ────────────────────
                       Collected is not the same as owed once you have filed. A
                       filing is recorded per period+state so the panel can show
                       what is still being held rather than the gross figure for
                       ever. */
                    let _taxFilings = [];

                    async function taxFilingsLoad() {
                      try {
                        const { data } = await sb.from('site_settings').select('value').eq('key', 'tax_filings').maybeSingle();
                        let v = data && data.value;
                        if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
                        _taxFilings = Array.isArray(v) ? v : (v && Array.isArray(v.filings) ? v.filings : []);
                      } catch (_) { _taxFilings = []; }
                    }

                    function taxFiledFor(label) {
                      return _taxFilings.filter(f => f && f.period === label)
                        .reduce((n, f) => n + (parseFloat(f.amount) || 0), 0);
                    }

                    window.taxMarkFiled = async function() {
                      const range = taxPeriodSelected();
                      if (!range) { alert('Pick a period first.'); return; }
                      const collected = _taxPeriodRows.reduce((n, [, d]) => n + d.tax, 0);
                      const already = taxFiledFor(range.label);
                      const suggested = Math.max(0, collected - already).toFixed(2);
                      const entered = prompt('Amount remitted for ' + range.label + ':', suggested);
                      if (entered == null) return;
                      const amount = parseFloat(entered);
                      if (!isFinite(amount) || amount < 0) { alert('Enter a number.'); return; }

                      /* Read-modify-write on a list only ever appended to by a
                         human clicking a button — no realistic concurrency, and
                         a lost entry is visible (the outstanding figure stays
                         high) rather than silent. */
                      const next = _taxFilings.concat([{
                        period: range.label,
                        amount: Number(amount.toFixed(2)),
                        filedAt: new Date().toISOString(),
                        filedBy: (window.currentAdminEmail || ''),
                      }]);
                      const { error } = await sb.from('site_settings')
                        .upsert({ key: 'tax_filings', value: next }, { onConflict: 'key' });
                      if (error) { alert('Could not save: ' + error.message); return; }
                      _taxFilings = next;
                      if (typeof logAdminAudit === 'function') {
                        void logAdminAudit('tax.filed', 'site_settings', 'tax_filings', { period: range.label, amount });
                      }
                      window.taxPeriodRender();
                    };

                    /* ── (3) How much of an order is never yours ───────────────
                       Tax over gross, by month. Bars rather than a chart
                       library: the shape is the point, and the numbers are
                       printed beside it for anyone who wants them. */
                    function taxShareRender() {
                      const el = document.getElementById('tax-share-chart');
                      if (!el) return;
                      const byMonth = {};
                      _taxOrders.forEach(o => {
                        const k = (o.created_at || '').slice(0, 7);
                        if (!k) return;
                        if (!byMonth[k]) byMonth[k] = { tax: 0, gross: 0 };
                        const tax = parseFloat(o.tax || 0);
                        byMonth[k].tax += tax;
                        byMonth[k].gross += parseFloat(o.subtotal || 0) + tax;
                      });
                      const months = Object.keys(byMonth).sort().slice(-12);
                      if (!months.length) { el.innerHTML = '<p style="font-size:13px;color:var(--text-secondary);">No orders yet.</p>'; return; }
                      const shares = months.map(m => byMonth[m].gross > 0 ? byMonth[m].tax / byMonth[m].gross : 0);
                      const peak = Math.max(...shares, 0.0001);
                      el.innerHTML = '<div style="display:flex;align-items:flex-end;gap:10px;height:120px;">'
                        + months.map((m, i) => {
                            const pct = shares[i];
                            const h = Math.max(2, Math.round((pct / peak) * 100));
                            return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;">'
                              + '<span style="font-size:11px;color:var(--text-secondary);font-variant-numeric:tabular-nums;">' + (pct * 100).toFixed(1) + '%</span>'
                              + '<div title="' + m + ' — ' + fmt$(byMonth[m].tax) + ' of ' + fmt$(byMonth[m].gross) + '" style="width:100%;background:var(--accent);opacity:.85;border-radius:4px 4px 0 0;height:' + h + '%;min-height:2px;"></div>'
                              + '<span style="font-size:10px;color:var(--text-secondary);">' + m.slice(5) + '/' + m.slice(2, 4) + '</span>'
                              + '</div>';
                          }).join('')
                        + '</div>';
                    }

                    window.taxDoLookup = async function() {
                      const state = (document.getElementById('tax-lkp-state').value||'').trim().toUpperCase();
                      const zip   = (document.getElementById('tax-lkp-zip').value||'').trim();
                      const el    = document.getElementById('tax-lkp-result');
                      if (!el) return;
                      if (!state) { el.innerHTML = '<p style="color:#f87171;font-size:13px;">Enter a state code.</p>'; return; }
                      if (NO_TAX.has(state)) {
                        el.innerHTML = `<div style="padding:14px;background:var(--bg-primary);border-radius:8px;font-size:13px;"><b>${STATE_NAMES[state]||state}</b> has no state sales tax.</div>`;
                        return;
                      }

                      /* ── Ask whoever is actually pricing ────────────────────
                         This card used to read the tables on this page and say
                         "exactly what rate your checkout applies". That was true
                         only while the table WAS the checkout. With Stripe Tax
                         in charge it kept answering — same confident number, no
                         longer connected to anything a customer pays.

                         /api/tax-quote runs the same resolveTax() the payment
                         path runs, so this is the checkout's own answer rather
                         than a second opinion that can drift from it. */
                      if (taxTableRole() !== 'primary') {
                        const engine = (document.getElementById('tax-engine-select') || {}).value || '';
                        const name = ((window.TAX_ENGINE_META || {})[engine] || {}).name || engine;
                        el.innerHTML = `<p style="font-size:13px;color:var(--text-secondary);">Asking ${name}…</p>`;
                        const live = await expectedRate(state, zip);
                        if (live == null) {
                          /* An unanswered quote is not a rate of zero, and must
                             never be shown as one. */
                          el.innerHTML = `<div style="padding:14px;background:var(--bg-primary);border-radius:8px;font-size:13px;line-height:1.7;">
                            <div style="color:#f59e0b;font-weight:600;margin-bottom:4px;">${name} did not answer</div>
                            <div style="color:var(--text-secondary);font-size:12px;">Checkout would fall back to the built-in table for this address if the fallback is on, or add no tax at all if it is off.</div>
                          </div>`;
                          return;
                        }
                        el.innerHTML = `<div style="padding:14px;background:var(--bg-primary);border-radius:8px;font-size:13px;line-height:1.8;">
                          <div style="font-size:24px;font-weight:700;color:var(--accent);margin-bottom:4px;">${fmtPct(live)}</div>
                          <div><b>${STATE_NAMES[state]||state}</b>${zip ? ' · ' + zip : ''}</div>
                          <div style="color:var(--text-secondary);font-size:12px;">Quoted by ${name}, the same call checkout makes.</div>
                        </div>`;
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

                        // The filing-period panel reads the same _taxOrders list.
                        await taxFilingsLoad();
                        try { window.taxPeriodRender(); } catch (_) {}
                        try { taxShareRender(); } catch (_) {}

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
                        renderOhioCounties();

                      } catch(e) { taxErr('Failed to load tax data: ' + e.message); }
                    };

                    /* ── Ohio, by county ───────────────────────────────────────
                       Its own function because the last column changes meaning
                       with the engine, and the engine can change after the
                       orders have already been drawn. Redrawing is cheaper than
                       leaving a column headed "Configured Rate" showing table
                       rates that nothing is charging any more. */
                    function renderOhioCounties() {
                      const ohWrap = document.getElementById('tax-oh-wrap');
                      if (!ohWrap) return;
                      const ohOrders = _taxOrders.filter(o => (o.ship_state||'').toUpperCase() === 'OH');
                      if (!ohOrders.length) { ohWrap.style.display = 'none'; return; }
                      ohWrap.style.display = 'block';

                      /* Only the table knows a "configured" rate. Under a
                         provider the honest figure is what was actually
                         collected on these orders — which is also the one worth
                         eyeballing, because a county drifting away from its
                         neighbours is how a misconfigured provider shows up. */
                      const configured = taxTableRole() === 'primary';
                      const th = document.getElementById('tax-oh-rate-th');
                      if (th) th.textContent = configured ? 'Configured Rate' : 'Rate Collected';

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
                      if (!ohTb) return;
                      ohTb.innerHTML = Object.entries(byCounty).sort((a,b)=>b[1].tax-a[1].tax).map(([county, d]) => {
                        /* A county with no taxable revenue has no effective
                           rate; an em dash is truer than 0.00%. */
                        const shown = configured ? fmtPct(d.rate)
                          : (d.subtotal > 0 ? fmtPct(d.tax / d.subtotal) : '—');
                        return `<tr class="zw-divider">
                              <td style="padding:10px 12px;font-weight:600;">${county}</td>
                              <td style="padding:10px 12px;color:var(--text-secondary);font-size:12px;">${[...d.zip3s].join(', ')}xx</td>
                              <td style="padding:10px 12px;text-align:right;">${d.orders.toLocaleString()}</td>
                              <td style="padding:10px 12px;text-align:right;">${fmt$(d.subtotal)}</td>
                              <td style="padding:10px 12px;text-align:right;font-weight:600;">${fmt$(d.tax)}</td>
                              <td style="padding:10px 12px;text-align:right;color:var(--text-secondary);">${shown}</td>
                            </tr>`;
                      }).join('');
                    }

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
                        <p style="font-size:11px;color:var(--text-secondary);margin-top:12px;">County changes apply at checkout as soon as they are saved. Verify at tax.ohio.gov.</p>`;

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
                        <p style="font-size:11px;color:var(--text-secondary);margin-top:12px;">ZIP3 changes apply at checkout as soon as they are saved. Verify at tax.illinois.gov.</p>`;

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
                      /* Only what has actually been edited, merged over what was
                         already saved.

                         This used to save { ...STATE_RATES, ...edits } — the
                         whole table, seeded from this file's own copy of it. So
                         changing one Ohio county wrote all fifty-one state rates
                         into site_settings as overrides, promoting this page's
                         copy over the server's defaults for every state at once.
                         Any drift between the two became live pricing on the
                         first save, and nothing in the UI said so.

                         Saving only the edits means the server stays the source
                         for everything nobody has deliberately changed. */
                      const payload = {
                        stateRates:    { ...(_reSaved.stateRates    || {}), ...(_reEdited.stateRates    || {}) },
                        ohCountyRates: { ...(_reSaved.ohCountyRates || {}), ...(_reEdited.ohCountyRates || {}) },
                        ilZip3Rates:   { ...(_reSaved.ilZip3Rates   || {}), ...(_reEdited.ilZip3Rates   || {}) },
                        flatRates:     { ...(_reSaved.flatRates     || {}), ...(_reEdited.flatRates     || {}) },
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
                      _reSaved = payload;
                      _reEdited = {};
                      /* Every rate here is read server-side at payment time, so
                         there is nothing left to redeploy — the old message told
                         admins their county edits would not apply until someone
                         shipped a build, which stopped being true when the
                         browser's copy of the table was deleted. */
                      taxReMsg('Saved. All of these apply at checkout immediately.');
                      // Reload active tab to clear diff indicators
                      const active = document.querySelector('[id^="tax-re-tab-"][style*="var(--accent)"]');
                      if (active) active.click();
                    };

                    /* The overrides exactly as stored, so a save can add to them
                       rather than replacing them with this file's copy of the
                       whole table. See taxReSave for why that mattered. */
                    let _reSaved = {};

                    /* Load what the SERVER will actually charge from, on Tax page
                       open. /api/tax-config returns `effective` — defaults, env
                       vars and saved overrides already merged by the same code
                       the payment path merges them with — so the numbers on this
                       page are the numbers customers get. The constants above
                       are only the shape of the form until this lands. */
                    async function taxReLoadSaved() {
                      try {
                        const r = await fetch('/api/tax-config', { cache: 'no-store' });
                        const cfg = r.ok ? await r.json() : null;
                        if (!cfg) return;

                        const { effective: eff, ...saved } = cfg;
                        _reSaved = saved || {};

                        if (eff) {
                          if (eff.stateRates) Object.assign(STATE_RATES, eff.stateRates);
                          if (eff.ohCounty)   Object.assign(OH_COUNTY,   eff.ohCounty);
                          if (eff.ilZip3)     Object.assign(IL_ZIP3,     eff.ilZip3);
                          if (eff.flat)       Object.assign(FLAT,        eff.flat);
                        }
                      } catch(_) {}
                    }

                    /* ── Which engine calculates the tax ──────────────────────────
                       site_settings.tax_engine, read server-side by _tax.js on
                       every payment. Nothing here is a secret: provider keys are
                       Cloudflare env vars, so the worst this setting can leak is
                       which service the store uses. What it CAN do is stop tax
                       being collected, so the two consequential choices — "none",
                       and turning the fallback off — say what they mean before
                       you can save them. */
                    const TAX_ENGINE_NOTES = {
                      builtin: 'Running the table below. Free, no third party involved, and accurate to the state — plus Ohio county and Illinois ZIP. Wrong wherever a city adds its own district rate or a state exempts clothing.',
                      stripe_tax: 'Uses the Stripe account this store already charges through, so there is no key to add and no extra signup. Stripe bills 0.5% of each transaction it calculates tax on. Turn it on in Stripe → Settings → Tax first, and register the states you have nexus in.',
                      taxjar: 'Add <b>TAXJAR_API_KEY</b> in Cloudflare → Pages → Settings → Environment variables, then redeploy. Knows clothing exemptions per state, which the table does not.',
                      taxcloud: 'The cheapest paid option — historically free or near-free for US sales tax, and it files in SST member states. Add <b>TAXCLOUD_API_LOGIN_ID</b> and <b>TAXCLOUD_API_KEY</b> in Cloudflare, then redeploy. Completed sales and refunds are reported automatically. Check their current pricing before switching.',
                      avalara: 'The one your accountant will name. Add <b>AVALARA_ACCOUNT_ID</b> and <b>AVALARA_LICENSE_KEY</b> in Cloudflare, and set <b>AVALARA_ENV</b> to <code>production</code> when you are ready — it points at the sandbox until you do. Quotes are uncommitted SalesOrders; the sale is filed as a committed SalesInvoice when it completes. Partial refunds must be reversed in AvaTax directly.',
                      ziptax: 'Add <b>ZIPTAX_API_KEY</b> in Cloudflare → Pages → Settings → Environment variables, then redeploy. A rate lookup by ZIP — better than the table, no filing or nexus tracking.',
                      external: 'Your endpoint receives <code>{ taxableCents, shippingCents, address }</code> and answers with <code>{ taxCents }</code>, or <code>{ taxAmount }</code> in dollars, or <code>{ rate }</code> — whichever is easiest. Set <b>TAX_API_KEY</b> in Cloudflare to have it sent as a bearer token. This is the route for Avalara, Sovos, or anything already running.',
                      none: '<b style="color:var(--error);">No tax will be added to any order.</b> Only correct if something outside this checkout collects it, or you genuinely have no obligation anywhere. The figures below will read zero from here on.',
                    };

                    let _taxEngineCfg = {
                      engine: 'builtin', fallback: true, endpoint: '',
                      defaultCategory: 'general', taxCodes: {}, reportSales: true,
                      companyCode: '', shadowEngine: '',
                    };

                    /* ── What the store sells, in nobody's vocabulary ──────────
                       Every provider has its own code for "this is clothing":
                       Stripe writes txcd_…, TaxJar writes a number, Avalara
                       writes something else. Tagging products with one
                       provider's codes is what makes a provider hard to leave,
                       so the category is neutral and each engine gets its own
                       code for it here.

                       It matters most for a clothing store: clothing is exempt
                       in PA, NJ and MN and exempt under $110 a garment in NY.
                       A provider not told the goods are clothing charges full
                       rate — which is most of what you are paying it to avoid.

                       Blank is a real answer, and the default: send no code and
                       the provider uses the default set in its own dashboard.
                       Nothing here is guessed at, because a wrong tax code is a
                       compliance error that looks like a working checkout. */
                    const TAX_CATEGORY_LABELS = {
                      general:  'General goods',
                      clothing: 'Clothing',
                      footwear: 'Footwear',
                      digital:  'Digital goods',
                      exempt:   'Not taxable',
                    };
                    const TAX_CODE_HELP = {
                      stripe_tax: { name: 'Stripe Tax', eg: 'txcd_…', where: 'stripe.com/docs/tax/tax-codes' },
                      taxjar:     { name: 'TaxJar',     eg: '20010',  where: 'developers.taxjar.com/api/reference/#categories' },
                    };

                    window.taxCategoryRender = function() {
                      const wrap = document.getElementById('tax-category-wrap');
                      if (!wrap) return;
                      const sel = document.getElementById('tax-engine-select');
                      const engine = sel ? sel.value : (_taxEngineCfg.engine || 'builtin');
                      const help = TAX_CODE_HELP[engine];

                      const options = Object.keys(TAX_CATEGORY_LABELS).map(function(k) {
                        return '<option value="' + k + '"' +
                          (k === (_taxEngineCfg.defaultCategory || 'general') ? ' selected' : '') +
                          '>' + TAX_CATEGORY_LABELS[k] + '</option>';
                      }).join('');

                      let html =
                        '<label for="tax-default-category" style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:5px;">Most of what you sell is</label>' +
                        '<select id="tax-default-category" style="padding:9px 12px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:13px;min-width:260px;">' + options + '</select>' +
                        '<p style="font-size:12px;color:var(--text-secondary);margin-top:6px;line-height:1.6;max-width:560px;">Used for every line on an order. Clothing is exempt in PA, NJ and MN, and exempt under $110 an item in New York — a provider that is not told will charge full rate on all of it.</p>';

                      if (!help) {
                        html += '<p style="font-size:12px;color:var(--text-secondary);margin-top:12px;">The table and Zip-Tax price by address only, so there are no product codes to set. Pick Stripe Tax or TaxJar to use categories.</p>';
                      } else {
                        const codes = (_taxEngineCfg.taxCodes || {})[engine] || {};
                        html += '<div style="margin-top:16px;"><div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;">' +
                          help.name + '’s code for each category — leave blank to use the default set in your ' + help.name + ' dashboard.</div>';
                        Object.keys(TAX_CATEGORY_LABELS).forEach(function(k) {
                          html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">' +
                            '<span style="font-size:12px;color:var(--text-primary);min-width:120px;">' + TAX_CATEGORY_LABELS[k] + '</span>' +
                            '<input data-taxcode="' + k + '" value="' + String(codes[k] || '').replace(/"/g, '&quot;') + '" placeholder="' + help.eg + '" ' +
                            'style="padding:7px 10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:12px;width:200px;">' +
                            '</div>';
                        });
                        html += '<p style="font-size:11px;color:var(--text-secondary);margin-top:8px;">Codes come from ' + help.where + '. Nothing is filled in for you — a wrong code collects the wrong tax and still looks like it worked.</p></div>';
                      }
                      wrap.innerHTML = html;
                    };

                    window.taxEngineOnChange = function() {
                      const sel = document.getElementById('tax-engine-select');
                      const engine = sel ? sel.value : 'builtin';
                      try { window.taxCategoryRender(); } catch (_) {}
                      const wrap = document.getElementById('tax-engine-endpoint-wrap');
                      if (wrap) wrap.style.display = engine === 'external' ? '' : 'none';
                      const note = document.getElementById('tax-engine-note');
                      if (note) note.innerHTML = TAX_ENGINE_NOTES[engine] || '';
                      /* The dropdown is hidden now, so this label is the only
                         thing telling you what is actually pricing orders. It
                         has to follow the same value the select holds, or the
                         page shows one engine while another does the work —
                         which is the failure this whole change exists to make
                         impossible. */
                      const cur = document.getElementById('tax-engine-current');
                      const meta = (window.TAX_ENGINE_META || {})[engine];
                      if (cur) cur.textContent = meta ? (meta.icon + '  ' + meta.name) : engine;
                      taxTableRelevance();
                    };

                    /* ── What the built-in table still is, once something else
                          is pricing orders ────────────────────────────────────
                       Three sections on this page — the rate lookup, the rate
                       reference and the rate editor — all answer one question:
                       what does the BUILT-IN table charge here. Put Stripe Tax
                       in charge and that question has a different answer, and
                       showing the table's answer beside it is not extra detail.
                       It is a second, confidently formatted, wrong number for
                       the same thing, under a heading that says "the figures
                       customers are actually charged".

                       Deleting them outright would be wrong too, and this is
                       the part worth being careful about: resolveTax() falls
                       back to this table when the provider cannot be reached,
                       so with the fallback on these rates DO price real orders
                       — rarely, and precisely when nobody is watching. That
                       makes them backup rates, not dead ones, and a backup you
                       cannot see is worse than one you can.

                       So: primary while the table is the engine, demoted to a
                       named backup while a provider is in charge, and gone when
                       nothing can reach them at all. */
                    /* Declared here, above everything that uses it, because it
                       now has two callers in different parts of this file — the
                       health banner and the engine intro paragraph. It was
                       defined beside the banner, which read fine until the
                       second caller appeared several hundred lines earlier and
                       got a ReferenceError at the moment it ran.

                       The engine names come from a fixed table in this file, so
                       nothing here is attacker-controlled today. Escaping anyway
                       because a string built by concatenation is exactly where
                       that stops being true — 'external' already carries a
                       user-entered endpoint, and the next engine added might
                       carry a user-entered name. */
                    function escH(v) {
                      return String(v == null ? '' : v)
                        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                    }

                    function taxTableRole() {
                      const sel = document.getElementById('tax-engine-select');
                      const engine = sel ? sel.value : 'builtin';
                      if (engine === 'builtin') return 'primary';
                      /* No tax is collected at all, so there is nothing for the
                         table to be a backup to. */
                      if (engine === 'none') return 'unused';
                      const fb = document.getElementById('tax-engine-fallback');
                      return (fb && !fb.checked) ? 'unused' : 'backup';
                    }

                    /* Expanding is per-card and lasts for the visit only. It is
                       deliberately not saved: the demoted state is the correct
                       one, and having it stick would quietly undo the change for
                       whoever opened it once. */
                    const _taxTableOpen = { rateref: false, rateeditor: false };
                    let _taxLastEngine = null;
                    window.taxTableExpand = function(which) {
                      _taxTableOpen[which] = !_taxTableOpen[which];
                      taxTableRelevance();
                    };

                    function taxTableRelevance() {
                      const role   = taxTableRole();
                      const sel    = document.getElementById('tax-engine-select');
                      const engine = sel ? sel.value : 'builtin';
                      const meta   = (window.TAX_ENGINE_META || {})[engine] || {};
                      const name   = meta.name || engine;

                      /* Quotes are cached per jurisdiction to keep one button
                         press from firing hundreds of calls. Those answers
                         belong to the engine that gave them, so a switch has to
                         drop them — otherwise the lookup and the collected-vs-
                         expected panel keep reporting the old engine's rates
                         under the new engine's name. */
                      if (_taxLastEngine !== null && _taxLastEngine !== engine) {
                        Object.keys(_expectedCache).forEach(function(k) { delete _expectedCache[k]; });
                      }
                      _taxLastEngine = engine;

                      /* Cards vanishing with no explanation is its own kind of
                         confusing, so say it here rather than leave a gap where
                         the rate editor used to be. taxEngineOnChange() rewrites
                         this note first, so appending is safe. */
                      const note = document.getElementById('tax-engine-note');
                      if (note && role === 'unused') {
                        note.innerHTML += '<br><span style="color:var(--text-secondary);">The rate reference and rate editor are hidden: nothing can reach the built-in table' +
                          (engine === 'none' ? '.' : ' while the fallback is off.') + '</span>';
                      }

                      /* The paragraph at the top of the card. It described the
                         built-in table permanently, which stopped being true the
                         moment anything else took over — and it sat directly
                         above a label naming the real engine, and above the
                         banner reporting on that engine's behaviour. Three
                         statements about the same thing, one of them wrong. */
                      const intro = document.getElementById('tax-engine-intro');
                      if (intro) {
                        intro.innerHTML = role === 'primary'
                          ? 'The built-in table is what runs unless you change this. It knows state rates, Ohio by county and Illinois by ZIP — it does not know city district rates, or that clothing is exempt in PA, NJ and MN and exempt under $110 in NY. If you already pay for a tax service, put it in charge here and the table steps aside.'
                          : '<b style="color:var(--text-primary);">' + escH(name) + '</b> prices every order. It is asked for a figure at checkout and again when the payment is taken, so what is displayed and what is charged come from the same answer.'
                            + (engine === 'none'
                              ? ' Nothing is collected and no rate is applied.'
                              : role === 'backup'
                                ? ' The built-in table below is kept as a backup and is used only when ' + escH(name) + ' cannot be reached.'
                                : ' The built-in table below cannot be reached at all — the fallback is off, so an outage fails the order rather than guessing.');
                      }

                      /* The lookup keeps its place — the question is still a
                         good one — but it must ask whoever is answering. */
                      const lkpDesc = document.getElementById('tax-lookup-desc');
                      if (lkpDesc) {
                        lkpDesc.innerHTML = role === 'primary'
                          ? 'Enter a state and ZIP to see exactly what rate your checkout applies.'
                          : 'Enter a state and ZIP and <b style="color:var(--text-primary);">' + name +
                            '</b> is asked what it would charge there — the same call checkout makes.';
                      }
                      /* A stale answer from the previous engine must not sit
                         under a heading naming the new one. */
                      const lkpOut = document.getElementById('tax-lkp-result');
                      if (lkpOut) lkpOut.innerHTML = '';

                      const cards = [
                        { key: 'rateref', card: 'tax-rateref-card', title: 'tax-rateref-title',
                          desc: 'tax-rateref-desc', demote: 'tax-rateref-demote',
                          hide: ['tax-rtabs', 'tax-rate-content'],
                          primaryTitle: 'Configured Rate Reference',
                          primaryDesc: 'The rates your server charges from, loaded live. Verify at the relevant state tax authority before each filing period.',
                          backupTitle: 'Backup Rates',
                          what: 'what the table would charge if it were asked' },
                        { key: 'rateeditor', card: 'tax-rateeditor-card', title: 'tax-rateeditor-title',
                          desc: 'tax-rateeditor-desc', demote: 'tax-rateeditor-demote',
                          hide: ['tax-re-actions', 'tax-re-msg', 'tax-re-tabs', 'tax-re-content'],
                          primaryTitle: 'Rate Editor',
                          primaryDesc: 'Edit any rate and click <b style="color:var(--text-primary);">Save Changes</b>. Every rate here — state, Ohio county and Illinois ZIP3 — applies at checkout immediately. These are the figures customers are actually charged.',
                          backupTitle: 'Backup Rates — Editor',
                          what: 'edit the rates the fallback would use' },
                      ];

                      cards.forEach(function(c) {
                        const card = document.getElementById(c.card);
                        if (!card) return;

                        if (role === 'unused') {
                          /* Nothing here can reach a customer. Hiding it whole
                             is the only honest option — a collapsed card still
                             implies it matters. */
                          card.classList.add('zw-off');
                          return;
                        }
                        card.classList.remove('zw-off');

                        const titleEl = document.getElementById(c.title);
                        const descEl  = document.getElementById(c.desc);
                        const demote  = document.getElementById(c.demote);
                        const open    = role === 'primary' || _taxTableOpen[c.key];

                        if (titleEl) titleEl.textContent = role === 'primary' ? c.primaryTitle : c.backupTitle;
                        if (descEl) {
                          descEl.innerHTML = role === 'primary' ? c.primaryDesc
                            : '<b style="color:var(--text-primary);">' + name + '</b> prices your orders. ' +
                              'These rates only apply if it cannot be reached, because <b style="color:var(--text-primary);">' +
                              'fall back to the built-in table</b> is on above — turn that off and this section goes away entirely.';
                        }

                        if (demote) {
                          demote.style.display = role === 'primary' ? 'none' : '';
                          if (role !== 'primary') {
                            demote.innerHTML =
                              '<button type="button" onclick="taxTableExpand(\'' + c.key + '\')" ' +
                              'style="padding:6px 13px;background:none;border:1px solid var(--border);border-radius:6px;' +
                              'color:var(--text-secondary);cursor:pointer;font-size:12px;margin-bottom:16px;">' +
                              (open ? 'Hide' : 'Show') + ' — ' + c.what + '</button>';
                          }
                        }

                        /* .zw-off rather than style.display: these are inline
                           display:flex rows, and clearing style.display would
                           silently turn them into blocks. */
                        c.hide.forEach(function(id) {
                          const el = document.getElementById(id);
                          if (el) el.classList.toggle('zw-off', !open);
                        });
                      });

                      /* The Ohio column header depends on the same answer. */
                      try { renderOhioCounties(); } catch (_) {}
                    }

                    /* ── Why this waits instead of giving up ───────────────────
                       admin-tax.js is loaded from inside the Tax page's markup,
                       which the browser reaches around a third of the way down
                       admin.html. admin-main.js — the thing that creates `sb` —
                       is the last script on the page. So this function ran with
                       no Supabase client, returned, and was never called again.

                       The result was not an error anywhere. _taxEngineCfg simply
                       kept its declared default of 'builtin', so the modal said
                       "Built-in table — in use now" and the label beside it said
                       the same, on every page load, no matter what was actually
                       saved. Change the engine and it took; come back and the
                       page said Built-in again. Indistinguishable from a setting
                       that would not save, and the store meanwhile really was
                       pricing every order with the engine you picked.

                       Bounded, because a client that has not appeared in ten
                       seconds is not going to, and a timer that never stops is
                       its own bug. */
                    function whenSupabaseReady(fn, tries) {
                      if (window.sb) { fn(); return; }
                      if ((tries || 0) >= 100) return;
                      setTimeout(function () { whenSupabaseReady(fn, (tries || 0) + 1); }, 100);
                    }

                    async function taxEngineLoad() {
                      if (!window.sb) { whenSupabaseReady(taxEngineLoad); return; }
                      try {
                        const { data } = await sb.from('site_settings').select('value')
                          .eq('key', 'tax_engine').maybeSingle();
                        let v = data && data.value;
                        if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
                        if (v && typeof v === 'object') {
                          _taxEngineCfg = {
                            engine: v.engine || 'builtin',
                            fallback: v.fallback !== false,
                            endpoint: v.endpoint || '',
                            defaultCategory: v.defaultCategory || 'general',
                            companyCode: v.companyCode || '',
                            shadowEngine: v.shadowEngine || '',
                            taxCodes: (v.taxCodes && typeof v.taxCodes === 'object') ? v.taxCodes : {},
                            reportSales: v.reportSales !== false,
                          };
                        }
                      } catch (_) {}
                      const sel = document.getElementById('tax-engine-select');
                      const fb  = document.getElementById('tax-engine-fallback');
                      const ep  = document.getElementById('tax-engine-endpoint');
                      if (sel) sel.value = _taxEngineCfg.engine;
                      if (fb)  fb.checked = _taxEngineCfg.fallback;
                      if (ep)  ep.value = _taxEngineCfg.endpoint;
                      const sh = document.getElementById('tax-shadow-select');
                      if (sh) sh.value = _taxEngineCfg.shadowEngine || '';
                      window.taxEngineOnChange();
                      taxEngineHealth();
                    }

                    /* ─── Is the engine actually collecting anything? ───────────
                       Every other control on this page reports what is
                       CONFIGURED. None of them could tell you what comes back.

                       That gap had a live cost. This store runs on Stripe Tax,
                       and Stripe Tax only charges tax in jurisdictions you have
                       registered in its dashboard — with none registered it
                       answers 200 OK, tax_amount_exclusive 0, for every address
                       on earth. Not an error, so the fallback never fires, the
                       log stays clean, and the admin page goes on saying
                       "💳 Stripe Tax" in confident green while the store
                       collects nothing anywhere. The first sign would have been
                       a filing.

                       A zero is a legitimate answer — Oregon has no sales tax,
                       clothing is exempt in Pennsylvania — so no single zero
                       means anything. Zero in all three of these does: they are
                       states that tax general goods AND clothing, so whatever
                       the store's default category is, something should come
                       back. Asking through /api/tax-quote rather than the
                       provider directly is the point: that is the same
                       resolveTax() the charge runs through, so this measures the
                       path customers are on, not a parallel one. */
                    /* Where the store is. NOT the same fact as "we have county
                       data for Ohio", which is what the other 'OH' literals in
                       this file mean — those belong to the rate table and would
                       stay put if the business moved. This one is nexus: the one
                       state tax is owed in from the first sale, with no
                       threshold to cross.

                       Server-side the authority is shipFromValue('STATE', env).
                       Naming it here rather than reading it is a knowing
                       shortcut — a second copy of a fact — and it is written
                       down so the next person can see the debt rather than
                       discover it. */
                    const HOME_STATE = 'OH';

                    const TAX_HEALTH_PROBES = [
                      { state: 'CA', zip: '90210', city: 'Beverly Hills' },
                      { state: 'TX', zip: '78701', city: 'Austin' },
                      { state: HOME_STATE, zip: '45202', city: 'Cincinnati' },
                    ];
                    const TAX_HEALTH_AMOUNT = 10000;   // $100.00 taxable
                    const TAX_HEALTH_SHIPPING = 800;   // $8.00 postage

                    async function taxEngineHealth() {
                      const box = document.getElementById('tax-engine-health');
                      if (!box) return;
                      const engine = (document.getElementById('tax-engine-select') || {}).value || 'builtin';
                      /* 'none' collecting nothing is the setting working. */
                      if (engine === 'none') { box.innerHTML = ''; return; }

                      const meta = (window.TAX_ENGINE_META || {})[engine] || {};
                      const name = meta.name || engine;
                      box.innerHTML = '<span style="font-size:12px;color:var(--text-secondary);">Checking what ' +
                        escH(name) + ' returns…</span>';

                      const results = await Promise.all(TAX_HEALTH_PROBES.map(async (p) => {
                        try {
                          const r = await fetch('/api/tax-quote?state=' + p.state + '&zip=' + p.zip +
                            '&city=' + encodeURIComponent(p.city) +
                            '&amount=' + TAX_HEALTH_AMOUNT + '&shipping=' + TAX_HEALTH_SHIPPING,
                            { cache: 'no-store' });
                          if (!r.ok) return { p, error: 'HTTP ' + r.status };
                          const j = await r.json();
                          if (j && j.unavailable) return { p, error: 'unavailable' };
                          return { p, cents: Number(j && j.taxCents) || 0, fallbackFrom: j && j.fallbackFrom };
                        } catch (e) {
                          return { p, error: (e && e.message) || 'failed' };
                        }
                      }));

                      const answered  = results.filter((r) => !r.error);
                      const collecting = answered.filter((r) => r.cents > 0);
                      const fellBack  = answered.filter((r) => r.fallbackFrom);

                      /* Could not ask. Say so plainly rather than show a green
                         tick nobody earned. */
                      if (!answered.length) {
                        box.innerHTML = healthBanner('#6b7280', '·',
                          'Could not check what ' + escH(name) + ' returns',
                          'The tax quote endpoint did not answer. This is a check on this page only — it does not mean checkout is affected.');
                        return;
                      }

                      /* ── The home state is not like the others ──────────────
                         A zero from California means "not registered there",
                         which is a normal and correct way to be. A zero from the
                         home state cannot mean that: physical nexus owes tax
                         from the first sale, with no threshold to cross and no
                         registration decision to make.

                         So the all-three-zero rule is not enough on its own. A
                         store that registers California and forgets its own
                         state collects on a minority of its orders and shows
                         green, which is a worse place to be than collecting
                         nothing — it looks solved. */
                      const home = answered.filter((r) => r.p.state === HOME_STATE)[0];
                      if (home && !home.cents && collecting.length) {
                        box.innerHTML = healthBanner('#ef4444', '!',
                          'No tax is being collected in ' + HOME_STATE + ', where this store is',
                          'A $100 order to ' + HOME_STATE + ' comes back at $0.00 — but ' +
                          collecting.map((r) => r.p.state).join(' and ') + ' collects, so the engine itself is working.' +
                          '<br><br>' + HOME_STATE + ' is where you have <b>physical nexus</b>: tax is owed there from the first sale, with no threshold to cross. ' +
                          (engine === 'stripe_tax'
                            ? 'Add it in <b>Stripe → Tax → Registrations</b> — this is the one registration that is never optional.'
                            : 'Register it with ' + escH(name) + ' — this is the one registration that is never optional.'));
                        return;
                      }

                      if (!collecting.length) {
                        const where = answered.map((r) => r.p.state).join(', ');
                        box.innerHTML = healthBanner('#ef4444', '!',
                          escH(name) + ' is returning no tax anywhere',
                          'A $100 order to ' + where + ' comes back at $0.00 tax. Those states tax what this store sells, so this is not an exemption — nothing is being collected on any order.' +
                          (engine === 'stripe_tax'
                            ? '<br><br><b>Almost always this:</b> Stripe Tax charges tax only where you have added a <b>registration</b>. With none added it answers zero for every address and reports no error, which is why nothing here went red until now. Fix it in <b>Stripe → Tax → Registrations</b>: add your home state first (you have physical nexus there), then any state the nexus table below shows you have crossed. Come back and reload this page to confirm.'
                            : '<br><br>Check that the provider account is active and that your collecting jurisdictions are registered with it.'));
                        return;
                      }

                      const parts = collecting.map((r) => r.p.state + ' $' + (r.cents / 100).toFixed(2));
                      const silent = answered.filter((r) => !r.cents).map((r) => r.p.state);
                      box.innerHTML = healthBanner('#34d399', '✓',
                        escH(name) + ' is returning tax',
                        'On a $100 order: ' + parts.join(', ') + '.' +
                        (silent.length ? ' Nothing in ' + silent.join(', ') + ' — expected if you are not registered there, or if what you sell is exempt.' : '') +
                        (fellBack.length ? '<br><br><b style="color:#f59e0b;">Answered by the backup table,</b> not by ' + escH(name) + ' — the provider could not be reached just now.' : ''));
                    }
                    window.taxEngineHealth = taxEngineHealth;

                    function healthBanner(colour, mark, title, body) {
                      return '<div style="display:flex;gap:10px;padding:12px 14px;border:1px solid ' + colour +
                        '55;background:' + colour + '14;border-radius:8px;max-width:640px;">' +
                        '<span style="color:' + colour + ';font-weight:700;line-height:1.5;">' + mark + '</span>' +
                        '<div style="font-size:12px;line-height:1.6;">' +
                        '<div style="color:' + colour + ';font-weight:600;margin-bottom:2px;">' + title + '</div>' +
                        '<div style="color:var(--text-secondary);">' + body + '</div></div></div>';
                    }

                    /* ─── Which engine, chosen deliberately ─────────────────────
                       This was a dropdown that saved on the spot. For a colour
                       that is right; for the thing deciding what every customer
                       is charged in tax it is not — one stray click and every
                       order from that moment is priced by something else, with
                       nothing afterwards to tell an accident from a decision.

                       The change now goes through a modal that says what each
                       engine actually is, and through /api/admin-control, which
                       wants an authorization code and writes an audit row. The
                       other settings on this page still save normally: they tune
                       an engine, they do not swap it. */
                    const TAX_ENGINE_META = {
                      builtin:    { icon: '📋', name: 'Built-in table', cost: 'Free',
                                    blurb: 'State-level rates kept in this repo. Cannot know county or city rates, or that clothing is exempt in some states.' },
                      stripe_tax: { icon: '💳', name: 'Stripe Tax', cost: '0.5% per transaction it prices',
                                    blurb: 'Uses the Stripe account you already charge through. No key, no signup. Enable it in Stripe → Settings → Tax first.' },
                      taxjar:     { icon: '🧮', name: 'TaxJar', cost: 'From about $19/mo',
                                    blurb: 'Needs TAXJAR_API_KEY. Strong reporting and filing.' },
                      taxcloud:   { icon: '☁️', name: 'TaxCloud', cost: 'Cheapest paid option',
                                    blurb: 'Needs TAXCLOUD_API_LOGIN_ID and KEY. Watch the transaction tiers.' },
                      avalara:    { icon: '🌍', name: 'Avalara AvaTax', cost: 'Enterprise pricing',
                                    blurb: 'Needs AVALARA_ACCOUNT_ID and LICENSE_KEY. The heaviest option here.' },
                      ziptax:     { icon: '📍', name: 'Zip-Tax', cost: 'Low monthly',
                                    blurb: 'Needs ZIPTAX_API_KEY. Rate lookup only — it files nothing for you.' },
                      external:   { icon: '🔌', name: 'My own endpoint', cost: 'Yours',
                                    blurb: 'Posts each cart to an https endpoint you run and uses what it returns.' },
                      none:       { icon: '🚫', name: 'Collect no tax', cost: 'Free',
                                    blurb: 'Every order is charged $0 tax. Only correct if something outside this checkout collects it, or you owe none anywhere.' },
                    };
                    window.TAX_ENGINE_META = TAX_ENGINE_META;

                    window.openTaxEngineModal = function() {
                      const cur = String((_taxEngineCfg && _taxEngineCfg.engine) || 'builtin');
                      const host = document.getElementById('tax-engine-modal');
                      if (!host) return;
                      host.querySelector('[data-te-list]').innerHTML = Object.keys(TAX_ENGINE_META).map(function(k) {
                        const m = TAX_ENGINE_META[k];
                        const on = k === cur;
                        return '<label class="te-option' + (on ? ' is-current' : '') + '">'
                          + '<input type="radio" name="te-engine" value="' + k + '"' + (on ? ' checked' : '') + '>'
                          + '<span class="te-icon">' + m.icon + '</span>'
                          + '<span class="te-body"><span class="te-name">' + m.name
                          + (on ? ' <em>— in use now</em>' : '') + '</span>'
                          + '<span class="te-blurb">' + m.blurb + '</span>'
                          + '<span class="te-cost">' + m.cost + '</span></span></label>';
                      }).join('');
                      const codeEl = host.querySelector('[data-te-code]');
                      if (codeEl) codeEl.value = '';
                      const st = host.querySelector('[data-te-status]');
                      if (st) st.textContent = '';
                      host.classList.add('open');
                    };

                    window.closeTaxEngineModal = function() {
                      const host = document.getElementById('tax-engine-modal');
                      if (host) host.classList.remove('open');
                    };

                    window.confirmTaxEngineChange = async function(btn) {
                      const host = document.getElementById('tax-engine-modal');
                      const st = host.querySelector('[data-te-status]');
                      const picked = host.querySelector('input[name="te-engine"]:checked');
                      const code = (host.querySelector('[data-te-code]') || {}).value || '';
                      if (!picked) return;
                      const engine = picked.value;
                      if (!code.trim()) {
                        st.style.color = 'var(--error)';
                        st.textContent = 'Enter the authorization code to confirm.';
                        return;
                      }
                      btn.disabled = true; btn.textContent = 'Changing…';
                      st.style.color = 'var(--text-secondary)';
                      st.textContent = 'Applying…';
                      try {
                        const { data: { session } } = await sb.auth.getSession();
                        const resp = await fetch('/api/admin-control', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            accessToken: session && session.access_token,
                            action: 'tax-engine', engine, code: code.trim(),
                          }),
                        });
                        const out = await resp.json();
                        if (!out.ok) throw new Error(out.error || 'Could not change the engine.');
                        st.style.color = 'var(--success, #4ade80)';
                        st.textContent = 'Changed. Every order from now on is priced by ' + engine + '.';
                        setTimeout(function() { window.closeTaxEngineModal(); taxEngineLoad(); }, 900);
                      } catch (e) {
                        st.style.color = 'var(--error)';
                        st.textContent = (e && e.message) || 'Could not change the engine.';
                      } finally { btn.disabled = false; btn.textContent = 'Change engine'; }
                    };

                    window.taxEngineSave = async function() {
                      const sel = document.getElementById('tax-engine-select');
                      const fb  = document.getElementById('tax-engine-fallback');
                      const ep  = document.getElementById('tax-engine-endpoint');
                      const status = document.getElementById('tax-engine-status');
                      const btn = document.getElementById('tax-engine-save');
                      const engine = sel ? sel.value : 'builtin';
                      const endpoint = ep ? ep.value.trim() : '';

                      if (engine === 'external' && !/^https:\/\//i.test(endpoint)) {
                        if (status) { status.style.color = 'var(--error)'; status.textContent = 'Enter the endpoint URL — it must be https.'; }
                        return;
                      }
                      if (engine === 'none' && !confirm('Collect no sales tax on any order?\n\nOnly do this if something outside this checkout collects it, or you have no obligation anywhere. Every order from now on will be charged $0 tax.')) return;
                      if (fb && !fb.checked && engine !== 'builtin' && engine !== 'none' &&
                          !confirm('Turn the fallback off?\n\nIf ' + engine + ' is unreachable when a customer pays, the order goes through with $0 tax rather than an approximate amount from the built-in table.')) return;

                      if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
                      try {
                        /* Spread the loaded config first: this used to save only
                           { engine, fallback, endpoint }, which would silently
                           drop the categories and tax codes below every time
                           anyone touched the engine picker. */
                        const catSel = document.getElementById('tax-default-category');
                        const codes = { ...(_taxEngineCfg.taxCodes || {}) };
                        const rows = document.querySelectorAll('#tax-category-wrap input[data-taxcode]');
                        if (rows.length) {
                          const forEngine = {};
                          rows.forEach(function(inp) {
                            const val = String(inp.value || '').trim();
                            if (val) forEngine[inp.dataset.taxcode] = val;
                          });
                          codes[engine] = forEngine;
                        }
                        const next = {
                          ..._taxEngineCfg,
                          engine,
                          fallback: fb ? fb.checked : true,
                          endpoint,
                          defaultCategory: catSel ? catSel.value : (_taxEngineCfg.defaultCategory || 'general'),
                          taxCodes: codes,
                          shadowEngine: (document.getElementById('tax-shadow-select') || {}).value || '',
                        };
                        const { error } = await sb.from('site_settings')
                          .upsert({ key: 'tax_engine', value: next }, { onConflict: 'key' });
                        if (error) throw error;
                        _taxEngineCfg = next;
                        if (typeof logAdminAudit === 'function') {
                          void logAdminAudit('settings.update', 'site_settings', 'tax_engine', { engine });
                        }
                        if (status) { status.style.color = 'var(--success, #4ade80)'; status.textContent = 'Saved — the next order is calculated by ' + engine + '.'; }
                      } catch (err) {
                        if (status) { status.style.color = 'var(--error)'; status.textContent = 'Could not save: ' + ((err && err.message) || 'unknown error'); }
                      } finally {
                        if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
                      }
                    };

                    // Auto-init calendar (no DB needed)
                    buildCalendar();
                    taxRateTab('OH', document.getElementById('tax-rtab-OH'));
                    /* Also re-read whenever the Tax page is opened: the engine
                       can be changed from the modal, or in another tab, and a
                       value read once at page load goes stale silently. */
                    window.taxEngineLoad = taxEngineLoad;
                    taxEngineLoad();
                  })();
