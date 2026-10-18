// End-to-end sign-in tests on an isolated copy: a throwaway database and the app without its schedulers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enroll } from './totp-helper.mts';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-auth-test-'));
process.env.HEALTHCHECK_DATA_DIR = dataDir;
const { sqlite } = await import('../server/src/db/client.ts');
const { createApp } = await import('../server/src/app.ts');
const server = createApp().listen(4198, '127.0.0.1');
const API = 'http://127.0.0.1:4198/api';
let fails = 0;
const check = (label: string, ok: boolean, info?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && info !== undefined ? `   got: ${JSON.stringify(info)}` : ''}`);
};

class Browser {
  cookie = '';
  lastSetCookie = '';
  async call(method: string, path: string, body?: unknown, opts: { csrf?: boolean } = {}) {
    const res = await fetch(API + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(opts.csrf === false ? {} : { 'X-Healthcheck': '1' }), ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) {
      this.lastSetCookie = set;
      const v = set.split(';')[0];
      this.cookie = v.endsWith('=') ? '' : v;
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json };
  }
}

const ADMIN = { username: 'hc-test-admin', display_name: 'Test Admin', password: 'correct horse battery staple' };
const before = (sqlite.prepare('SELECT COUNT(*) AS c FROM users').get() as any).c;
if (before > 0) {
  console.log('Users already exist - this test only runs on an empty user table.');
  process.exit(1);
}

try {
  const anon = new Browser();
  let r = await anon.call('GET', '/auth/status');
  check('fresh install: setup needed', r.json?.setup_needed === true, r.json);
  r = await anon.call('GET', '/servers');
  check('API without signing in -> 401', r.status === 401, r.status);
  r = await anon.call('POST', '/auth/setup', ADMIN, { csrf: false });
  check('change without the Healthcheck header -> 403 (CSRF guard)', r.status === 403, r.status);

  // ---- password policy on setup
  for (const [pw, why] of [
    ['short1', 'too short'],
    ['password1234', 'common'],
    ['Password-123', 'common with symbols'],
    ['hc-test-admin-2026', 'contains username'],
    ['aaaaaaaaaaaaaaa', 'repetitive'],
    ['abcdefghijklmn', 'sequence'],
    ['vodafone2026!!', 'local word'],
  ]) {
    r = await anon.call('POST', '/auth/setup', { ...ADMIN, password: pw });
    check(`policy refuses ${why} ("${pw}")`, r.status === 400 && r.json?.code === 'weak_password', r.json);
  }

  const admin = new Browser();
  r = await admin.call('POST', '/auth/setup', ADMIN);
  check('setup with a strong passphrase -> admin created and signed in', r.status === 201 && r.json?.user?.is_admin === true, r.json);
  check('cookie is HttpOnly + SameSite=Strict', /HttpOnly/.test(admin.lastSetCookie) && /SameSite=Strict/.test(admin.lastSetCookie), admin.lastSetCookie);
  const stored = (sqlite.prepare('SELECT password_hash FROM users WHERE username = ?').get(ADMIN.username) as any).password_hash as string;
  check('password stored only as a scrypt hash', stored.startsWith('scrypt$') && !stored.includes(ADMIN.password), stored.slice(0, 20));
  const tokenRow = sqlite.prepare('SELECT token_hash FROM sessions').get() as any;
  check('session table holds a hash, not the cookie token', tokenRow && !admin.cookie.includes(tokenRow.token_hash), null);
  r = await anon.call('POST', '/auth/setup', { ...ADMIN, username: 'second-admin' });
  check('second setup refused once a user exists', r.status === 409, r.status);
  await enroll(admin);
  r = await admin.call('GET', '/servers');
  check('signed in: API works', r.status === 200, r.status);

  // ---- create a user, temp password, forced change
  r = await admin.call('POST', '/users', { username: 'hc-test-op', display_name: 'Test Operator', is_admin: false });
  const temp1 = r.json?.temporary_password as string;
  check('admin creates a user and gets a one-time temporary password', r.status === 201 && /^[\w]{4}-[\w]{4}-[\w]{4}-[\w]{4}$/.test(temp1), r.json);
  r = await admin.call('POST', '/users', { username: 'HC-TEST-OP', display_name: 'dup' });
  check('usernames are unique regardless of case', r.status === 409, r.status);
  const op = new Browser();
  r = await op.call('POST', '/auth/login', { username: 'hc-test-op', password: temp1 });
  check('sign in with the temporary password', r.status === 200 && r.json?.user?.must_change_password === true, r.json);
  r = await op.call('GET', '/servers');
  check('until it is changed, the rest of the app is refused', r.status === 403 && r.json?.code === 'must_change_password', r.json);
  r = await op.call('POST', '/auth/change-password', { current_password: temp1, new_password: temp1 });
  check('the new password must differ from the temporary one', r.status === 400, r.json);
  r = await op.call('POST', '/auth/change-password', { current_password: 'wrong-wrong-wrong', new_password: 'blue lantern under oak' });
  check('change refused with a wrong current password', r.status === 400 && r.json?.code === 'bad_current', r.json);
  r = await op.call('POST', '/auth/change-password', { current_password: temp1, new_password: 'blue lantern under oak' });
  check('change to a strong password -> allowed', r.status === 200 && r.json?.user?.must_change_password === false, r.json);
  sqlite.prepare("UPDATE users SET failed_attempts = 0 WHERE username = 'hc-test-op'").run();
  r = await op.call('GET', '/servers');
  check('after the change the app works', r.status === 200, r.status);
  r = await op.call('GET', '/users');
  check('a non-admin cannot open the user list', r.status === 403, r.status);

  // ---- other sessions end on password change
  const op2 = new Browser();
  await op2.call('POST', '/auth/login', { username: 'hc-test-op', password: 'blue lantern under oak' });
  await op.call('POST', '/auth/change-password', { current_password: 'blue lantern under oak', new_password: 'green kettle over hill' });
  r = await op2.call('GET', '/servers');
  check('changing the password signs out the other browsers', r.status === 401, r.status);
  r = await op.call('GET', '/servers');
  check('...but keeps this one signed in', r.status === 200, r.status);

  // ---- lockout + no username enumeration
  const att = new Browser();
  const msgs: string[] = [];
  for (let i = 0; i < 5; i++) msgs.push((await att.call('POST', '/auth/login', { username: 'hc-test-op', password: `nope-${i}` })).json?.error);
  r = await att.call('POST', '/auth/login', { username: 'hc-test-op', password: 'green kettle over hill' });
  check('5 wrong passwords lock the account (even the right one is refused)', r.status === 429 && r.json?.code === 'locked', r.json);
  const ghost: string[] = [];
  for (let i = 0; i < 5; i++) ghost.push((await att.call('POST', '/auth/login', { username: 'hc-no-such-user', password: `nope-${i}` })).json?.error);
  r = await att.call('POST', '/auth/login', { username: 'hc-no-such-user', password: 'whatever' });
  check('unknown usernames get the same messages and lock the same way', msgs[0] === ghost[0] && r.json?.code === 'locked', { msgs: msgs[0], ghost: ghost[0], r: r.json });
  // timing: known username vs unknown, wrong password
  const time = async (u: string) => {
    const t = performance.now();
    await new Browser().call('POST', '/auth/login', { username: u, password: 'x-wrong' });
    return performance.now() - t;
  };
  sqlite.prepare("UPDATE users SET locked_until = NULL, failed_attempts = 0 WHERE username = ?").run(ADMIN.username);
  const tk = await time(ADMIN.username);
  const tu = await time('hc-another-ghost');
  check(`wrong password takes as long for unknown users (${Math.round(tk)} ms vs ${Math.round(tu)} ms)`, Math.abs(tk - tu) < Math.max(tk, tu) * 0.6, { tk, tu });
  sqlite.prepare("UPDATE users SET failed_attempts = 0 WHERE username = ?").run(ADMIN.username);
  const opId = (sqlite.prepare("SELECT id FROM users WHERE username = 'hc-test-op'").get() as any).id;
  r = await admin.call('PATCH', `/users/${opId}`, { unlock: true });
  check('admin unlocks it', r.status === 200 && r.json?.locked === false, r.json);
  r = await att.call('POST', '/auth/login', { username: 'hc-test-op', password: 'green kettle over hill' });
  check('...and the right password works again', r.status === 200, r.json);

  // ---- forgot password: admin reset
  r = await admin.call('POST', `/users/${opId}/reset-password`);
  const temp2 = r.json?.temporary_password;
  check('admin reset gives a new temporary password', r.status === 200 && typeof temp2 === 'string', r.json);
  r = await op.call('GET', '/servers');
  check('the reset signs the user out everywhere', r.status === 401, r.status);
  r = await op.call('POST', '/auth/login', { username: 'hc-test-op', password: 'green kettle over hill' });
  check('the old password no longer works', r.status === 401, r.status);
  sqlite.prepare("UPDATE users SET temp_password_expires_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), opId);
  r = await op.call('POST', '/auth/login', { username: 'hc-test-op', password: temp2 });
  check('an expired temporary password is refused', r.status === 401 && r.json?.code === 'temp_expired', r.json);
  sqlite.prepare("UPDATE users SET temp_password_expires_at = ? WHERE id = ?").run(new Date(Date.now() + 3600_000).toISOString(), opId);
  r = await op.call('POST', '/auth/login', { username: 'hc-test-op', password: temp2 });
  check('a valid temporary password signs in to the forced change', r.status === 200 && r.json?.user?.must_change_password, r.json);
  r = await admin.call('POST', `/users/${(sqlite.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN.username) as any).id}/reset-password`);
  check('an admin cannot reset their own password this way', r.status === 400, r.status);

  // ---- disable / last-admin guard
  r = await admin.call('PATCH', `/users/${opId}`, { disabled: true });
  check('admin disables the user', r.status === 200 && r.json?.disabled, r.json);
  r = await op.call('GET', '/auth/status');
  check('disabling ends their session', r.json?.user === null, r.json);
  r = await new Browser().call('POST', '/auth/login', { username: 'hc-test-op', password: temp2 });
  check('a disabled account cannot sign in', r.status === 403 && r.json?.code === 'disabled', r.json);
  const adminId = (sqlite.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN.username) as any).id;
  r = await admin.call('PATCH', `/users/${adminId}`, { permissions: ['start_all'] });
  check('an admin cannot remove their own admin rights', r.status === 400, r.json);
  r = await admin.call('PATCH', `/users/${adminId}`, { disabled: true });
  check('an admin cannot disable themselves', r.status === 400, r.json);

  // ---- idle timeout
  sqlite.prepare('UPDATE sessions SET last_seen_at = ? WHERE user_id = ?').run(new Date(Date.now() - 9 * 3600_000).toISOString(), adminId);
  r = await admin.call('GET', '/servers');
  check('a session idle for 9 h has ended', r.status === 401, r.status);

  // ---- logout
  const a2 = new Browser();
  await a2.call('POST', '/auth/login', { username: ADMIN.username, password: ADMIN.password });
  const cookieBefore = a2.cookie;
  r = await a2.call('POST', '/auth/logout');
  const replay = new Browser();
  replay.cookie = cookieBefore;
  r = await replay.call('GET', '/servers');
  check('after sign out the old cookie is useless', r.status === 401, r.status);
} finally {
  server.close();
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
