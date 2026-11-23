import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const db = new DatabaseSync(join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'state.vscdb'), { readOnly: true });
const entry = db.prepare('select value from ItemTable where key = ?').get('dsh-local.dsh-ide');
const raw = Buffer.isBuffer(entry.value) ? entry.value.toString('utf8') : String(entry.value);
console.log(JSON.stringify(JSON.parse(raw), null, 2));
