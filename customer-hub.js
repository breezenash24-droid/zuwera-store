(function () {
  const MODAL_ID = 'account-modal';
  const HUB_STYLE_ID = 'customer-hub-style';
  let lastPayload = null;

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function injectStyles() {
    if (document.getElementById(HUB_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = HUB_STYLE_ID;
    style.textContent = `
      .zw-hub-stack { display:flex; flex-direction:column; gap:0.9rem; }
      .zw-hub-card { border:1px solid rgba(244,241,235,0.1); border-radius:12px; padding:0.95rem 1rem; background:rgba(255,255,255,0.02); }
      .zw-hub-title { font-size:0.8rem; letter-spacing:0.08em; text-transform:uppercase; opacity:0.6; margin-bottom:0.4rem; }
      .zw-hub-meta { font-size:0.78rem; opacity:0.65; line-height:1.5; }
      .zw-hub-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:0.8rem; }
      .zw-hub-field { display:flex; flex-direction:column; gap:0.35rem; margin-bottom:0.8rem; }
      .zw-hub-field input, .zw-hub-field textarea, .zw-hub-field select {
        width:100%; border:1px solid rgba(244,241,235,0.14); background:rgba(255,255,255,0.03);
        color:inherit; border-radius:10px; padding:0.7rem 0.8rem; font:inherit;
      }
      .zw-hub-actions { display:flex; gap:0.65rem; flex-wrap:wrap; margin-top:0.8rem; }
      .zw-hub-btn {
        border:1px solid rgba(244,241,235,0.16); background:rgba(255,255,255,0.04); color:inherit;
        border-radius:999px; padding:0.62rem 0.95rem; cursor:pointer; font:inherit;
      }
      .zw-hub-btn.primary { background:#f38fa9; color:#0f0f12; border-color:#f38fa9; font-weight:700; }
      .zw-hub-empty { opacity:0.6; font-size:0.82rem; padding:0.75rem 0; }
      .zw-hub-badge { display:inline-flex; align-items:center; gap:0.35rem; border-radius:999px; padding:0.25rem 0.55rem; font-size:0.72rem; background:rgba(243,143,169,0.14); color:#f38fa9; }
      .zw-hub-status { font-size:0.76rem; opacity:0.72; }
      .zw-hub-address { border:1px solid rgba(244,241,235,0.08); border-radius:10px; padding:0.8rem; margin-bottom:0.7rem; }
      .zw-hub-check { display:flex; align-items:center; gap:0.55rem; margin-bottom:0.8rem; font-size:0.86rem; }
      .zw-hub-check input { width:auto; }
    `;
    document.head.appendChild(style);
  }

  function getModal() {
    return document.getElementById(MODAL_ID);
  }

  function getTabsWrap(modal) {
    return modal?.querySelector('.atabs');
  }

  function getPanelClassName(modal) {
    return (modal?.querySelector('[id^="acct-panel-"]')?.className || 'apanel')
      .split(/\s+/)
      .filter((name) => name && name !== 'active')
      .join(' ');
  }

  function getTabClassName(modal) {
    return (modal?.querySelector('[data-acctab]')?.className || 'atab')
      .split(/\s+/)
      .filter((name) => name && name !== 'active')
      .join(' ');
  }

  function ensurePanels() {
    const modal = getModal();
    const tabsWrap = getTabsWrap(modal);
    if (!modal || !tabsWrap) return false;

    injectStyles();

    const tabClassName = getTabClassName(modal);
    const panelClassName = getPanelClassName(modal);

    [
      { tab: 'returns', label: 'Returns' },
      { tab: 'profile', label: 'Profile' },
    ].forEach((entry) => {
      if (!tabsWrap.querySelector(`[data-acctab="${entry.tab}"]`)) {
        const btn = document.createElement('button');
        btn.className = tabClassName;
        btn.dataset.acctab = entry.tab;
        btn.textContent = entry.label;
        tabsWrap.appendChild(btn);
      }
      if (!modal.querySelector(`#acct-panel-${entry.tab}`)) {
        const panel = document.createElement('div');
        panel.id = `acct-panel-${entry.tab}`;
        panel.className = panelClassName;
        panel.innerHTML = entry.tab === 'returns'
          ? `<div class="zw-hub-stack">
              <div id="zw-returns-loading" class="zw-hub-empty">Loading return portal...</div>
              <div id="zw-returns-content"></div>
            </div>`
          : `<div class="zw-hub-stack">
              <div id="zw-profile-loading" class="zw-hub-empty">Loading customer profile...</div>
              <div id="zw-profile-content"></div>
            </div>`;
        modal.querySelector('.mbox')?.appendChild(panel);
      }
    });

    return true;
  }

  async function getSession() {
    const sb = window.sb || window._sb || null;
    if (!sb?.auth?.getSession) return null;
    const result = await sb.auth.getSession().catch(() => null);
    return result?.data?.session || null;
  }

  async function fetchHubData() {
    const session = await getSession();
    if (!session?.access_token) return null;
    const resp = await fetch('/api/customer-hub', {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok || !payload?.success) throw new Error(payload?.error || 'Could not load customer portal.');
    lastPayload = payload;
    return { session, payload };
  }

  function renderReturns(payload) {
    const host = document.getElementById('zw-returns-content');
    const loading = document.getElementById('zw-returns-loading');
    if (!host) return;
    if (loading) loading.style.display = 'none';

    const orders = Array.isArray(payload?.orders) ? payload.orders : [];
    const requests = Array.isArray(payload?.returns) ? payload.returns : [];
    const options = orders.map((order) => {
      const orderId = String(order.id || '');
      const label = `#${orderId.slice(-8).toUpperCase()} - ${new Date(order.created_at || Date.now()).toLocaleDateString()}`;
      return `<option value="${escapeHtml(orderId)}">${escapeHtml(label)}</option>`;
    }).join('');

    host.innerHTML = `
      <div class="zw-hub-card">
        <div class="zw-hub-title">Self-Serve Returns & Exchanges</div>
        <div class="zw-hub-meta">Start a return or exchange request without emailing support. Your admin team can approve, refund, or swap from the commerce hub.</div>
      </div>
      <div class="zw-hub-card">
        <div class="zw-hub-field">
          <label>Order</label>
          <select id="zw-return-order">${options || '<option value="">No eligible orders yet</option>'}</select>
        </div>
        <div class="zw-hub-grid">
          <div class="zw-hub-field">
            <label>Resolution</label>
            <select id="zw-return-resolution">
              <option value="return">Return for refund</option>
              <option value="exchange">Exchange</option>
              <option value="store_credit">Store credit</option>
            </select>
          </div>
          <div class="zw-hub-field">
            <label>Reason</label>
            <input id="zw-return-reason" type="text" placeholder="Wrong size, damaged item, changed mind">
          </div>
        </div>
        <div class="zw-hub-field">
          <label>Notes</label>
          <textarea id="zw-return-notes" rows="3" placeholder="Anything the team should know about this request"></textarea>
        </div>
        <div class="zw-hub-actions">
          <button id="zw-return-submit" class="zw-hub-btn primary" ${orders.length ? '' : 'disabled'}>Submit Request</button>
          <span id="zw-return-status" class="zw-hub-status"></span>
        </div>
      </div>
      <div class="zw-hub-card">
        <div class="zw-hub-title">Request History</div>
        ${requests.length ? requests.map((request) => `
          <div class="zw-hub-address">
            <div style="display:flex;justify-content:space-between;gap:0.75rem;align-items:center;">
              <strong>${escapeHtml(request.orderLabel || '#' + String(request.orderId || '').slice(-8).toUpperCase())}</strong>
              <span class="zw-hub-badge">${escapeHtml(request.status || 'requested')}</span>
            </div>
            <div class="zw-hub-meta" style="margin-top:0.4rem;">
              ${escapeHtml(request.resolution)} - ${escapeHtml(request.reason)}<br>
              ${request.notes ? `${escapeHtml(request.notes)}<br>` : ''}
              ${new Date(request.createdAt || Date.now()).toLocaleString()}
            </div>
          </div>
        `).join('') : '<div class="zw-hub-empty">No return or exchange requests yet.</div>'}
      </div>
    `;

    const submitBtn = document.getElementById('zw-return-submit');
    submitBtn?.addEventListener('click', submitReturnRequest);
  }

  function renderProfile(payload) {
    const host = document.getElementById('zw-profile-content');
    const loading = document.getElementById('zw-profile-loading');
    if (!host) return;
    if (loading) loading.style.display = 'none';

    const profile = payload?.profile || {};
    const addresses = Array.isArray(profile.savedAddresses) ? profile.savedAddresses : [];

    host.innerHTML = `
      <div class="zw-hub-card">
        <div class="zw-hub-title">Customer Profile & CRM</div>
        <div class="zw-hub-meta">Manage saved addresses, preferred contact channel, and marketing consent from your account.</div>
      </div>
      <div class="zw-hub-card">
        <div id="zw-addresses-list">
          ${addresses.length ? addresses.map((address, index) => `
            <div class="zw-hub-address" data-address-index="${index}">
              <div style="display:flex;justify-content:space-between;gap:0.75rem;align-items:center;">
                <strong>${escapeHtml(address.label || 'Address')}</strong>
                ${address.isPrimary ? '<span class="zw-hub-badge">Primary</span>' : ''}
              </div>
              <div class="zw-hub-meta" style="margin-top:0.4rem;">
                ${[address.name, address.line1, address.line2, `${address.city || ''}${address.city && address.state ? ', ' : ''}${address.state || ''} ${address.zip || ''}`, address.country].filter(Boolean).map(escapeHtml).join('<br>')}
              </div>
            </div>
          `).join('') : '<div class="zw-hub-empty">No saved addresses yet. Add one below.</div>'}
        </div>
        <div class="zw-hub-grid">
          <div class="zw-hub-field"><label>Address label</label><input id="zw-profile-label" type="text" placeholder="Home, Studio, Gift address"></div>
          <div class="zw-hub-field"><label>Recipient name</label><input id="zw-profile-name" type="text" placeholder="Jane Smith"></div>
        </div>
        <div class="zw-hub-field"><label>Address line 1</label><input id="zw-profile-line1" type="text" placeholder="123 Main St"></div>
        <div class="zw-hub-field"><label>Address line 2</label><input id="zw-profile-line2" type="text" placeholder="Apartment, suite, etc."></div>
        <div class="zw-hub-grid">
          <div class="zw-hub-field"><label>City</label><input id="zw-profile-city" type="text" placeholder="New York"></div>
          <div class="zw-hub-field"><label>State</label><input id="zw-profile-state" type="text" maxlength="2" placeholder="NY"></div>
          <div class="zw-hub-field"><label>ZIP</label><input id="zw-profile-zip" type="text" placeholder="10001"></div>
        </div>
        <div class="zw-hub-grid">
          <div class="zw-hub-field">
            <label>Preferred channel</label>
            <select id="zw-profile-channel">
              <option value="email" ${profile.preferredChannel === 'email' ? 'selected' : ''}>Email</option>
              <option value="sms" ${profile.preferredChannel === 'sms' ? 'selected' : ''}>SMS</option>
              <option value="both" ${profile.preferredChannel === 'both' ? 'selected' : ''}>Both</option>
            </select>
          </div>
          <div class="zw-hub-field">
            <label>CRM notes</label>
            <input id="zw-profile-notes" type="text" value="${escapeHtml(profile.notes || '')}" placeholder="VIP, launch-day shopper, prefers SMS">
          </div>
        </div>
        <label class="zw-hub-check"><input id="zw-profile-marketing" type="checkbox" ${profile.marketingConsent ? 'checked' : ''}> Email marketing consent</label>
        <label class="zw-hub-check"><input id="zw-profile-sms" type="checkbox" ${profile.smsConsent ? 'checked' : ''}> SMS marketing consent</label>
        <div class="zw-hub-actions">
          <button id="zw-profile-save" class="zw-hub-btn primary">Save Profile</button>
          <span id="zw-profile-status" class="zw-hub-status"></span>
        </div>
      </div>
    `;

    document.getElementById('zw-profile-save')?.addEventListener('click', saveProfile);
  }

  async function postHub(action, payload) {
    const session = await getSession();
    if (!session?.access_token) throw new Error('Please sign in again.');
    const resp = await fetch('/api/customer-hub', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ action, ...payload }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.success) throw new Error(data?.error || 'Update failed.');
    return data;
  }

  async function submitReturnRequest() {
    const status = document.getElementById('zw-return-status');
    const orderSelect = document.getElementById('zw-return-order');
    const reason = document.getElementById('zw-return-reason');
    const resolution = document.getElementById('zw-return-resolution');
    const notes = document.getElementById('zw-return-notes');
    const label = orderSelect?.selectedOptions?.[0]?.textContent || '';
    if (status) status.textContent = 'Submitting...';
    try {
      await postHub('submit_return', {
        orderId: orderSelect?.value || '',
        orderLabel: label,
        resolution: resolution?.value || 'return',
        reason: reason?.value || '',
        notes: notes?.value || '',
      });
      if (status) status.textContent = 'Request submitted.';
      await loadHub(true);
    } catch (error) {
      if (status) status.textContent = error.message || 'Could not submit request.';
    }
  }

  async function saveProfile() {
    const status = document.getElementById('zw-profile-status');
    if (status) status.textContent = 'Saving...';
    try {
      const existingAddresses = Array.isArray(lastPayload?.profile?.savedAddresses) ? [...lastPayload.profile.savedAddresses] : [];
      const line1 = document.getElementById('zw-profile-line1')?.value?.trim() || '';
      if (line1) {
        existingAddresses.unshift({
          label: document.getElementById('zw-profile-label')?.value || 'Address',
          name: document.getElementById('zw-profile-name')?.value || '',
          line1,
          line2: document.getElementById('zw-profile-line2')?.value || '',
          city: document.getElementById('zw-profile-city')?.value || '',
          state: document.getElementById('zw-profile-state')?.value || '',
          zip: document.getElementById('zw-profile-zip')?.value || '',
          country: 'US',
          isPrimary: true,
        });
      }
      const deduped = existingAddresses.filter((address, index, list) => {
        const key = [address.line1, address.city, address.state, address.zip].join('|').toLowerCase();
        return key !== '|||' && list.findIndex((item) => [item.line1, item.city, item.state, item.zip].join('|').toLowerCase() === key) === index;
      }).slice(0, 5);

      await postHub('save_profile', {
        addresses: deduped,
        marketingConsent: document.getElementById('zw-profile-marketing')?.checked,
        smsConsent: document.getElementById('zw-profile-sms')?.checked,
        preferredChannel: document.getElementById('zw-profile-channel')?.value || 'email',
        notes: document.getElementById('zw-profile-notes')?.value || '',
      });
      if (status) status.textContent = 'Profile saved.';
      await loadHub(true);
    } catch (error) {
      if (status) status.textContent = error.message || 'Could not save profile.';
    }
  }

  async function loadHub(force = false) {
    if (!ensurePanels()) return;
    if (lastPayload && !force) {
      renderReturns(lastPayload);
      renderProfile(lastPayload);
      return;
    }
    try {
      const response = await fetchHubData();
      if (!response?.payload) return;
      renderReturns(response.payload);
      renderProfile(response.payload);
    } catch (error) {
      const returnsLoading = document.getElementById('zw-returns-loading');
      const profileLoading = document.getElementById('zw-profile-loading');
      if (returnsLoading) returnsLoading.textContent = error.message || 'Could not load return portal.';
      if (profileLoading) profileLoading.textContent = error.message || 'Could not load customer profile.';
    }
  }

  function activateTab(tab) {
    const modal = getModal();
    if (!modal) return;
    modal.querySelectorAll('[data-acctab]').forEach((button) => {
      button.classList.toggle('active', button.dataset.acctab === tab);
    });
    modal.querySelectorAll('[id^="acct-panel-"]').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `acct-panel-${tab}`);
    });
  }

  function bindAccountTriggers() {
    document.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-acctab]');
      if (trigger?.dataset?.acctab) {
        activateTab(trigger.dataset.acctab);
      }
      if (trigger?.dataset?.acctab === 'returns' || trigger?.dataset?.acctab === 'profile') {
        setTimeout(() => loadHub(false), 30);
      }
      if (event.target.closest('#account-btn')) {
        setTimeout(() => loadHub(false), 120);
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    ensurePanels();
    bindAccountTriggers();
  });
})();
