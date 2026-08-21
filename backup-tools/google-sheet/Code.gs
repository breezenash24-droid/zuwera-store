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
  customers: 'Customers', admins: 'Admin Access',
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
  customers: 'One row per person — login, sign-in history, name, saved preferences',
  admins: 'Who can get into the admin panel, and what they are allowed to do',
  customer_profiles: 'Per-customer admin notes / overlays', reviews: 'Product reviews',
  waitlist: 'Email sign-ups', restock_requests: 'Back-in-stock requests', favorites: 'Saved items',
  products: 'Product catalog', color_variants: 'Product colorways', product_images: 'Product photos',
  product_sizes: 'Sizes and stock counts', size_charts: 'Size chart data', inventory: 'Stock levels',
  webhook_events: 'Stripe payment events (reconciliation)', admin_audit_log: 'Admin action history',
  zw_banned_words: 'Review moderation word list', site_settings: 'Store settings & page content',
  return_requests: 'Empty legacy table — real returns are the Returns tab'
};
var TAB_ORDER = ['orders', 'returns', 'promotions', 'refund_audit_log', 'order_ops',
  'customers', 'customer_profiles', 'reviews', 'waitlist', 'restock_requests', 'favorites',
  'products', 'color_variants', 'product_sizes', 'product_images', 'size_charts', 'inventory',
  'webhook_events', 'admins', 'admin_audit_log', 'zw_banned_words', 'site_settings', 'return_requests'];
var PRIORITY_COLS = ['order_number', 'orderNumber', 'order_label', 'orderLabel', 'id', 'code',
  'created_at', 'createdAt', 'date', 'email', 'customer_email', 'customerEmail', 'user_email', 'userEmail',
  'customer_name', 'customerName', 'user_name', 'userName', 'full_name', 'name', 'status', 'resolution',
  'reason', 'rating', 'title', 'total', 'total_amount', 'order_total', 'orderTotal', 'value', 'amount_cents'];

function displayName_(t) { return DISPLAY[t] || t; }
function isCurrencyCol_(k) { return /^(total|subtotal|total_amount|order_total|ordertotal|grand_total|shipping|tax|price|value)$/i.test(String(k)); }
function colorFor_(t) {
  if (['orders', 'returns', 'promotions', 'refund_audit_log', 'order_ops', 'customers', 'customer_profiles', 'waitlist', 'restock_requests', 'favorites'].indexOf(t) >= 0) return '#1a7f37';
  if (['products', 'color_variants', 'product_images', 'product_sizes', 'size_charts', 'inventory', 'reviews'].indexOf(t) >= 0) return '#1f6feb';
  return '#6e7781';
}
function formatWhen_(iso) {
  try { return Utilities.formatDate(new Date(iso), Session.getScriptTimeZone(), "EEE, MMM d yyyy 'at' h:mm a"); }
  catch (_) { return iso || ''; }
}

/* ── TWO TABS FOR SIX PEOPLE ────────────────────────────────────────────────

   "Customers (logins)" was auth.users and "Customer Profiles" was
   public.profiles: the same six people, keyed by the same id, split across two
   tabs because that is how they are stored rather than because it is how anyone
   reads them. One had the email and the last sign-in, the other had the name
   and the preferences, and answering "who is this person" meant opening both
   and matching UUIDs by eye.

   So they are joined here, in the SHEET rather than in the export. The Sheet is
   the human view; the JSON in the git repo is the restore artifact, and a
   restore wants the tables the way the database has them. Merging on this side
   gives one readable tab without making the backup harder to put back.

   A FULL OUTER JOIN, not a lookup. A profile with no login (deleted account,
   half-finished signup) and a login with no profile (the row that never got
   written) are both real states and both worth seeing — an inner join would
   drop exactly the rows something has gone wrong with. `sources` says which
   side each row came from.

   AND THE ADMINS COME OUT AS THEIR OWN TAB. `admin_role` and
   `admin_permissions` were columns on a customer list, which meant "who can get
   into the panel" was a question you answered by scanning sideways. It is a
   short list, it changes rarely, and it is the first thing to check after
   anything alarming — so it gets a tab. Admins stay in Customers too: an admin
   is also an account. */
/* A tab this script no longer writes is worse than a tab that was never here:
   it sits there holding the data it had on the day the script changed, looking
   exactly as current as everything beside it. Nothing in the Sheet says how old
   a tab is. So a retired tab is deleted, once, by the run that retires it.

   Named by DISPLAY label because that is what is actually on the tab. */
var RETIRED_TABS = ['Customers (logins)', 'Customer Profiles'];

function dropRetiredTabs_(ss) {
  RETIRED_TABS.forEach(function (name) {
    try {
      var sh = ss.getSheetByName(name);
      /* Google refuses to delete the last remaining sheet, and a spreadsheet
         that far gone has bigger problems than a stale tab. */
      if (sh && ss.getSheets().length > 1) ss.deleteSheet(sh);
    } catch (e) {
      console.warn('Could not remove the retired tab "' + name + '": ' + e.message);
    }
  });
}

function mergeCustomers_(tables, counts) {
  var logins = Array.isArray(tables.auth_users) ? tables.auth_users : [];
  var profiles = Array.isArray(tables.profiles) ? tables.profiles : [];
  if (!logins.length && !profiles.length) return;

  var byId = {};
  var order = [];
  var slot = function (id) {
    var k = String(id || '');
    if (!k) return null;
    if (!byId[k]) { byId[k] = { id: k, login: null, profile: null }; order.push(k); }
    return byId[k];
  };
  logins.forEach(function (u) { var e = slot(u && u.id); if (e) e.login = u; });
  profiles.forEach(function (p) { var e = slot(p && p.id); if (e) e.profile = p; });

  var customers = [];
  var admins = [];
  order.forEach(function (k) {
    var e = byId[k];
    var u = e.login || {};
    var p = e.profile || {};
    var row = {
      id: e.id,
      email: u.email || p.email || '',
      name: p.full_name || '',
      /* Only when the two disagree. A profile email that has drifted from the
         login email is worth seeing; repeating the same address in two columns
         on every row is not. */
      profile_email: (p.email && u.email && String(p.email).toLowerCase() !== String(u.email).toLowerCase()) ? p.email : '',
      phone: u.phone || '',
      role: p.role || '',
      admin_role: p.admin_role || '',
      last_sign_in_at: u.last_sign_in_at || '',
      email_confirmed_at: u.email_confirmed_at || '',
      /* Both sides have a created_at and they mean different things — when the
         account was made, and when the profile row was written. Collapsing them
         into one column would quietly pick a winner. */
      signed_up_at: u.created_at || '',
      profile_created_at: p.created_at || '',
      provider: u.provider || '',
      providers: u.providers || '',
      preferences: p.preferences || '',
      sources: (e.login && e.profile) ? 'login + profile' : (e.login ? 'login only' : 'profile only'),
    };
    customers.push(row);
    if (p.admin_role || p.admin_permissions) {
      admins.push({
        id: e.id,
        email: row.email,
        name: row.name,
        admin_role: p.admin_role || '',
        admin_permissions: p.admin_permissions || '',
        last_sign_in_at: row.last_sign_in_at,
        sources: row.sources,
      });
    }
  });

  tables.customers = customers;
  counts.customers = customers.length;
  tables.admins = admins;
  counts.admins = admins.length;
  delete tables.auth_users; delete counts.auth_users;
  delete tables.profiles;   delete counts.profiles;
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
  /* Before the write loop, so the two source tabs are never created and then
     left behind as stale leftovers from an older version of this script. */
  mergeCustomers_(tables, payload.counts || (payload.counts = {}));
  dropRetiredTabs_(ss);

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
  var notes = [];
  if (bad.length) {
    notes.push(bad.length + ' tab' + (bad.length === 1 ? '' : 's') + ' FAILED — '
      + bad.map(function (f) { return displayName_(f.table) + ' (' + f.error + ')'; }).join('; ')
      + '. Everything else on this sheet is current.');
  }

  /* What the export decided on the server, repeated here because this is where
     somebody looks. A table the exporter held back for looking like it holds
     credentials, or one so large it had to stop — neither is visible from a row
     count, and both change what this backup is worth. */
  var d = payload.discovery || {};
  if (d.added && d.added.length) {
    notes.push('New table' + (d.added.length === 1 ? '' : 's') + ' picked up automatically: ' + d.added.join(', ') + '.');
  }
  if (d.held && d.held.length) {
    notes.push('NOT backed up: ' + d.held.map(function (x) { return x.table + ' (' + x.why + ')'; }).join('; ')
      + '. Deliberate — change it in backup-export if that is wrong.');
  }
  if (d.truncated && d.truncated.length) {
    notes.push('TRUNCATED — too many rows to export in one run: ' + d.truncated.join(', ') + '.');
  }
  var health = notes.length ? notes.join(' ') : 'All tabs written.';

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
  /* Red for the states that cost you something — a failed tab or a truncated
     one. Picking up a new table is news, not a problem, and colouring it like a
     fault is how a warning colour stops meaning anything. */
  var alarming = bad.length || (d.truncated && d.truncated.length);
  if (alarming) sheet.getRange(3, 2).setFontColor('#c5221f').setFontWeight('bold');
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
