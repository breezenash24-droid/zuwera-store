/**
 * Zuwera backup -> Google Sheet, refreshed daily and formatted to FIND ANYTHING
 * EASILY:
 *   • Overview tab = clickable index (click a tab name to jump) + row counts +
 *     plain-language descriptions.
 *   • Every tab has filter buttons (the small ▾ on each column) so you can
 *     search, sort, or filter any column instantly.
 *   • Dates are real dates (sortable/filterable); rows are sorted newest-first.
 *   • Friendly tab names, styled frozen headers, banded rows, tidy widths,
 *     currency formatting, color-coded tabs. Re-running migrates old tabs in
 *     place (no duplicates).
 *
 * SETUP: Script Properties BACKUP_URL + BACKUP_TOKEN, then run `setup` once.
 */

var SUMMARY_NAME = 'Overview';
var HEADER_BG = '#09090b', HEADER_FG = '#ffffff';
var DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}|$)/;

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
var TAB_ORDER = ['orders', 'returns', 'promotions', 'refund_audit_log', 'order_ops',
  'auth_users', 'profiles', 'customer_profiles', 'reviews', 'waitlist', 'restock_requests', 'favorites',
  'products', 'color_variants', 'product_sizes', 'product_images', 'size_charts', 'inventory',
  'webhook_events', 'admin_audit_log', 'zw_banned_words', 'site_settings', 'return_requests'];
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

  // Data tabs first (so the Overview can link to them), then the index, then order.
  Object.keys(tables).forEach(function (name) {
    if (Array.isArray(tables[name])) writeTab_(ss, name, tables[name]);
  });
  writeSummary_(ss, payload);
  orderAndColorTabs_(ss);
  var sum = ss.getSheetByName(SUMMARY_NAME);
  if (sum) sum.activate();
}

function getOrRenameSheet_(ss, raw, disp, insertFirst) {
  var sheet = ss.getSheetByName(disp) || ss.getSheetByName(raw);
  if (!sheet) sheet = insertFirst ? ss.insertSheet(disp, 0) : ss.insertSheet(disp);
  if (sheet.getName() !== disp) sheet.setName(disp);
  var f = sheet.getFilter(); if (f) f.remove();
  sheet.getBandings().forEach(function (b) { b.remove(); });
  sheet.clear();
  return sheet;
}

function collectKeys_(rows) {
  var keys = [], seen = {};
  rows.forEach(function (r) { Object.keys(r).forEach(function (k) { if (!seen[k]) { seen[k] = true; keys.push(k); } }); });
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
  var colIsDate = [];
  var values = [keys];
  rows.forEach(function (r) {
    values.push(keys.map(function (k, ci) {
      var v = r[k];
      if (v === null || v === undefined) return '';
      if (typeof v === 'string' && DATE_RE.test(v)) {
        var d = new Date(v);
        if (!isNaN(d.getTime())) { colIsDate[ci] = true; return d; }
        return v;
      }
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    }));
  });

  var nCols = keys.length, nRows = values.length;
  sheet.getRange(1, 1, nRows, nCols).setValues(values).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sheet.getRange(1, 1, 1, nCols).setBackground(HEADER_BG).setFontColor(HEADER_FG).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);

  // Newest-first: sort by the first date column (or created_at) descending.
  var sortCol = 0;
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] === 'created_at' || keys[i] === 'createdAt' || colIsDate[i]) { sortCol = i + 1; break; }
  }
  if (sortCol > 0 && nRows > 2) sheet.getRange(2, 1, nRows - 1, nCols).sort({ column: sortCol, ascending: false });

  // Number formats: dates and currency.
  keys.forEach(function (k, i) {
    if (colIsDate[i]) sheet.getRange(2, i + 1, nRows - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm');
    else if (isCurrencyCol_(k)) sheet.getRange(2, i + 1, nRows - 1, 1).setNumberFormat('$#,##0.00');
  });

  if (nRows > 2) sheet.getRange(2, 1, nRows - 1, nCols).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);

  sheet.autoResizeColumns(1, nCols);
  for (var c = 1; c <= nCols; c++) {
    var w = sheet.getColumnWidth(c);
    if (w > 320) sheet.setColumnWidth(c, 320);
    else if (w < 70) sheet.setColumnWidth(c, 70);
  }

  // Filter buttons on the header so any column can be searched/sorted/filtered.
  sheet.getRange(1, 1, nRows, nCols).createFilter();
}

function writeSummary_(ss, payload) {
  var sheet = getOrRenameSheet_(ss, '_summary', SUMMARY_NAME, true);
  var counts = payload.counts || {};

  var rows = [
    ['Zuwera data backup', '', ''],
    ['Last updated', formatWhen_(payload.exported_at), ''],
    ['Tip', 'Click a tab name below to jump to it. On any tab, use the ▾ filter buttons to search, sort, or filter a column.', ''],
    ['', '', ''],
    ['Tab (click to open)', 'Rows', 'What it is']
  ];
  var seen = {};
  var addRow = function (t) {
    var sh = ss.getSheetByName(displayName_(t));
    var label = sh
      ? '=HYPERLINK("#gid=' + sh.getSheetId() + '","' + displayName_(t) + '")'
      : displayName_(t);
    rows.push([label, counts[t], DESCRIPTION[t] || '']);
  };
  TAB_ORDER.forEach(function (t) { if (t in counts) { addRow(t); seen[t] = true; } });
  Object.keys(counts).forEach(function (t) { if (!seen[t]) addRow(t); });

  sheet.getRange(1, 1, rows.length, 3).setValues(rows).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
  sheet.getRange(1, 1).setFontSize(16).setFontWeight('bold');
  sheet.getRange(2, 1, 2, 1).setFontWeight('bold');
  sheet.getRange(2, 2, 2, 1).setFontColor('#666666');
  sheet.getRange(5, 1, 1, 3).setBackground(HEADER_BG).setFontColor(HEADER_FG).setFontWeight('bold');
  sheet.setFrozenRows(5);
  var bodyRows = rows.length - 5;
  if (bodyRows > 0) sheet.getRange(6, 1, bodyRows, 3).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
  sheet.setColumnWidth(1, 210); sheet.setColumnWidth(2, 70); sheet.setColumnWidth(3, 560);
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
