import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ALL as ALL_PERMISSIONS, OPERATOR as OPERATOR_PERMISSIONS } from '../auth/permissions.js';
import { env } from '../env.js';

// HEALTHCHECK_DATA_DIR in the settings file; by default server/data inside the project (in .gitignore).
const dataDir = env.dataDir;
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

-- Artemis readings (DLQ / ExpiryQueue / memory): from its own beat, after a start, or on demand.
CREATE TABLE IF NOT EXISTS artemis_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  software_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  tone TEXT NOT NULL,
  report TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artemis_checks_pair ON artemis_checks(server_id, software_id, id);

-- People who can sign in. Passwords are stored only as scrypt hashes (see auth/passwords.ts).
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  -- set by an admin reset / new account: the next sign-in must choose a new password
  must_change_password INTEGER NOT NULL DEFAULT 0,
  temp_password_expires_at TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  password_changed_at TEXT NOT NULL,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);

-- Signed-in browsers. Only a SHA-256 of the cookie's token is kept, so a copy of this table can't sign anyone in.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- One-time reset links from "npm run reset-password" (an admin who forgot their password). Only a SHA-256 of
-- the link's token is kept; each works once, for a short time.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  ip TEXT
);

-- Service history (see scan/history.ts, scan/journal.ts): every start / stop / restart / crash systemd logged,
-- read at each check, with who did it: a Healthcheck run (and whose), a person's sudo command, systemd, a reboot.
CREATE TABLE IF NOT EXISTS service_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  software_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  source TEXT NOT NULL,
  actor TEXT,
  job_id INTEGER,
  job_kind TEXT,
  boot_time INTEGER NOT NULL,
  mono INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE(server_id, software_id, kind, boot_time, mono)
);

CREATE INDEX IF NOT EXISTS idx_service_events_pair ON service_events(server_id, software_id, at);

-- Per server: how its history is read ('journal' or 'snapshot'), and for the journal, where the last read
-- stopped and what it had half seen (scan/journal.ts JState, as JSON).
CREATE TABLE IF NOT EXISTS history_state (
  server_id INTEGER PRIMARY KEY,
  mode TEXT NOT NULL,
  state TEXT,
  persistent INTEGER,
  updated_at TEXT NOT NULL
);

-- What systemd said about each service at the last read, to spot what changed since.
CREATE TABLE IF NOT EXISTS service_snapshots (
  server_id INTEGER NOT NULL,
  software_id INTEGER NOT NULL,
  unit TEXT NOT NULL,
  boot_id TEXT,
  boot_time INTEGER NOT NULL,
  active_enter INTEGER NOT NULL,
  inactive_enter INTEGER NOT NULL,
  n_restarts INTEGER NOT NULL,
  active TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (server_id, software_id)
);

-- Sign-ins, failures, password changes and resets, user changes: who / what / when.
CREATE TABLE IF NOT EXISTS auth_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  username TEXT,
  actor TEXT,
  ip TEXT,
  detail TEXT
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
// JSON array of reports the run shows the operator as a popup, without pausing (e.g. Artemis after a start)
ensureColumn('job_runs', 'notices', 'TEXT');
// who started the run (username), for the activity list
ensureColumn('job_runs', 'started_by', 'TEXT');
// the server's boot id at the last history read (a new one = the server restarted)
ensureColumn('service_snapshots', 'boot_id', 'TEXT');
// history read from the journal: where it came from ('journal' / 'snapshot'), the command and terminal of the
// person who ran it, root sessions open when the person isn't known (JSON), "probably" for a kill near a crash,
// and for "kept crashing" rows how many times and until when
ensureColumn('service_events', 'origin', 'TEXT');
ensureColumn('service_events', 'command', 'TEXT');
ensureColumn('service_events', 'terminal', 'TEXT');
ensureColumn('service_events', 'sessions', 'TEXT');
ensureColumn('service_events', 'probable', 'INTEGER');
ensureColumn('service_events', 'count', 'INTEGER');
ensureColumn('service_events', 'until_at', 'TEXT');
// an admin's authenticator app, for "Forgot password" (see auth/totp.ts): the secret, encrypted with master.key;
// one being set up but not yet confirmed with a code; the last code's time step (each code works once); when it
// was set up
ensureColumn('users', 'totp_secret_enc', 'TEXT');
ensureColumn('users', 'totp_pending_enc', 'TEXT');
ensureColumn('users', 'totp_last_step', 'INTEGER');
ensureColumn('users', 'totp_set_at', 'TEXT');
// what each person may do (JSON array of permission names, see auth/permissions.ts). Accounts from before
// permissions existed: admins get everything, everyone else the operator set they effectively had.
ensureColumn('users', 'permissions', 'TEXT');
sqlite
  .prepare('UPDATE users SET permissions = CASE WHEN is_admin = 1 THEN ? ELSE ? END WHERE permissions IS NULL')
  .run(JSON.stringify(ALL_PERMISSIONS), JSON.stringify(OPERATOR_PERMISSIONS));
// "Check status" used to be part of "Run checks": whoever had that keeps being able to check status. Once only,
// so an admin can take it away again afterwards.
if (!sqlite.prepare("SELECT 1 FROM app_meta WHERE key = 'perm_check_status_split'").get()) {
  sqlite.exec(`UPDATE users SET permissions = json_insert(permissions, '$[#]', 'check_status')
    WHERE json_valid(permissions)
      AND EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'run_checks')
      AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'check_status')`);
  sqlite.prepare("INSERT INTO app_meta (key, value) VALUES ('perm_check_status_split', ?)").run(new Date().toISOString());
}

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
