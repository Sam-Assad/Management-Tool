import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Default: server/data inside the project, wherever the app is started from (the folder is in .gitignore).
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.HEALTHCHECK_DATA_DIR
  ? path.resolve(process.env.HEALTHCHECK_DATA_DIR)
  : path.resolve(here, '../../data');
fs.mkdirSync(dataDir, { recursive: true });

export const sqlite = new DatabaseSync(path.join(dataDir, 'healthcheck.sqlite'));
sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA foreign_keys = ON');

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  ssh_username TEXT NOT NULL,
  ssh_key_path TEXT NOT NULL,
  ssh_passphrase_enc TEXT,
  connection_status TEXT NOT NULL DEFAULT 'unknown',
  last_connected_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS software_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  detect_method TEXT NOT NULL,
  detect_value TEXT NOT NULL,
  start_cmd TEXT NOT NULL,
  stop_cmd TEXT NOT NULL,
  restart_method TEXT NOT NULL DEFAULT 'captured',
  start_script_path TEXT,
  stop_script_path TEXT,
  log_path TEXT,
  success_pattern TEXT,
  error_pattern TEXT,
  health_timeout_s INTEGER NOT NULL DEFAULT 120,
  default_rank INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_software (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  software_id INTEGER NOT NULL REFERENCES software_definitions(id) ON DELETE CASCADE,
  sequence_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(group_id, software_id)
);

CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS job_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_run_id INTEGER NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  server_id INTEGER NOT NULL,
  software_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  log_excerpt TEXT,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS heartbeat_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  software_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_heartbeat_pair ON heartbeat_log(server_id, software_id, id);

CREATE TABLE IF NOT EXISTS suggestion_dismissals (
  group_id INTEGER NOT NULL,
  software_id INTEGER NOT NULL,
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY (group_id, software_id)
);

-- Rules that shape start/stop order. 'type' leaves room for other kinds of condition later;
-- today the only type is 'start_before' (subject must be started before target; stop is reversed).
CREATE TABLE IF NOT EXISTS conditions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'start_before',
  subject_id INTEGER NOT NULL REFERENCES software_definitions(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES software_definitions(id) ON DELETE CASCADE,
  note TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(type, subject_id, target_id)
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

sqlite.exec(BOOTSTRAP_SQL);

// CREATE TABLE IF NOT EXISTS above doesn't retroactively add columns to a table
// that already existed from an earlier version of the app - patch those in here.
function ensureColumn(table: string, column: string, definition: string) {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('software_definitions', 'default_rank', 'INTEGER');
// JSON of the question a running job is waiting for the operator to answer (null when it isn't)
ensureColumn('job_runs', 'awaiting', 'TEXT');

export const dataDirPath = dataDir;

export function insertRow<T = any>(table: string, fields: Record<string, unknown>): T {
  const keys = Object.keys(fields);
  const columns = keys.join(', ');
  const placeholders = keys.map(() => '?').join(', ');
  const values = keys.map((k) => fields[k] as any);
  return sqlite.prepare(`INSERT INTO ${table} (${columns}) VALUES (${placeholders}) RETURNING *`).get(...values) as T;
}

export function updateRow<T = any>(table: string, id: number, fields: Record<string, unknown>): T | undefined {
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
  if (keys.length === 0) {
    return sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as T | undefined;
  }
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => fields[k] as any);
  return sqlite.prepare(`UPDATE ${table} SET ${setClause} WHERE id = ? RETURNING *`).get(...values, id) as
    | T
    | undefined;
}

export function deleteRow(table: string, id: number): void {
  sqlite.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
}
