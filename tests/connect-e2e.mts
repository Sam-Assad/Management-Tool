// Why a connection failed, isolated: real connections on this machine only (an open port, a closed one, one that
// answers but isn't SSH, an SSH server inside this test that refuses the password), the explanations, Add server
// and the reachability check before a run on several servers. Nothing outside this machine is contacted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import ssh2 from 'ssh2';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-connect-test-'));
Object.assign(process.env, { HEALTHCHECK_DATA_DIR: dataDir });
const { sqlite } = await import('../server/src/db/client.ts');
const { createApp } = await import('../server/src/app.ts');
const { hashPassword } = await import('../server/src/auth/passwords.ts');
const { probeTcp, usernameProblem, hostProblem } = await import('../server/src/ssh/explain.ts');
const { bootstrapServerWithPassword } = await import('../server/src/ssh/passwordBootstrap.ts');
const { ensureAppKeypair } = await import('../server/src/ssh/keyManager.ts');

let fails = 0;
const check = (label: string, ok: boolean, info?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && info !== undefined ? `   got: ${JSON.stringify(info)}` : ''}`);
};
const listen = (server: net.Server) => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port)));

// an open port that never says anything (not SSH)
const silent = net.createServer(() => {});
const silentPort = await listen(silent);
// a closed port: opened, then closed again
const tmp = net.createServer();
const closedPort = await listen(tmp);
await new Promise((r) => tmp.close(r));
// an SSH server that refuses every sign-in
const hostKey = ssh2.utils.generateKeyPairSync('ed25519').private;
const sshd = new ssh2.Server({ hostKeys: [hostKey] }, (client: any) => {
  client.on('authentication', (ctx: any) => ctx.reject(['password', 'keyboard-interactive']));
  client.on('error', () => {});
});
const sshPort = await listen(sshd as unknown as net.Server);

const app = createApp().listen(4196, '127.0.0.1');
const API = 'http://127.0.0.1:4196/api';
try {
  // ---- the plain connection check
  check('an open port: open', (await probeTcp('127.0.0.1', silentPort)) === 'open');
  check('a closed port: refused', (await probeTcp('127.0.0.1', closedPort)) === 'refused');
  check('a name that doesn\'t exist: unknown host', (await probeTcp('no-such-server.invalid', 22)) === 'unknown_host');

  // ---- typos are caught before anything is tried
  const typo = usernameProblem('svc_user`');
  check('a stray ` in the user name: caught, and named', typo?.kind === 'bad_input' && typo.title.includes('“`”') && /typo/.test(typo.why), typo);
  check('...a space too', usernameProblem('svc user')?.title.includes('a space') === true);
  check('...ordinary names (svc_user, DOMAIN\\user, user@corp) are fine', !usernameProblem('svc_user') && !usernameProblem('DOMAIN\\user') && !usernameProblem('user@corp.local'));
  check('a web address in the host field: caught', hostProblem('http://10.0.0.1')?.kind === 'bad_input' && !hostProblem('192.168.122.5'));

  // ---- signing in with the password (what Add server does)
  let r = await bootstrapServerWithPassword({ host: '127.0.0.1', port: 22, username: 'svc_user`', password: 'x' });
  check('Add server with the typo: refused straight away, with why', !r.ok && r.problem?.kind === 'bad_input', r);
  r = await bootstrapServerWithPassword({ host: '127.0.0.1', port: closedPort, username: 'svc_user', password: 'x' });
  check('a closed port: "refused the connection on port N" (the server is on, SSH isn\'t there)', r.problem?.kind === 'refused' && r.problem.title === `127.0.0.1 refused the connection on port ${closedPort}` && /sshd/.test(r.problem.fix), r.problem);
  r = await bootstrapServerWithPassword({ host: 'no-such-server.invalid', port: 22, username: 'svc_user', password: 'x' });
  check('a name that doesn\'t exist: "There\'s no server called …", use the IP', r.problem?.kind === 'unknown_host' && /IP address/.test(r.problem.fix), r.problem);
  r = await bootstrapServerWithPassword({ host: '127.0.0.1', port: sshPort, username: 'svc_user', password: 'wrong' });
  check('a wrong password: "refused that user name or password", with what to check', r.problem?.kind === 'auth_failed' && /user name or password/.test(r.problem.title) && /PasswordAuthentication/.test(r.problem.fix), r.problem);
  const t0 = Date.now();
  r = await bootstrapServerWithPassword({ host: '127.0.0.1', port: silentPort, username: 'svc_user', password: 'x' });
  check('a port that answers but isn\'t SSH: "answers … but not like an SSH server" (the handshake timeout)', r.problem?.kind === 'not_ssh' && /not like an SSH server/.test(r.problem.title), r.problem);
  check('...after the 10 s SSH wait, not longer', Date.now() - t0 < 14000, Date.now() - t0);

  // ---- the API: Add server, the reachability check
  const now = new Date().toISOString();
  sqlite
    .prepare("INSERT INTO users (username, display_name, password_hash, is_admin, permissions, password_changed_at, created_at) VALUES ('ops', 'Ops', ?, 0, ?, ?, ?)")
    .run(await hashPassword('long enough pass phrase'), JSON.stringify(['manage_servers', 'start_all', 'restart_all']), now, now);
  const login = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Healthcheck': '1' }, body: JSON.stringify({ username: 'ops', password: 'long enough pass phrase' }) });
  const headers = { 'Content-Type': 'application/json', 'X-Healthcheck': '1', Cookie: login.headers.get('set-cookie')!.split(';')[0] };
  const post = async (p: string, body: unknown) => {
    const res = await fetch(`${API}${p}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  let res = await post('/servers', { name: 'test', host: '127.0.0.1', port: closedPort, ssh_username: 'svc_user', password: 'x' });
  check('Add server, closed port: 400 with the explanation (title, why, what to check)', res.status === 400 && res.json?.problem?.kind === 'refused' && res.json.error === res.json.problem.title && !!res.json.problem.why && !!res.json.problem.fix, res.json);
  check('...and nothing was added', (sqlite.prepare('SELECT COUNT(*) n FROM servers').get() as any).n === 0);

  // two servers Healthcheck knows: one whose SSH port is closed now, one that answers with SSH (the key is refused)
  const { privateKeyPath } = ensureAppKeypair();
  sqlite.prepare("INSERT INTO groups (id, name, created_at) VALUES (1, 'g1', ?), (2, 'g2', ?)").run(now, now);
  sqlite
    .prepare("INSERT INTO servers (id, group_id, name, host, port, ssh_username, ssh_key_path, connection_status, created_at) VALUES (1, 1, 'down_one', '127.0.0.1', ?, 'svc_user', ?, 'ok', ?), (2, 2, 'refusing_one', '127.0.0.1', ?, 'svc_user', ?, 'ok', ?)")
    .run(closedPort, privateKeyPath, now, sshPort, privateKeyPath, now);
  res = await post('/servers/reachability', { ids: [1, 2], action: 'start' });
  const [one, two] = res.json?.servers ?? [];
  check('reachability: each server, reachable or not, with why', res.status === 200 && one?.ok === false && two?.ok === false, res.json);
  check('...the closed one: "refused the connection"', one?.problem?.kind === 'refused' && one.name === 'down_one', one);
  check('...the one refusing Healthcheck\'s key: says so, and how to fix it (add it again with the password)', two?.problem?.kind === 'auth_failed' && /key/.test(two.problem.title) && /password/.test(two.problem.fix), two);
  check('...their badges updated (unreachable / login refused)', (sqlite.prepare('SELECT connection_status s FROM servers WHERE id = 1').get() as any).s === 'unreachable' && (sqlite.prepare('SELECT connection_status s FROM servers WHERE id = 2').get() as any).s === 'auth_failed');
  res = await post('/servers/reachability', { ids: [1], action: 'stop' });
  check('...asking before Stop All needs the Stop All permission', res.status === 403, res);
} finally {
  app.close();
  silent.close();
  (sshd as any).close();
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
