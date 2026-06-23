/**
 * Zuwera backup -> Google Sheet (one tab per table), refreshed daily, formatted
 * for readability: friendly tab names, an Overview dashboard, styled frozen
 * headers, banded rows, tidy column widths, currency formatting, and color-coded
 * tabs. Re-running migrates old raw-named tabs in place (no duplicates).
 *
 * SETUP: Script Properties BACKUP_URL + BACKUP_TOKEN, then run `setup` once.
 */

var SUMMARY_NAME = 'Overview';
var HEADER_BG = '#09090b', HEADER_FG = '#ffffff';

// Raw table name -> friendly tab name.
var DISPLAY = {
  orders: 'Orders', returns: 'Returns', promotions: 'Coupons',
  refund_audit_log: 'Refunds', order_ops: 'Order Edits',
  auth_users: 'Customers (logins)', profiles: 'Customer Profiles',
  customer_profiles: 'Customer Notes', reviews: 'Reviews',
  waitlist: 'Waitlist', restock_requests: 'Restock Requests', favorites: 'Favorites',
  products: 'Products', color_variants: 'Colors', product_images: 'Product Images',
  product_sizes: 'Sizes & Stock', size_charts: 'Size Charts', inventory: 'Inventory',
  webhook_events: 'Payment Events', admin_audit_log: 'Admin Activity',
  zw_banned_words: 'Banned Words', site_settings: 'Settings & Content',
  return_requests: 'Returns (legacy table)'
};
// Plain-language descriptions for the Overview tab.
var DESCRIPTION = {
  orders: 'Every order — items, totals, shipping address, status',
  returns: 'Return & exchange requests', promotions: 'Discount / coupon codes',
  refund_audit_log: 'Refunds you have issued', order_ops: 'Manual order edits (status, refunds, tracking)',
  auth_users: 'Customer login accounts (email, last sign-in)', profiles: 'Customer profiles',
  customer_profiles: 'Per-customer admin notes / overlays', reviews: 'Product reviews',
  waitlist: 'Email sign-ups', restock_requests: 'Back-in-stock requests', favorites: 'Saved items',
  products: 'Product catalog', color_variants: 'Product colorways', product_images: 'Product photos',
  product_sizes: 'Sizes and stock counts', size_charts: 'Size chart data', inventory: 'Stock levels',
  webhook_events: 'Stripe payment events (reconciliation)', admin_audit_log: 'Admin action history',
  zw_banned_words: 'Review moderation word list', site_settings: 'Store settings & page content',
  return_requests: 'Empty legacy table — real returns are the Returns tab'
};
// Tab display order (most useful first). Anything not listed lands after these.
var TAB_ORDER = ['orders', 'returns', 'promotions', 'refund_audit_log', 'order_ops',
  'auth_users', 'profiles', 'customer_profiles', 'reviews', 'waitlist', 'restock_requests', 'favorites',
  'products', 'color_variants', 'product_sizes', 'product_images', 'size_charts', 'inventory',
  'webhook_events', 'admin_audit_log', 'zw_banned_words', 'site_settings', 'return_requests'];
// Columns to float to the left of each table (snake_case + camelCase variants).
var PRIORITY_COLS = ['order_number', 'orderNumber', 'order_label', 'orderLabel', 'id', 'code',
  'created_at', 'createdAt', 'date', 'email', 'customer_email', 'customerEmail', 'user_email', 'userEmail',
  'customer_name', 'customerName', 'user_name', 'userName', 'full_name', 'name', 'status', 'resolution',
  'reason', 'rating', 'title', 'total', 'total_amount', 'order_total', 'orderTotal', 'value', 'amount_cents'];

function displayName_(t) { return DISPLAY[t] || t; }
function isCurrencyCol_(k) { return /^(total|subtotal|total_amount|order_total|ordertotal|grand_total|shipping|tax|price|value)$/i.test(String(k)); }
function colorFor_(t) {
  if (['orders', 'returns', 'promotions', 'refund_audit_log', 'order_ops', 'auth_users', 'profiles', 'customer_profiles', 'waitlist', 'restock_requests', 'favorites'].indexOf(t) >= 0) return '#1a7f37';
  if (['products', 'color_variants', 'product_images', 'product_sizes', 'size_charts', 'inventory', 'reviews'].indexOf(t) >= 0) return '#1f6feb';
  return '#6e7781';
}
function formatWhen_(iso) {
  try { return Utilities.formatDate(new Date(iso), Session.getScriptTimeZone(), "EEE, MMM d yyyy 'at' h:mm a"); }
  catch (_) { return iso || ''; }
}

function backupToSheet() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('BACKUP_URL');
  var token = props.getProperty('BACKUP_TOKEN');
  if (!url || !token) throw new Error('Set BACKUP_URL and BACKUP_TOKEN in Script Properties first.');

  var resp = UrlFetchApp.fetch(url, { method: 'get', headers: { 'x-backup-token': token }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Backup fetch failed: ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 300));
  }

  var payload = JSON.parse(resp.getContentText());
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tables = payload.tables || {};

  writeSummary_(ss, payload);
  Object.keys(tables).forEach(function (name) {
    if (Array.isArray(tables[name])) writeTab_(ss, name, tables[name]);
  });
  orderAndColorTabs_(ss);
  var sum = ss.getSheetByName(SUMMARY_NAME);
  if (sum) sum.activate();
}

function getOrRenameSheet_(ss, raw, disp, insertFirst) {
  var sheet = ss.getSheetByName(disp) || ss.getSheetByName(raw);
  if (!sheet) sheet = insertFirst ? ss.insertSheet(disp, 0) : ss.insertSheet(disp);
  if (sheet.getName() !== disp) sheet.setName(disp);
  sheet.getBandings().forEach(function (b) { b.remove(); });
  sheet.clear();
  return sheet;
}

function collectKeys_(rows) {
  var keys = [], seen = {};
  rows.forEach(function (r) { Object.keys(r).forEach(function (k) { if (!seen[k]) { seen[k] = true; keys.push(k); } }); });
  // priority columns first, in PRIORITY_COLS order, then the rest as-is
  var pri = [], rest = [];
  PRIORITY_COLS.forEach(function (p) { if (keys.indexOf(p) >= 0) pri.push(p); });
  keys.forEach(function (k) { if (pri.indexOf(k) === -1) rest.push(k); });
  return pri.concat(rest);
}

function writeTab_(ss, table, rows) {
  var sheet = getOrRenameSheet_(ss, table, displayName_(table), false);
  sheet.setTabColor(colorFor_(table));
  if (!rows.length) { sheet.getRange(1, 1).setValue('(no rows yet)').setFontColor('#999999'); return; }

  var keys = collectKeys_(rows);
  var values = [keys];
  rows.forEach(function (r) {
    values.push(keys.map(function (k) {
      var v = r[k];
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    }));
  });

  var nCols = keys.length, nRows = values.length;
  sheet.getRange(1, 1, nRows, nCols).setValues(values).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sheet.getRange(1, 1, 1, nCols).setBackground(HEADER_BG).setFontColor(HEADER_FG).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);
  if (nRows > 2) sheet.getRange(2, 1, nRows - 1, nCols).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
  keys.forEach(function (k, i) {
    if (isCurrencyCol_(k)) sheet.getRange(2, i + 1, nRows - 1, 1).setNumberFormat('$#,##0.00');
  });
  sheet.autoResizeColumns(1, nCols);
  for (var c = 1; c <= nCols; c++) {
    var w = sheet.getColumnWidth(c);
    if (w > 320) sheet.setColumnWidth(c, 320);
    else if (w < 70) sheet.setColumnWidth(c, 70);
  }
}

function writeSummary_(ss, payload) {
  var sheet = getOrRenameSheet_(ss, '_summary', SUMMARY_NAME, true);
  var counts = payload.counts || {};
  var rows = [
    ['Zuwera data backup', '', ''],
    ['Last updated', formatWhen_(payload.exported_at), ''],
    ['', '', ''],
    ['Tab', 'Rows', 'What it is']
  ];
  var seen = {};
  TAB_ORDER.forEach(function (t) { if (t in counts) { rows.push([displayName_(t), counts[t], DESCRIPTION[t] || '']); seen[t] = true; } });
  Object.keys(counts).forEach(function (t) { if (!seen[t]) rows.push([displayName_(t), counts[t], DESCRIPTION[t] || '']); });

  sheet.getRange(1, 1, rows.length, 3).setValues(rows).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sheet.getRange(1, 1).setFontSize(16).setFontWeight('bold');
  sheet.getRange(2, 1, 1, 2).setFontColor('#666666');
  sheet.getRange(4, 1, 1, 3).setBackground(HEADER_BG).setFontColor(HEADER_FG).setFontWeight('bold');
  sheet.setFrozenRows(4);
  var bodyRows = rows.length - 4;
  if (bodyRows > 0) sheet.getRange(5, 1, bodyRows, 3).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
  sheet.setColumnWidth(1, 200); sheet.setColumnWidth(2, 70); sheet.setColumnWidth(3, 540);
  sheet.setTabColor('#d4af37');
}

function orderAndColorTabs_(ss) {
  var order = [SUMMARY_NAME].concat(TAB_ORDER.map(displayName_));
  var pos = 0;
  order.forEach(function (disp) {
    var sh = ss.getSheetByName(disp);
    if (sh) { sh.activate(); ss.moveActiveSheet(++pos); }
  });
}

/** Run once: authorize, install the daily trigger, and pull an initial backup. */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'backupToSheet') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backupToSheet').timeBased().everyDays(1).atHour(4).create();
  backupToSheet();
}
