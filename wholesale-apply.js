/* Asking for a trade account, and seeing where the request got to.
 *
 * profiles.wholesale has always carried a status of 'applied', and nothing in
 * the store could write it. Every account was one an admin created by hand, so
 * the status described a step that could not happen and no buyer could start
 * the conversation.
 *
 * The write goes through /api/my-wholesale for a reason worth restating here:
 * migration 0024 puts a trigger on that column precisely so a shopper cannot
 * grant themselves trade pricing from a browser console. This file therefore
 * sends FIELDS and never a status — the server supplies 'applied' as a constant
 * — and it could not lie about that even if it tried.
 *
 * ── WHY THE TAB HIDES ITSELF ────────────────────────────────────────────────
 *
 * Most customers are not wholesale buyers and never will be. A permanently
 * visible "Wholesale" tab on a retail account is a question nobody asked. It
 * appears when there is something to show — an account, or an application in
 * flight — and otherwise only when the store has said it wants applications.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var _state = null;

  function money(cents) { return '$' + (Number(cents || 0) / 100).toFixed(2); }

  var TERM_LABEL = { prepaid: 'Prepaid', net15: 'Net 15', net30: 'Net 30', net60: 'Net 60' };

  async function token() {
    var sb = window.sb || window.supabaseClient;
    if (!sb || !sb.auth) return null;
    var res = await sb.auth.getSession();
    return (res && res.data && res.data.session && res.data.session.access_token) || null;
  }

  async function load() {
    var t = await token();
    if (!t) return null;
    try {
      var r = await fetch('/api/my-wholesale', { headers: { Authorization: 'Bearer ' + t } });
      var d = await r.json();
      return (d && d.ok) ? d : null;
    } catch (_) { return null; }
  }

  function approvedView(s) {
    return '<h2 style="margin:0 0 .6rem;">Your trade account</h2>'
      + '<p style="opacity:.75;line-height:1.7;margin:0 0 1rem;">'
      + 'Trade prices are applied automatically while you are signed in. You do not need a code.'
      + '</p>'
      + '<div style="border:1px solid rgba(34,197,94,.4);background:rgba(34,197,94,.08);'
      + 'border-radius:8px;padding:.9rem 1rem;line-height:1.8;">'
      + '<div><strong>Open</strong>' + (s.company ? ' — ' + esc(s.company) : '') + '</div>'
      + (s.minOrderCents > 0
          ? '<div>Order minimum: <strong>' + money(s.minOrderCents) + '</strong> of goods, '
            + 'before shipping and tax.</div>'
          : '<div>No order minimum.</div>')
      + (s.terms
          ? '<div>Payment terms on file: <strong>' + esc(TERM_LABEL[s.terms] || s.terms) + '</strong>'
            /* Said plainly, because the alternative is a buyer expecting an
               invoice and meeting a card form at the end of checkout. */
            + (s.terms !== 'prepaid'
                ? ' <span style="opacity:.7;">— checkout still takes payment today; '
                  + 'terms are recorded for our records.</span>'
                : '')
            + '</div>'
          : '')
      + '</div>';
  }

  function appliedView() {
    return '<h2 style="margin:0 0 .6rem;">Application received</h2>'
      + '<div style="border:1px solid rgba(251,191,36,.4);background:rgba(251,191,36,.08);'
      + 'border-radius:8px;padding:.9rem 1rem;line-height:1.7;">'
      + 'We have your details and will be in touch. Nothing changes on your account until it is approved — '
      + 'you can keep ordering at the usual prices in the meantime.'
      + '</div>';
  }

  function suspendedView() {
    return '<h2 style="margin:0 0 .6rem;">Trade account suspended</h2>'
      + '<div style="border:1px solid rgba(239,68,68,.4);background:rgba(239,68,68,.08);'
      + 'border-radius:8px;padding:.9rem 1rem;line-height:1.7;">'
      + 'This account is on hold and is being charged the usual prices. Please get in touch — '
      + 're-applying will not lift it.'
      + '</div>';
  }

  function formView() {
    return '<h2 style="margin:0 0 .6rem;">Buying for a business?</h2>'
      + '<p style="opacity:.75;line-height:1.7;margin:0 0 1rem;max-width:56ch;">'
      + 'Tell us about the business and we will look at opening a trade account. '
      + 'Approved accounts see trade prices automatically when signed in.'
      + '</p>'
      + '<div style="max-width:32rem;">'
      + '<label class="zw-label" for="wa-company">Business name</label>'
      + '<input id="wa-company" class="zw-input" type="text" autocomplete="organization" required>'
      + '<label class="zw-label" for="wa-tax" style="margin-top:.8rem;">Tax or company number '
      + '<span style="opacity:.6;font-weight:400;">optional</span></label>'
      + '<input id="wa-tax" class="zw-input" type="text">'
      + '<label class="zw-label" for="wa-notes" style="margin-top:.8rem;">Anything else '
      + '<span style="opacity:.6;font-weight:400;">optional</span></label>'
      + '<textarea id="wa-notes" class="zw-input" rows="3" '
      + 'placeholder="Where you sell, roughly what volumes"></textarea>'
      + '<button class="zw-btn" id="wa-submit" style="margin-top:1rem;">Send application</button>'
      + '<div id="wa-msg" style="margin-top:.7rem;font-size:.85rem;line-height:1.6;"></div>'
      + '</div>';
  }

  function render() {
    var host = $('trade-content');
    var tab = $('acct-tab-trade');
    if (!host) return;
    var s = _state;
    if (!s || !s.signedIn) { host.innerHTML = ''; return; }

    var status = String(s.status || '');
    if (status === 'approved') host.innerHTML = approvedView(s);
    else if (status === 'applied') host.innerHTML = appliedView();
    else if (status === 'suspended') host.innerHTML = suspendedView();
    else host.innerHTML = formView();

    /* ── WHO SEES THIS TAB ────────────────────────────────────────────────
       Everyone signed in, until now — every retail customer got a "Wholesale"
       tab inviting them to open a trade account, whether or not the store
       wanted trade applications at all. It looked like a bug because from the
       shop owner's side it is one: a lead-generation form nobody asked to
       publish, sitting between Gift Cards and Profile.

       Now: a customer who ALREADY has a trade account always sees it — that is
       their account and hiding it would strand them — and everybody else sees
       the application form only when the store is accepting applications.

       Default OFF, matching every other feature switch here. A store that has
       not decided has not opted in. */
    if (tab) {
      var known = status === 'approved' || status === 'applied' || status === 'suspended';
      var show = known || s.acceptingApplications === true;
      tab.style.display = show ? '' : 'none';
      tab.textContent = status === 'approved' ? 'Trade Account' : 'Wholesale';
      /* A hidden tab must not stay selected, or the panel is the only thing on
         screen with no way back to it. */
      if (!show && tab.classList.contains('active')) {
        var orders = document.querySelector('.acct-tab[data-tab="orders"]');
        if (orders) orders.click();
      }
    }

    var btn = $('wa-submit');
    if (btn) btn.addEventListener('click', submit);
  }

  async function submit() {
    var btn = $('wa-submit');
    var msg = $('wa-msg');
    var company = ($('wa-company') && $('wa-company').value || '').trim();
    if (!company) {
      if (msg) { msg.textContent = 'Tell us the business name.'; msg.style.color = '#ef4444'; }
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      var t = await token();
      var r = await fetch('/api/my-wholesale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
        body: JSON.stringify({
          company: company,
          taxId: ($('wa-tax') && $('wa-tax').value) || '',
          notes: ($('wa-notes') && $('wa-notes').value) || '',
        }),
      });
      var d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || 'Could not send that.');
      /* Re-read rather than assume: the server decides the status, and a page
         that painted 'applied' from its own optimism would disagree with it the
         moment anything was refused. */
      _state = await load();
      render();
    } catch (err) {
      if (msg) { msg.textContent = err.message || 'Could not send that.'; msg.style.color = '#ef4444'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Send application'; }
    }
  }

  async function boot() {
    _state = await load();
    /* Nothing to say to a signed-out visitor, and nothing to say to a retail
       customer on a store that is not taking applications. The tab stays
       hidden in both cases rather than offering an empty panel. */
    if (!_state || !_state.signedIn) return;
    if (!_state.status && window.zwFlag && !window.zwFlag('wholesale_applications')) return;
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else { boot(); }

  window.ZWWholesaleApply = { reload: async function () { _state = await load(); render(); } };
}());
