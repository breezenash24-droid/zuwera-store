// Pull the backup snapshot from the edge function and write per-table JSON + CSV
// into backups/<date>/ (dated history) and backups/latest/ (newest copy).
// Run by .github/workflows/backup.yml. No dependencies — Node 20+ built-ins only.
import { writeFileSync, mkdirSync } from "node:fs";

const url = process.env.BACKUP_URL;
const token = process.env.BACKUP_TOKEN;
if (!url || !token) {
  console.error("Missing BACKUP_URL / BACKUP_TOKEN env.");
  process.exit(1);
}

const resp = await fetch(url, { headers: { "x-backup-token": token } });
if (!resp.ok) {
  console.error("Fetch failed:", resp.status, (await resp.text()).slice(0, 300));
  process.exit(1);
}
const payload = await resp.json();

const date = new Date().toISOString().slice(0, 10);
const dirs = [`backups/${date}`, "backups/latest"];
dirs.forEach((d) => mkdirSync(d, { recursive: true }));

function toCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const keys = [...rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s; }, new Set())];
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [keys.join(","), ...rows.map((r) => keys.map((k) => cell(r[k])).join(","))].join("\n");
}

const tables = payload.tables || {};
for (const [name, rows] of Object.entries(tables)) {
  for (const dir of dirs) {
    writeFileSync(`${dir}/${name}.json`, JSON.stringify(rows, null, 2));
    if (Array.isArray(rows)) writeFileSync(`${dir}/${name}.csv`, toCsv(rows));
  }
}
for (const dir of dirs) {
  writeFileSync(`${dir}/_manifest.json`, JSON.stringify({ exported_at: payload.exported_at, counts: payload.counts }, null, 2));
}
console.log("Backup written for", date, payload.counts);
