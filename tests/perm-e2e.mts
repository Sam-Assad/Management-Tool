// Permissions, end to end against the running app. Uses only hc-test-* accounts (removed at the
// end) and never really starts/stops anything: "allowed" actions target a server group that doesn't exist (99999),
// so passing the permission gate shows as any answer other than 403.
import { sqlite } from '../server/src/db/client.ts';
import { hashPassword } from '../server/src/auth/passwords.ts';
import { ALL } from '../server/src/auth/permissions.ts';
import { encryptSecret } from '../server/src/crypto/secretBox.ts';
import { env } from '../server/src/env.ts';

// the running Healthcheck, on the port its settings file says
const API = `http://127.0.0.1:${env.port}/api`;
let fails = 0;
const check = (label: string, ok: boolean, info?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && info !== undefined ? `   got: ${JSON.stringify(info)}` : ''}`);
};
class Browser {
  cookie = '';
  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(API + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Healthcheck': '1', ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) {
      const v = set.split(';')[0];
      this.cookie = v.endsWith('=') ? '' : v;
    }
    let json: any = null;
    try {
      json = JSON.parse(await res.text());
    } catch {}
    return { status: res.status, json };
  }
}
const real = sqlite.prepare("SELECT id, username, permissions, password_hash FROM users WHERE username NOT LIKE 'hc-test-%'").all() as any[];

try {
  // a test admin, made directly (the real admins' passwords are theirs)
  const now = new Date().toISOString();
  sqlite
    .prepare('INSERT INTO users (username, display_name, password_hash, is_admin, permissions, password_changed_at, created_at, totp_secret_enc) VALUES (?, ?, ?, 1, ?, ?, ?, ?)')
    .run('hc-test-admin', 'Test Admin', await hashPassword('correct horse battery staple'), JSON.stringify(ALL), now, now, encryptSecret('JBSWY3DPEHPK3PXP'));
  const admin = new Browser();
  let r = await admin.call('POST', '/auth/login', { username: 'hc-test-admin', password: 'correct horse battery staple' });
  check('test admin signs in, with every permission', r.status === 200 && r.json?.user?.permissions?.length === ALL.length, r.json);

  // ---- accounts with different permissions
  const make = async (username: string, permissions: string[]) => {
    const c = await admin.call('POST', '/users', { username, display_name: username, permissions });
    const b = new Browser();
    await b.call('POST', '/auth/login', { username, password: c.json.temporary_password });
    await b.call('POST', '/auth/change-password', { current_password: c.json.temporary_password, new_password: 'river stone lamp under moon' });
    if (!(await b.call('GET', '/auth/status')).json?.user || (await b.call('GET', '/servers')).status === 403 && false) throw new Error('setup failed');
    return { b, user: c.json.user };
  };
  const viewer = await make('hc-test-viewer', []);
  check('viewer created with no permissions (view only)', viewer.user.permissions.length === 0 && viewer.user.is_admin === false, viewer.user);
  const op = await make('hc-test-op', ['start_one', 'restart_one', 'stop_one', 'start_all', 'restart_all', 'stop_all', 'run_checks', 'view_logs']);
  const stopper = await make('hc-test-stopper', ['stop_all']);
  r = await admin.call('POST', '/users', { username: 'hc-test-junk', display_name: 'junk', permissions: ['start_all', 'be_god'] });
  check('unknown permission names are dropped', r.json?.user?.permissions?.join() === 'start_all', r.json);

  const not403 = (s: number) => s !== 403 && s !== 401;
  // ---- viewer: sees everything, changes nothing
  check('viewer can view servers', (await viewer.b.call('GET', '/servers')).status === 200);
  check('viewer can view runs and alerts', (await viewer.b.call('GET', '/jobs?limit=3')).status === 200 && (await viewer.b.call('GET', '/alerts')).status === 200);
  for (const [m, p, what] of [
    ['POST', '/groups/99999/start-all', 'Start All'],
    ['POST', '/groups/99999/restart-all', 'Restart All'],
    ['POST', '/groups/99999/stop-all', 'Stop All'],
    ['POST', '/servers/99999/software/1/start', 'start a service'],
    ['POST', '/servers/99999/software/1/stop', 'stop a service'],
    ['POST', '/groups/1/scan', 'Check now'],
    ['POST', '/servers/1/artemis-check', 'Artemis Check now'],
    ['GET', '/servers/1/software/4/logs', 'read logs'],
    ['POST', '/servers', 'add a server'],
    ['DELETE', '/servers/99999', 'remove a server'],
    ['PATCH', '/software-definitions/99999', 'edit the catalog'],
    ['PATCH', '/conditions/99999', 'edit conditions'],
    ['GET', '/users', 'open Users'],
  ] as const) {
    r = await viewer.b.call(m, p, m === 'GET' ? undefined : {});
    check(`viewer refused: ${what}`, r.status === 403, r);
  }
  r = await viewer.b.call('POST', '/groups/99999/stop-all');
  check('refusal says what is missing, in words', /permission to run Stop All/.test(r.json?.error ?? ''), r.json);
  const startAllJob = (sqlite.prepare("SELECT id FROM job_runs WHERE kind = 'start_all' ORDER BY id DESC LIMIT 1").get() as any)?.id;
  r = await viewer.b.call('POST', `/jobs/${startAllJob}/decision`, { choice: 'halt' });
  check("viewer can't answer a Start All run's question", r.status === 403, r);

  // ---- operator: runs things, can't configure
  check('operator passes the gate for Start All', not403((await op.b.call('POST', '/groups/99999/start-all')).status));
  check('operator passes the gate for Stop All', not403((await op.b.call('POST', '/groups/99999/stop-all')).status));
  check('operator passes the gate for a single stop', not403((await op.b.call('POST', '/servers/99999/software/1/stop')).status));
  check('operator may read logs', not403((await op.b.call('GET', '/servers/99999/software/99999/logs')).status));
  r = await op.b.call('POST', `/jobs/${startAllJob}/decision`, { choice: 'halt' });
  check("operator may answer a Start All run's question (this old one isn't asking: 409)", r.status === 409, r);
  check('operator refused: add a server', (await op.b.call('POST', '/servers', {})).status === 403);
  check('operator refused: edit the catalog', (await op.b.call('DELETE', '/software-definitions/99999')).status === 403);
  check('operator refused: Users', (await op.b.call('GET', '/users')).status === 403);

  // ---- custom: Stop All only
  check('stop-only passes for Stop All', not403((await stopper.b.call('POST', '/groups/99999/stop-all')).status));
  check('stop-only refused for Start All', (await stopper.b.call('POST', '/groups/99999/start-all')).status === 403);
  check('stop-only refused for a single stop', (await stopper.b.call('POST', '/servers/99999/software/1/stop')).status === 403);

  // ---- changes take effect at once (no sign-in needed)
  r = await admin.call('PATCH', `/users/${op.user.id}`, { permissions: ['stop_one'] });
  check('admin narrows the operator to "stop a service"', r.status === 200 && r.json?.permissions?.join() === 'stop_one', r.json);
  check('...Start All is refused on their very next request', (await op.b.call('POST', '/groups/99999/start-all')).status === 403);
  r = await op.b.call('GET', '/auth/status');
  check('...and their page sees the new permissions', r.json?.user?.permissions?.join() === 'stop_one', r.json);

  // ---- guards
  const adminId = (sqlite.prepare("SELECT id FROM users WHERE username = 'hc-test-admin'").get() as any).id;
  r = await admin.call('PATCH', `/users/${adminId}`, { permissions: ['start_all'] });
  check("an admin can't remove their own Manage users", r.status === 400, r.json);
  check('a change matching no rule is refused (deny by default)', (await admin.call('POST', '/something-new', {})).status === 403);
  check('setup is closed once accounts exist', (await new Browser().call('POST', '/auth/setup', { username: 'someone-new', display_name: 'Someone', password: 'long enough passphrase here' })).status === 409);

  // ---- recovery codes and email are gone
  for (const p of ['/auth/recovery-codes', '/auth/email']) {
    r = await admin.call('POST', p, { password: 'correct horse battery staple', email: 'x@example.test' });
    check(`signed in: ${p} no longer exists (refused)`, r.status === 403 || r.status === 404, r);
  }
  for (const p of ['/auth/recover', '/auth/forgot']) {
    r = await new Browser().call('POST', p, { username: 'hc-test-admin', identifier: 'hc-test-admin', code: 'aaaa-bbbb-cc', new_password: 'purple tractor in the rain' });
    check(`signed out: ${p} no longer exists (refused)`, r.status === 401 || r.status === 404, r);
  }
  r = await admin.call('GET', '/auth/status');
  check('status no longer mentions email', r.json && !('email_enabled' in r.json) && !('email' in (r.json.user ?? {})), r.json);

  // the real accounts weren't touched
  const after = sqlite.prepare("SELECT id, username, permissions, password_hash FROM users WHERE username NOT LIKE 'hc-test-%'").all() as any[];
  check('your own account (sam1) is unchanged', JSON.stringify(after) === JSON.stringify(real));
} finally {
  sqlite.prepare("DELETE FROM users WHERE username LIKE 'hc-test-%'").run();
  sqlite.prepare("DELETE FROM auth_events WHERE username LIKE 'hc-%' OR actor LIKE 'hc-test-%'").run();
  sqlite.prepare("DELETE FROM job_steps WHERE job_run_id IN (SELECT id FROM job_runs WHERE group_id = 99999)").run();
  sqlite.prepare('DELETE FROM job_runs WHERE group_id = 99999').run();
  sqlite.prepare("UPDATE job_runs SET started_by = NULL WHERE started_by LIKE 'hc-test-%'").run();
  console.log('\ncleanup: users now', (sqlite.prepare('SELECT group_concat(username) AS u FROM users').get() as any).u);
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
