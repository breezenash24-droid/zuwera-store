/**
 * _gift-card-emails.js — the two emails a gift card generates on its own.
 *
 * ── WHY THESE ARE NOT PART OF THE ORDER CONFIRMATION ────────────────────────
 *
 * The codes already ride on the confirmation, and that was the whole delivery
 * mechanism: buy a card, and the only place it exists is a block halfway down a
 * receipt, under the items, above the shipping address. That is fine as a
 * record and poor as a gift. It cannot be forwarded to the person it is for
 * without also forwarding what was paid and where it ships to, and six months
 * later it is findable only by remembering which order it was on.
 *
 * So a card gets its own email that says one thing.
 *
 * ── AND WHY THE SECOND ONE IS NOT ALWAYS SENT ───────────────────────────────
 *
 * "Tell me when the card I bought gets used" is a reasonable thing to want and
 * an unreasonable thing to send unconditionally, because most gift cards are
 * bought by the person who then spends them. That person does not need to be
 * told they spent their own money — they are holding the receipt that says so,
 * with the gift-card line on it.
 *
 * The caller therefore sends this only when the spender is NOT the purchaser.
 * See sendGiftCardSpentNotice in _fulfil.js for how those two are compared.
 *
 * ── WHAT IT DELIBERATELY DOES NOT SAY ───────────────────────────────────────
 *
 * Not what was bought. Not where it shipped. Not who spent it. A gift card is
 * frequently given to somebody whose shopping is not the buyer's business, and
 * an email that reported it would turn a present into a tracking device. The
 * buyer gets the two numbers they have a legitimate interest in: how much came
 * off, and how much is left.
 */
import { renderEmailShell, fillTemplate } from './_email-theme.js';

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const money = (cents) => '$' + (Math.max(0, Number(cents) || 0) / 100).toFixed(2);

/* The last four characters only, built from a whitelist so nothing that
   survives could be markup. Enough to tell one card from another; not enough to
   spend, which matters because this one goes to somebody who may no longer be
   holding the card. */
export function maskCode(code) {
  return '••••' + String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-4);
}

/**
 * "Here is your gift card."
 *
 * Carries the FULL code, because the code is the card — an email about a gift
 * card that hides the number is a locked box with no key. Everything about how
 * these are handled follows from that: the footer says so plainly rather than
 * assuming the reader knows, since somebody who has never been sent one has no
 * reason to guess that forwarding it gives it away.
 */
export function buildGiftCardDelivered({ appearance, content, toName = '', cards = [], shopUrl = '', note = '' }) {
  const a = appearance;
  const list = (Array.isArray(cards) ? cards : []).filter((c) => c && c.code);
  const totalCents = list.reduce((sum, c) => sum + (Number(c.cents) || 0), 0);

  /* ── A NOTE FROM WHOEVER SENT IT ────────────────────────────────────────
     Free text written by an admin, so it is escaped and then has its line
     breaks put back — a message typed across three lines that arrives as one
     paragraph reads as machine-generated, which is the opposite of the point.

     Set apart from the store's own wording with a rule and italics, because a
     card issued to fix a bad experience is usually accompanied by an apology,
     and an apology that looks like boilerplate is worse than none. */
  const noteBlock = String(note || '').trim() ? `
    <tr><td style="padding:0 0 22px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="border-left:2px solid ${a.border};padding:2px 0 2px 16px;font-size:15px;line-height:1.75;color:${a.text};font-style:italic;">
          ${esc(String(note).trim()).replace(/\r?\n/g, '<br>')}
        </td></tr>
      </table>
    </td></tr>` : '';

  const codeBlocks = list.map((c) => `
    <tr><td style="padding:0 0 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="border:1px dashed ${a.border};border-radius:8px;">
        <tr>
          <td style="padding:16px 18px;font-family:${a.fontMono};font-size:19px;letter-spacing:.16em;color:${a.text};">${esc(c.code)}</td>
          <td style="padding:16px 18px;text-align:right;font-size:17px;font-weight:700;color:${a.text};white-space:nowrap;">${money(c.cents)}</td>
        </tr>
      </table>
    </td></tr>`).join('');

  /* Only when there is more than one card, because "1 card · $50.00" under a
     box that already says $50.00 is a line that exists to be ignored. */
  const totalRow = list.length > 1 ? `
    <tr><td style="padding:6px 2px 0;text-align:right;font-size:13px;color:${a.muted};">
      ${list.length} cards · ${money(totalCents)} in total
    </td></tr>` : '';

  const cta = shopUrl ? `
    <tr><td style="padding:22px 0 4px;">
      <a href="${esc(shopUrl)}" style="display:inline-block;background:${a.text};color:${a.bg};text-decoration:none;font-weight:700;font-size:13px;letter-spacing:.14em;text-transform:uppercase;padding:14px 34px;border-radius:3px;">Start shopping</a>
    </td></tr>` : '';

  const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    ${noteBlock}
    ${codeBlocks}
    ${totalRow}
    <tr><td style="padding:20px 0 0;font-size:14px;line-height:1.7;color:${a.muted};">
      Enter the code at checkout. It does not have to be spent all at once — whatever is left stays on the card for next time, and it never expires unless the store says so.
    </td></tr>
    ${cta}
  </table>`;

  return renderEmailShell(a, {
    kicker: content.kicker,
    heading: fillTemplate(content.heading, { name: toName, amount: money(totalCents) }),
    intro: fillTemplate(content.intro, { name: toName, amount: money(totalCents) }),
    bodyHtml: body,
    footer: content.footer,
  });
}

/**
 * "The card you bought has been used."
 *
 * Two numbers and nothing else. See the note at the top of the file for what is
 * left out and why.
 */
export function buildGiftCardSpent({ appearance, content, toName = '', code = '', spentCents = 0, remainingCents = 0, shopUrl = '' }) {
  const a = appearance;
  const vars = {
    name: toName,
    code: maskCode(code),
    amount: money(spentCents),
    balance: money(remainingCents),
  };

  const row = (label, value, strong) => `
    <tr>
      <td style="padding:9px 0;font-size:14px;color:${a.muted};">${label}</td>
      <td style="padding:9px 0;font-size:${strong ? '16px' : '14px'};font-weight:${strong ? '700' : '400'};text-align:right;color:${a.text};white-space:nowrap;">${value}</td>
    </tr>`;

  const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="border:1px solid ${a.border};border-radius:8px;padding:6px 18px;">
        ${row('Card', `<span style="font-family:${a.fontMono};letter-spacing:.12em;">${esc(vars.code)}</span>`, false)}
        ${row('Used', '−' + vars.amount, false)}
        <tr><td colspan="2" style="padding:0;"><div style="border-top:1px solid ${a.border};"></div></td></tr>
        ${row('Left on the card', vars.balance, true)}
      </table>
    </td></tr>
    ${Number(remainingCents) <= 0 ? `
    <tr><td style="padding:18px 0 0;font-size:14px;line-height:1.7;color:${a.muted};">
      That card is now empty. Nothing else will come off it.
    </td></tr>` : ''}
  </table>`;

  return renderEmailShell(a, {
    kicker: content.kicker,
    heading: fillTemplate(content.heading, vars),
    intro: fillTemplate(content.intro, vars),
    bodyHtml: body,
    footer: fillTemplate(content.footer, vars),
  });
}
