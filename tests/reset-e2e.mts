// Admin password reset without email: `npm run reset-password -- <user>` prints a one-time link. Fully isolated:
// a throwaway database, the app without its schedulers (nothing reaches the real servers), and the real npm command
// pointed at the same throwaway database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { enroll } from './totp-helper.mts';
import { fileURLToPath } from 'node:url';
// the Healthcheck folder (this file is in tests/)
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-reset-test-'));
const PUBLIC = 'https://hc.example.test';
Object.assign(process.env, { HEALTHCHECK_DATA_DIR: dataDir });
const { createApp } = await import('../server/src/app.ts');
const { sqlite } = await import('../server/src/db/client.ts');
const server = createApp().listen(4197, '127.0.0.1');
const API = 'http://127.0.0.1:4197/api';

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
// the real command, as someone on the Healthcheck machine would type it (from the project folder)
const resetCmd = (...args: string[]) => {
  const r = spawnSync('npm', ['run', '--silent', 'reset-password', '--', ...args], {
    cwd: ROOT,
    env: { ...process.env, HEALTHCHECK_DATA_DIR: dataDir, PUBLIC_URL: PUBLIC },
    encoding: 'utf8',
    shell: true,
  });
  const out = `${r.stdout}${r.stderr}`;
  return { code: r.status, out, link: out.match(/https?:\/\/\S+\/reset-password\?token=[\w-]+/)?.[0] };
};
const tokenOf = (link?: string) => (link ? new URL(link).searchParams.get('token')! : '');
const audits = (event: string) => sqlite.prepare('SELECT username, actor, detail FROM auth_events WHERE event = ?').all(event) as any[];

try {
  const anon = new Browser();
  let r = await anon.call('GET', '/auth/status');
  check('status: setup needed, nothing about email', r.json?.setup_needed === true && !('email_enabled' in r.json), r.json);
  const boss = new Browser();
  r = await boss.call('POST', '/auth/setup', { username: 'boss', display_name: 'Big Boss', password: 'orange kayak at dawn' });
  check('first admin created, no recovery codes handed out', r.status === 201 && !('recovery_codes' in r.json) && !('email' in r.json.user), r.json);
  await enroll(boss);

  // ---- the command itself
  let c = resetCmd();
  check('no username: usage + the list of users, exit code 1', c.code === 1 && /Usage/.test(c.out) && /boss \(admin\)/.test(c.out), c);
  c = resetCmd('nobody');
  check('unknown username: says so, exit code 1', c.code === 1 && /No user called "nobody"/.test(c.out), c);

  c = resetCmd('boss');
  check('prints a one-time link on PUBLIC_URL', c.code === 0 && c.link?.startsWith(`${PUBLIC}/reset-password?token=`) === true, c.out);
  check('...and says how long it works', /works once, for 30 minutes/.test(c.out), c.out);
  const t1 = tokenOf(c.link);
  check('the token is 256 bits', Buffer.from(t1, 'base64url').length === 32, t1);
  const stored = sqlite.prepare('SELECT token_hash FROM password_resets').all() as any[];
  check('only a hash of the link is stored', stored.length === 1 && stored[0].token_hash !== t1 && !stored[0].token_hash.includes(t1));
  check('making a link changes nothing else: the old password still works', (await new Browser().call('POST', '/auth/login', { username: 'boss', password: 'orange kayak at dawn' })).status === 200);

  const t2 = tokenOf(resetCmd('boss').link);
  check('running it again cancels the earlier link', (await anon.call('POST', '/auth/reset/check', { token: t1 })).json?.valid === false);
  r = await anon.call('POST', '/auth/reset/check', { token: t2 });
  check('the new link is valid and says whose it is', r.json?.valid === true && r.json?.username === 'boss' && r.json?.display_name === 'Big Boss', r.json);
  check('a made-up token is refused', (await anon.call('POST', '/auth/reset/check', { token: 'x'.repeat(43) })).json?.valid === false);

  r = await anon.call('POST', '/auth/reset', { token: t2, new_password: 'boss boss boss' });
  check('a weak new password is refused...', r.status === 400 && r.json?.code === 'weak_password', r.json);
  check('...and the link still works', (await anon.call('POST', '/auth/reset/check', { token: t2 })).json?.valid === true);
  r = await anon.call('POST', '/auth/reset', { token: t2, new_password: 'violet engine near harbor' });
  check('reset with the link: new password, signed straight in', r.status === 200 && r.json?.user?.username === 'boss' && !r.json.user.must_change_password, r.json);
  check('...the app works in that browser', (await anon.call('GET', '/servers')).status === 200);
  check('...the other browser was signed out', (await boss.call('GET', '/servers')).status === 401);
  r = await new Browser().call('POST', '/auth/reset', { token: t2, new_password: 'another strong passphrase' });
  check('the link works only once', r.status === 400 && r.json?.code === 'bad_link', r.json);
  check('old password no longer works', (await new Browser().call('POST', '/auth/login', { username: 'boss', password: 'orange kayak at dawn' })).status === 401);
  check('new password works', (await new Browser().call('POST', '/auth/login', { username: 'boss', password: 'violet engine near harbor' })).status === 200);

  const t3 = tokenOf(resetCmd('boss').link);
  sqlite.prepare('UPDATE password_resets SET expires_at = ? WHERE used_at IS NULL').run(new Date(Date.now() - 1000).toISOString());
  r = await anon.call('POST', '/auth/reset', { token: t3, new_password: 'yet another strong one' });
  check('an expired link is refused', r.status === 400 && r.json?.code === 'bad_link', r.json);

  check('history: the link was made "by command line"', audits('reset_link_created').some((e) => e.username === 'boss' && e.actor === 'command line'));
  check('history: the password was reset with it', audits('password_reset_by_link').some((e) => e.username === 'boss'));

  // ---- locked, disabled, and no admin left
  const admin = new Browser();
  await admin.call('POST', '/auth/login', { username: 'boss', password: 'violet engine near harbor' });
  r = await admin.call('POST', '/users', { username: 'oper', display_name: 'Oper Ator', email: 'oper@example.test', permissions: ['start_all'] });
  check('a new account has no email field any more (email in the request is ignored)', r.status === 201 && !('email' in r.json.user), r.json);
  const operId = r.json.user.id;
  sqlite.prepare('UPDATE users SET locked_until = ?, disabled = 1 WHERE username = ?').run(new Date(Date.now() + 3600_000).toISOString(), 'boss');
  c = resetCmd('oper');
  const oper = sqlite.prepare('SELECT is_admin, permissions FROM users WHERE id = ?').get(operId) as any;
  check('no active admin left: the command makes the account an admin, and says so', oper.is_admin === 1 && JSON.parse(oper.permissions).length === 13 && /now an admin/.test(c.out), { oper, out: c.out });
  c = resetCmd('boss');
  const b = sqlite.prepare('SELECT disabled, locked_until FROM users WHERE username = ?').get('boss') as any;
  check('a locked, disabled account is unlocked and enabled', b.disabled === 0 && b.locked_until === null, b);
  check('...not "made admin" again (it already is)', !/now an admin/.test(c.out), c.out);
  r = await new Browser().call('POST', '/auth/reset', { token: tokenOf(c.link), new_password: 'copper lantern by the sea' });
  check('...and its link works', r.status === 200, r.json);

  // ---- recovery codes and email are gone
  const me = new Browser();
  await me.call('POST', '/auth/login', { username: 'boss', password: 'copper lantern by the sea' });
  for (const p of ['/auth/recovery-codes', '/auth/email']) {
    r = await me.call('POST', p, { password: 'copper lantern by the sea', email: 'boss@example.test' });
    check(`signed in: ${p} is gone (refused)`, r.status === 403 || r.status === 404, r);
  }
  for (const p of ['/auth/recover', '/auth/forgot']) {
    r = await new Browser().call('POST', p, { username: 'boss', identifier: 'boss', code: 'aaaa-bbbb-cc', new_password: 'purple tractor in the rain' });
    check(`signed out: ${p} is gone (refused)`, r.status === 401 || r.status === 404, r);
  }
  r = await me.call('PATCH', `/users/${operId}`, { display_name: 'Operator', email: 'x@example.test' });
  check('Edit still saves the name (an email in the request is ignored)', r.status === 200 && r.json?.display_name === 'Operator' && !('email' in r.json), r.json);
} finally {
  server.close();
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
