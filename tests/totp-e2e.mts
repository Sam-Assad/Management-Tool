// Admin password reset with an authenticator app, end to end, fully isolated (throwaway database, no schedulers).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { phoneCode, enroll, b32decode } from './totp-helper.mts';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-totp-test-'));
process.env.HEALTHCHECK_DATA_DIR = dataDir;
const { createApp } = await import('../server/src/app.ts');
const { sqlite } = await import('../server/src/db/client.ts');
const totp = await import('../server/src/auth/totp.ts');
const server = createApp().listen(4196, '127.0.0.1');
const API = 'http://127.0.0.1:4196/api';

let fails = 0;
const check = (label: string, ok: boolean, info?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && info !== undefined ? `   got: ${JSON.stringify(info)}` : ''}`);
};
class Browser {
  cookie = '';
  async call(method: string, p: string, body?: unknown) {
    const res = await fetch(API + p, {
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
const row = (u: string) => sqlite.prepare('SELECT * FROM users WHERE username = ?').get(u) as any;
const resetFailures = () => sqlite.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL').run();
const recover = (username: string, code: string, new_password: string, b = new Browser()) =>
  b.call('POST', '/auth/recover-with-authenticator', { username, code, new_password }).then((r) => ({ ...r, b }));
const STEP = 30_000;

try {
  // ---- the code itself, against the RFC 6238 test vectors (SHA-1 key "12345678901234567890")
  const rfc = totp.base32Encode(Buffer.from('12345678901234567890'));
  const vectors: [number, string][] = [[59, '287082'], [1111111109, '081804'], [1234567890, '005924'], [2000000000, '279037']];
  check('RFC 6238 test vectors', vectors.every(([t, c]) => totp.codeAt(rfc, Math.floor(t / 30)) === c), vectors.map(([t]) => totp.codeAt(rfc, Math.floor(t / 30))));
  check('base32 round trip', b32decode(totp.newSecret()).length === 20);

  // ---- an admin must set it up before anything else
  const boss = new Browser();
  let r = await boss.call('POST', '/auth/setup', { username: 'boss', display_name: 'Big Boss', password: 'orange kayak at dawn' });
  check('new admin: needs_authenticator', r.json?.user?.needs_authenticator === true && r.json.user.has_authenticator === false, r.json);
  r = await boss.call('GET', '/servers');
  check('...and the app is refused until it is set up', r.status === 403 && r.json?.code === 'authenticator_required', r);
  check('...but the sign-in status still answers', (await boss.call('GET', '/auth/status')).json?.user?.username === 'boss');

  const s = await boss.call('POST', '/auth/authenticator/start');
  check('start: a QR code (SVG) and a 32-character key', /<svg/.test(s.json?.qr_svg) && /^[A-Z2-7]{32}$/.test(s.json?.secret) && s.json.replacing === false, s.json && { ...s.json, qr_svg: '…' });
  check('...and the server time, to compare with the phone', Math.abs(new Date(s.json.server_time).getTime() - Date.now()) < 5000);
  const secret1 = s.json.secret;
  r = await boss.call('POST', '/auth/authenticator/confirm', { code: '000000' === phoneCode(secret1) ? '111111' : '000000' });
  check('a wrong code doesn\'t confirm it', r.status === 400 && r.json?.code === 'bad_code', r.json);
  r = await boss.call('POST', '/auth/authenticator/confirm', { code: phoneCode(secret1, Date.now() - 5 * 60_000) });
  check('a code from a phone 5 minutes off: says the clocks differ', r.status === 400 && r.json?.code === 'clock_off' && /about 5 minutes apart/.test(r.json.error), r.json);
  r = await boss.call('POST', '/auth/authenticator/confirm', { code: phoneCode(secret1).replace(/(\d{3})/, '$1 ') });
  check('the right code (typed with a space) confirms it', r.status === 200 && r.json?.user?.has_authenticator === true && r.json.user.needs_authenticator === false, r.json);
  check('now the app works', (await boss.call('GET', '/servers')).status === 200);
  const stored = row('boss');
  check('the secret is stored encrypted, not as typed', stored.totp_secret_enc && !stored.totp_secret_enc.includes(secret1) && !stored.totp_pending_enc);

  // ---- a non-admin never gets one
  r = await boss.call('POST', '/users', { username: 'oper', display_name: 'Oper', permissions: ['start_all'] });
  const op = new Browser();
  await op.call('POST', '/auth/login', { username: 'oper', password: r.json.temporary_password });
  await op.call('POST', '/auth/change-password', { current_password: r.json.temporary_password, new_password: 'river stone lamp under moon' });
  r = await op.call('GET', '/servers');
  check('a non-admin is never asked to set one up', r.status === 200 && (await op.call('GET', '/auth/status')).json?.user?.needs_authenticator === false, r);
  check('...and can\'t', (await op.call('POST', '/auth/authenticator/start')).status === 403);

  // ---- Forgot password with the app
  const anon = new Browser();
  const bad = '000000' === phoneCode(secret1) ? '111111' : '000000';
  const a = await recover('boss', bad, 'violet engine near harbor');
  const b = await recover('nobody-here', bad, 'violet engine near harbor');
  const c = await recover('oper', phoneCode(secret1), 'violet engine near harbor');
  check('wrong code, unknown user, non-admin: the same answer', a.status === 401 && b.status === 401 && c.status === 401 && a.json.error === b.json.error && b.json.error === c.json.error, [a.json, b.json, c.json]);
  check('knowing the username alone is useless', a.json.code === 'bad_code');
  resetFailures();
  r = await recover('boss', phoneCode(secret1, Date.now() + STEP), 'boss boss boss');
  check('a weak new password is refused...', r.status === 400 && r.json?.code === 'weak_password', r.json);
  check('...without spending the code', row('boss').totp_last_step < totp.currentStep() + 1);
  const goodCode = phoneCode(secret1, Date.now() + STEP);
  r = await recover('boss', goodCode, 'violet engine near harbor', anon);
  check('right code -> new password, signed straight in', r.status === 200 && r.json?.user?.username === 'boss', r.json);
  check('...the app works there', (await anon.call('GET', '/servers')).status === 200);
  check('...the other browser was signed out', (await boss.call('GET', '/servers')).status === 401);
  check('...the old password no longer works', (await new Browser().call('POST', '/auth/login', { username: 'boss', password: 'orange kayak at dawn' })).status === 401);
  check('...the new one does', (await new Browser().call('POST', '/auth/login', { username: 'boss', password: 'violet engine near harbor' })).status === 200);
  r = await recover('boss', goodCode, 'copper lantern by the sea');
  check('the same code can\'t be used twice', r.status === 401, r.json);
  r = await recover('boss', phoneCode(secret1), 'copper lantern by the sea');
  check('...nor an older one', r.status === 401, r.json);
  resetFailures();
  r = await recover('boss', phoneCode(secret1, Date.now() - 8 * 60_000), 'copper lantern by the sea');
  check('a phone with the wrong time: told the clocks differ', r.status === 401 && r.json?.code === 'clock_off', r.json);
  const events = (sqlite.prepare('SELECT event FROM auth_events WHERE username = ?').all('boss') as any[]).map((e) => e.event);
  check('history: set up, wrong codes, reset', ['authenticator_set_up', 'authenticator_reset_failed', 'password_reset_by_authenticator'].every((e) => events.includes(e)), events);

  // ---- guessing: 5 wrong codes lock the account
  resetFailures();
  for (let i = 0; i < 5; i++) await recover('boss', String(100000 + i), 'copper lantern by the sea');
  r = await recover('boss', phoneCode(secret1, Date.now() + STEP), 'copper lantern by the sea');
  check('5 wrong codes lock it (even a right code waits)', r.status === 429 && r.json?.code === 'locked', r.json);
  resetFailures();

  // ---- a new phone (needs the password)
  const me = new Browser();
  await me.call('POST', '/auth/login', { username: 'boss', password: 'violet engine near harbor' });
  const s2 = await me.call('POST', '/auth/authenticator/start');
  check('setting up again says it replaces the old one', s2.json?.replacing === true);
  r = await me.call('POST', '/auth/authenticator/confirm', { code: phoneCode(s2.json.secret) });
  check('...and needs the password', r.status === 400 && r.json?.code === 'bad_current', r.json);
  r = await me.call('POST', '/auth/authenticator/confirm', { code: phoneCode(s2.json.secret), password: 'violet engine near harbor' });
  check('...with it, the new phone is set', r.status === 200);
  r = await recover('boss', phoneCode(secret1, Date.now() + 2 * STEP), 'copper lantern by the sea');
  check('the old phone\'s codes stop working', r.status === 401, r.json);
  resetFailures();

  // ---- a second admin loses their phone
  r = await me.call('POST', '/users', { username: 'second', display_name: 'Second Admin', permissions: ['manage_users'] });
  const secondTemp = r.json.temporary_password;
  const second = new Browser();
  await second.call('POST', '/auth/login', { username: 'second', password: secondTemp });
  r = await second.call('GET', '/servers');
  check('a new admin: first the new password...', r.status === 403 && r.json?.code === 'must_change_password', r.json);
  await second.call('POST', '/auth/change-password', { current_password: secondTemp, new_password: 'pine needle on the roof' });
  r = await second.call('GET', '/servers');
  check('...then the authenticator app', r.status === 403 && r.json?.code === 'authenticator_required', r.json);
  await enroll(second);
  check('...then the app', (await second.call('GET', '/servers')).status === 200);
  r = await me.call('GET', '/users');
  check('the Users list shows who has it set up', r.json.find((u: any) => u.username === 'second')?.has_authenticator === true && r.json.find((u: any) => u.username === 'oper')?.has_authenticator === false, r.json);
  r = await me.call('PATCH', `/users/${row('second').id}`, { remove_authenticator: true });
  check('another admin removes it (lost phone)', r.status === 200 && r.json?.has_authenticator === false, r.json);
  r = await second.call('GET', '/servers');
  check('...so they set it up again before going on', r.status === 403 && r.json?.code === 'authenticator_required', r.json);
  r = await me.call('PATCH', `/users/${row('boss').id}`, { remove_authenticator: true });
  check('nobody removes their own (they use a new phone instead)', r.status === 400, r.json);

  // ---- disabled, or no longer an admin
  const secondSecret = await enroll(second);
  await me.call('PATCH', `/users/${row('second').id}`, { disabled: true });
  r = await recover('second', phoneCode(secondSecret, Date.now() + STEP), 'another fine passphrase');
  check('a disabled admin can\'t reset with the app', r.status === 401, r.json);
  resetFailures();
  await me.call('PATCH', `/users/${row('second').id}`, { disabled: false, permissions: ['start_all'] });
  r = await recover('second', phoneCode(secondSecret, Date.now() + STEP), 'another fine passphrase');
  check('someone who is no longer an admin can\'t either', r.status === 401, r.json);
} finally {
  server.close();
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
