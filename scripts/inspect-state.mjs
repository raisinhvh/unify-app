import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const settingsPath = join(process.env.APPDATA, 'Code', 'User', 'settings.json');
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
console.log('settings dsh keys:', Object.keys(settings).filter((key) => key.startsWith('dsh')));
console.log(JSON.stringify(Object.fromEntries(Object.entries(settings).filter(([key]) => key.startsWith('dsh'))), null, 2).slice(0, 3000));

const root = join(process.env.APPDATA, 'Code', 'User', 'workspaceStorage');
for (const name of readdirSync(root)) {
  const folder = join(root, name, 'workspace.json');
  if (!existsSync(folder)) continue;
  let meta = '';
  try { meta = readFileSync(folder, 'utf8'); } catch { continue; }
  if (!/DSH|AI Stuff/i.test(meta)) continue;
  console.log('WORKSPACE', name, meta.slice(0, 300));
  const dbPath = join(root, name, 'state.vscdb');
  if (!existsSync(dbPath)) continue;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare("select key, length(value) as n from ItemTable").all();
  for (const row of rows) {
    if (!String(row.key).includes('dsh')) continue;
    const entry = db.prepare('select value from ItemTable where key = ?').get(row.key);
    const raw = Buffer.isBuffer(entry.value) ? entry.value.toString('utf8') : String(entry.value);
    console.log(' key', row.key, row.n, raw.slice(0, 300));
  }
}
