// "Check status" split out of "Run checks": the gate, and the one-time migration. Fully isolated.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-split-test-'));
let fails = 0;
const check = (label: string, ok: boolean, info?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && info !== undefined ? `   got: ${JSON.stringify(info)}` : ''}`);
};

// an installation from before the split: users table with the old permission lists, no migration flag yet
const pre = new DatabaseSync(path.join(dataDir, 'healthcheck.sqlite'));
pre.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, must_change_password INTEGER NOT NULL DEFAULT 0,
  temp_password_expires_at TEXT, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until TEXT, password_changed_at TEXT NOT NULL, last_login_at TEXT,
  created_at TEXT NOT NULL, permissions TEXT)`);
const ins = pre.prepare("INSERT INTO users (username, display_name, password_hash, is_admin, permissions, password_changed_at, created_at) VALUES (?, ?, 'x', ?, ?, 'now', 'now')");
ins.run('op', 'Op', 0, JSON.stringify(['start_all', 'run_checks', 'view_logs']));
ins.run('viewer', 'Viewer', 0, JSON.stringify([]));
ins.run('stopper', 'Stopper', 0, JSON.stringify(['stop_all']));
pre.close();

process.env.HEALTHCHECK_DATA_DIR = dataDir;
const { sqlite } = await import('../server/src/db/client.ts');
const { createApp } = await import('../server/src/app.ts');
const { hashPassword } = await import('../server/src/auth/passwords.ts');
const perms = (u: string) => JSON.parse((sqlite.prepare('SELECT permissions FROM users WHERE username = ?').get(u) as any).permissions) as string[];

try {
  check('who had Run checks now also has Check status', perms('op').includes('check_status') && perms('op').includes('run_checks'), perms('op'));
  check('nobody else got it', !perms('viewer').includes('check_status') && !perms('stopper').includes('check_status'), [perms('viewer'), perms('stopper')]);
  // an admin takes it away; the next start must not put it back
  sqlite.prepare("UPDATE users SET permissions = ? WHERE username = 'op'").run(JSON.stringify(['start_all', 'run_checks', 'view_logs']));
  const again = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(new URL('../server/dist/db/client.js', import.meta.url).href)}).then(() => process.exit(0))`], {
    env: { ...process.env, HEALTHCHECK_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  check('the app starts again fine', again.status === 0, again.stderr);
  check('...and does not give it back after an admin removed it (runs once)', !perms('op').includes('check_status'), perms('op'));

  // the gate
  const server = createApp().listen(4192, '127.0.0.1');
  const login = async (u: string, permissions: string[]) => {
    sqlite.prepare('UPDATE users SET password_hash = ?, permissions = ? WHERE username = ?').run(await hashPassword('long enough pass phrase'), JSON.stringify(permissions), u);
    const r = await fetch('http://127.0.0.1:4192/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Healthcheck': '1' }, body: JSON.stringify({ username: u, password: 'long enough pass phrase' }) });
    return r.headers.get('set-cookie')!.split(';')[0];
  };
  const post = (cookie: string, p: string) => fetch(`http://127.0.0.1:4192/api${p}`, { method: 'POST', headers: { 'X-Healthcheck': '1', Cookie: cookie } }).then((r) => r.status);
  const onlyOld = await login('op', ['run_checks']);
  check('Run checks alone: Check status refused', (await post(onlyOld, '/groups/99999/scan')) === 403);
  check('...Test connection allowed (passes the gate)', (await post(onlyOld, '/servers/99999/test-connection')) !== 403);
  const onlyNew = await login('stopper', ['check_status']);
  check('Check status alone: Check status allowed (passes the gate)', (await post(onlyNew, '/groups/99999/scan')) !== 403);
  check('...Test connection refused', (await post(onlyNew, '/servers/99999/test-connection')) === 403);
  check('...Artemis Check now refused', (await post(onlyNew, '/servers/99999/artemis-check')) === 403);
  const none = await login('viewer', []);
  check('a viewer can do neither', (await post(none, '/groups/99999/scan')) === 403 && (await post(none, '/servers/99999/test-connection')) === 403);
  server.close();
} finally {
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
