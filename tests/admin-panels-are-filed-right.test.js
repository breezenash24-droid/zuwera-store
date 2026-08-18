/* Panels filed under the wrong page.
 *
 * Two were plainly misfiled, and both had the same tell: the page they sat on
 * could not explain why they were there.
 *
 *   Campus hand-delivery was on COUPONS. It is not a discount — it decides
 *   whether an order gets a shipping label and a tracking email, it renders as
 *   a delivery option at checkout, and admin-orders.js lists it as a fulfilment
 *   method. Under Coupons it was a shipping setting nobody would look for.
 *
 *   Return Shipments was on SHIPPING while Returns & Exchanges was on RETURNS —
 *   one workflow split across two pages, so 'where is this return up to?' could
 *   not be answered from either.
 *
 * ── The failure mode a move like this creates ───────────────────────────────
 *
 * Both panels are filled by code that ran on the OLD page's activation hook. Move
 * the markup and the panel renders its empty state forever, unless you happen to
 * visit the page it came from first — which looks like a broken panel rather
 * than a missing wire. Both hooks are asserted here.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  \u2713 ' + n); } else { fail++; console.log('  \u2717 ' + n + (e ? '  - ' + e : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

const HTML = read('admin.html');
const MAIN = read('admin-main.js');
const COMMERCE = read('commerce-admin.js');
const SHIP = read('admin-shipping.js');

/* Which page block a given id sits inside. */
const pages = [];
{
  const re = /<div id=\"([a-zA-Z0-9_-]+)\" class=\"page[^\"]*\"[^>]*>/g;
  let m;
  while ((m = re.exec(HTML))) pages.push({ id: m[1], at: m.index });
}
function pageOf(needle) {
  const i = HTML.indexOf(needle);
  if (i < 0) return '(not found)';
  let owner = '(before any page)';
  for (const p of pages) if (p.at < i) owner = p.id;
  return owner;
}

console.log('\n  panels sit on the page that explains them\n');

console.log('  return shipments are with the returns they belong to');
{
  ok('the markup is on the Returns page', pageOf('ret-ship-tbody') === 'returns',
    'found on #' + pageOf('ret-ship-tbody'));
  ok('...and the shipping table stayed on Shipping', pageOf('ship-orders-tbody') === 'shipping',
    'found on #' + pageOf('ship-orders-tbody'));
  /* The wire, not just the markup. */
  ok('opening Returns loads it', MAIN.includes("if (typeof window.retShipLoad === 'function') window.retShipLoad();"),
    'otherwise it shows Loading... until somebody opens Shipping');
  ok('...and the loader is reachable from outside its module',
    SHIP.includes('window.retShipLoad = retShipLoad;'));
  ok('Shipping still says where it went', HTML.includes('open Returns'),
    'people who have gone to Shipping for this for months should be told, not left to hunt');
}

console.log('\n  hand-delivery is a shipping method, on the shipping page');
{
  ok('there is a mount for it on Shipping', pageOf('shipLocalDeliveryMount') === 'shipping',
    'found on #' + pageOf('shipLocalDeliveryMount'));
  ok('the coupons page no longer renders it',
    COMMERCE.includes('mount.innerHTML = renderPromotions();'),
    'Coupons renders coupons');
  ok('it is painted into its own mount', COMMERCE.includes("$('shipLocalDeliveryMount')"));
  ok('opening Shipping draws it', MAIN.includes("window.zwRenderLocalDelivery();"),
    'drawn only on the coupons hook, a store that never opens Coupons could not switch it on');
  ok('...and it loads the config it needs first', COMMERCE.includes('await loadCommerceData('),
    'the card reads state.config; painting before it is loaded shows the wrong ZIPs');

  /* saveSettings writes the whole commerce_config blob, and syncFromDom only
     reads fields that are ON the page. The two cards now live on two different
     pages, so this is the thing that would quietly wipe one from the other. */
  ok('saving from one page cannot blank the other',
    COMMERCE.includes("if ($('commercePromoList')) state.config.promotions = readPromotionsFromDom();")
      && COMMERCE.includes("const ldEnabled = $('ldEnabled');")
      && COMMERCE.includes('if (ldEnabled) {'),
    'syncFromDom must guard every field on its element being present');
  ok('the delivery card has its own binder', COMMERCE.includes('function bindLocalDeliveryEvents()'));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);