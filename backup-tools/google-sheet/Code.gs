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

/* Sheets refuses any cell over 50,000 characters and fails the whole write.
   Order items and settings blobs are JSON and go past it, so the backup died
   on the biggest rows — the ones most worth having. Truncated with a marker,
   because a row that says it was cut is worth incomparably more than no backup
   at all. Well under the limit so a multi-byte character cannot creep over. */
var CELL_LIMIT = 49000;

function fitCell_(v) {
  var s = String(v);
  if (s.length <= CELL_LIMIT) return s;
  return s.slice(0, CELL_LIMIT - 60) + '… [TRUNCATED ' + s.length + ' chars — see the GitHub backup for the full value]';
}

/* ── REMOVING THE DECORATION IS ITSELF A THING THAT THROWS ──────────────────

   This is the third time the same lesson has been learnt on this file, and the
   first two fixes both guarded the wrong half.

   getBandings() can hand back a banding whose range no longer exists — a tab
   that was cleared, resized, or had its banding half-applied by an earlier run
   that failed between the remove and the apply. Calling .remove() on that
   handle throws "The alternating colors range you selected does not exist."

   bandRows_ was wrapped in a try/catch and survived it. getOrRenameSheet_ made
   the identical call unwrapped, so the SAME error eleven seconds later killed
   the whole nightly run — and kept killing it, every night, for six days. The
   log shows both: a warning at 2:20:22 and the fatal at 2:20:33.

   Worse, the two were connected. bandRows_'s catch swallowed the failed
   REMOVAL, which meant applyRowBanding never ran and the bad banding was still
   there for the next night. One tab in that state was enough to stop every
   backup that followed.

   So: removal is its own never-throwing function, each object removed
   independently — one bad handle must not stop the eleven good ones — and it
   is what both callers use. */
function stripBandings_(sheet) {
  var bandings;
  try { bandings = sheet.getBandings(); } catch (e) { return; }
  for (var i = 0; i < bandings.length; i++) {
    try { bandings[i].remove(); } catch (e) {
      console.warn('Could not remove a banding on ' + sheet.getName() + ': ' + e.message);
    }
  }
}

/* The filter, on the same terms. `getFilter().remove()` was also unguarded in
   getOrRenameSheet_ — the same shape of bug, sitting one line above the one
   that actually fired, waiting its turn. */
function stripFilter_(sheet) {
  try {
    var f = sheet.getFilter();
    if (f) f.remove();
  } catch (e) {
    console.warn('Could not remove the filter on ' + sheet.getName() + ': ' + e.message);
  }
}

/* Row banding is decoration, and decoration must never be able to fail a
   backup. It did: applyRowBanding throws if the range already has banding, and
   the removal a few lines earlier had not been flushed yet, so a cosmetic call
   took down the entire nightly run.

   Flush first so the removal has actually happened, then apply — and if it
   still objects, shrug and carry on with an unbanded sheet. The data is the
   point; the stripes are not. */
function bandRows_(sheet, range) {
  stripBandings_(sheet);
  try {
    SpreadsheetApp.flush();
    range.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
  } catch (e) {
    console.warn('Row banding skipped on ' + sheet.getName() + ': ' + e.message);
  }
}

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

  /* ── ONE BAD TAB MUST NOT COST YOU THE OTHER TWENTY ──────────────────────
     This loop had no guard, so the first table that threw ended the run: every
     tab after it stayed on last night's data, writeSummary_ never ran, and
     "Last updated" went on saying a date that was no longer true. That is how a
     cosmetic error on Customer Profiles turned into six days with no backup and
     nothing saying so.

     Now each table is written on its own, and a failure is recorded and
     carried to the summary rather than thrown. A backup missing one tab is
     enormously better than no backup — and it must be POSSIBLE TO SEE that it
     is missing one, which is what the failure list on the Overview is for. */
  var failed = [];
  Object.keys(tables).forEach(function (name) {
    if (!Array.isArray(tables[name])) return;
    try {
      writeTab_(ss, name, tables[name]);
    } catch (e) {
      failed.push({ table: name, error: String(e && e.message || e) });
      console.error('Backup tab failed: ' + name + ' — ' + (e && e.message));
    }
  });
  writeSummary_(ss, payload, failed);
  orderAndColorTabs_(ss);
  var sum = ss.getSheetByName(SUMMARY_NAME);
  if (sum) sum.activate();
}

function getOrRenameSheet_(ss, raw, disp, insertFirst) {
  var sheet = ss.getSheetByName(disp) || ss.getSheetByName(raw);
  if (!sheet) sheet = insertFirst ? ss.insertSheet(disp, 0) : ss.insertSheet(disp);
  if (sheet.getName() !== disp) sheet.setName(disp);
  stripFilter_(sheet);
  stripBandings_(sheet);
  sheet.clear();
  /* Flush before anyone tries to create a filter or banding on this sheet
     again. Apps Script queues these operations, so the removals above have not
     actually happened yet when writeTab_ reaches createFilter() — Sheets still
     believes a filter is there and throws "You can't create a filter in a sheet
     that already has a filter", which fails the whole nightly backup.

     Exactly the bug bandRows_ was fixed for, in the other decoration on the
     same sheet. Fixing one and not the other left the run just as dead, one
     line further down. */
  SpreadsheetApp.flush();
  return sheet;
}

/* Filter buttons, on the same terms as the stripes: worth having, never worth
   losing a backup over. Sheets can still refuse — a leftover filter on a
   protected range, a sheet someone has open — and a backup that dies over
   dropdown arrows is a backup nobody has. */
function addFilter_(sheet, range) {
  try {
    var existing = sheet.getFilter();
    if (existing) { existing.remove(); SpreadsheetApp.flush(); }
    range.createFilter();
  } catch (e) {
    console.warn('Filter buttons skipped on ' + sheet.getName() + ': ' + e.message);
  }
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
      if (typeof v === 'object') return fitCell_(JSON.stringify(v));
      /* Long plain strings hit the same wall — a note field, a pasted
         description — so they go through the same guard. */
      if (typeof v === 'string') return fitCell_(v);
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

  if (nRows > 2) bandRows_(sheet, sheet.getRange(2, 1, nRows - 1, nCols));

  sheet.autoResizeColumns(1, nCols);
  for (var c = 1; c <= nCols; c++) {
    var w = sheet.getColumnWidth(c);
    if (w > 320) sheet.setColumnWidth(c, 320);
    else if (w < 70) sheet.setColumnWidth(c, 70);
  }

  // Filter buttons on the header so any column can be searched/sorted/filtered.
  addFilter_(sheet, sheet.getRange(1, 1, nRows, nCols));
}

function writeSummary_(ss, payload, failed) {
  var sheet = getOrRenameSheet_(ss, '_summary', SUMMARY_NAME, true);
  var counts = payload.counts || {};
  var bad = failed || [];

  /* A partial backup that LOOKS complete is the dangerous one — you find out
     which tab was stale on the day you need it. So the state of the run is the
     second line of the sheet, above everything else, and it names the tabs that
     did not make it. When every tab wrote, it says so in one word. */
  var health = bad.length
    ? bad.length + ' tab' + (bad.length === 1 ? '' : 's') + ' FAILED — '
      + bad.map(function (f) { return displayName_(f.table) + ' (' + f.error + ')'; }).join('; ')
      + '. Everything else on this sheet is current.'
    : 'All tabs written.';

  var rows = [
    ['Zuwera data backup', '', ''],
    ['Last updated', formatWhen_(payload.exported_at), ''],
    ['This run', health, ''],
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
  /* Three label rows now, not two — "This run" sits between the date and the
     tip. These offsets are positional and every one of them has to move
     together when a row is added; getting one wrong paints the header stripe
     across the data. */
  sheet.getRange(2, 1, 3, 1).setFontWeight('bold');
  sheet.getRange(2, 2, 3, 1).setFontColor('#666666');
  /* Red and bold when a tab failed. A backup that quietly went partial is the
     one that costs you — this is the line that has to catch an eye that was
     only checking the date. */
  if (bad.length) sheet.getRange(3, 2).setFontColor('#c5221f').setFontWeight('bold');
  sheet.getRange(6, 1, 1, 3).setBackground(HEADER_BG).setFontColor(HEADER_FG).setFontWeight('bold');
  sheet.setFrozenRows(6);
  var bodyRows = rows.length - 6;
  if (bodyRows > 0) bandRows_(sheet, sheet.getRange(7, 1, bodyRows, 3));
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
