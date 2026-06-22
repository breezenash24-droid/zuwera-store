/**
 * Zuwera backup -> Google Sheet (one tab per table), refreshed daily.
 *
 * SETUP (5 min):
 *  1. Create a new Google Sheet. Extensions -> Apps Script.
 *  2. Delete the sample code, paste THIS file.
 *  3. Project Settings (gear) -> Script Properties -> add:
 *        BACKUP_URL   = https://qfgnrsifcwdubkolsgsq.supabase.co/functions/v1/backup-export
 *        BACKUP_TOKEN = <the shared token you set on the edge function>
 *  4. Select the `setup` function in the toolbar and click Run. Authorize when
 *     prompted. It pulls a backup now and installs a daily 4am trigger.
 *
 * Re-run `backupToSheet` any time for an on-demand refresh.
 */

function backupToSheet() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('BACKUP_URL');
  var token = props.getProperty('BACKUP_TOKEN');
  if (!url || !token) {
    throw new Error('Set BACKUP_URL and BACKUP_TOKEN in Script Properties first.');
  }

  var resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'x-backup-token': token },
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Backup fetch failed: ' + resp.getResponseCode() + ' ' +
      resp.getContentText().slice(0, 300));
  }

  var payload = JSON.parse(resp.getContentText());
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  writeSummary_(ss, payload);

  var tables = payload.tables || {};
  Object.keys(tables).forEach(function (name) {
    var rows = tables[name];
    if (!Array.isArray(rows)) return; // skip {error:...} entries
    writeTab_(ss, name, rows);
  });
}

function writeTab_(ss, name, rows) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clear();
  if (!rows.length) { sheet.getRange(1, 1).setValue('(no rows)'); return; }

  // Stable column order = union of all keys across rows.
  var keys = [];
  var seen = {};
  rows.forEach(function (r) {
    Object.keys(r).forEach(function (k) { if (!seen[k]) { seen[k] = true; keys.push(k); } });
  });

  var values = [keys];
  rows.forEach(function (r) {
    values.push(keys.map(function (k) {
      var v = r[k];
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') return JSON.stringify(v); // flatten jsonb/arrays
      return v;
    }));
  });

  sheet.getRange(1, 1, values.length, keys.length).setValues(values);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, keys.length).setFontWeight('bold');
}

function writeSummary_(ss, payload) {
  var sheet = ss.getSheetByName('_summary') || ss.insertSheet('_summary', 0);
  sheet.clear();
  var out = [['Zuwera backup', ''], ['Exported at (UTC)', payload.exported_at || ''], ['', ''], ['Table', 'Rows']];
  var counts = payload.counts || {};
  Object.keys(counts).forEach(function (k) { out.push([k, counts[k]]); });
  sheet.getRange(1, 1, out.length, 2).setValues(out);
  sheet.getRange(1, 1).setFontWeight('bold');
  sheet.getRange(4, 1, 1, 2).setFontWeight('bold');
}

/** Run once: authorize, install the daily trigger, and pull an initial backup. */
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'backupToSheet') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backupToSheet').timeBased().everyDays(1).atHour(4).create();
  backupToSheet();
}
