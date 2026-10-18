// A market's first install: the built app (as npm start / the systemd service runs it) on an empty data folder,
// driven through a real browser. No servers exist, so nothing reaches real machines.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { phoneCode } from './totp-helper.mts';
import { fileURLToPath } from 'node:url';
// the Healthcheck folder (this file is in tests/)
const ROOT = fileURLToPath(new URL('..', import.meta.url));


// screenshots go to the folder given as the first argument (a temporary one otherwise)
const OUT = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'hc-fresh-shots-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-fresh-market-'));
const PORT = 4194;
const BASE = `http://127.0.0.1:${PORT}`;
let fails = 0;
const check = (label: string, ok: boolean, info?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && info !== undefined ? `   got: ${JSON.stringify(info)}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- start it like an installer would
let log = '';
const app = spawn(process.execPath, ['server/dist/index.js'], {
  cwd: ROOT,
  env: { ...process.env, HEALTHCHECK_DATA_DIR: dataDir, PORT: String(PORT), HOST: '127.0.0.1' },
});
app.stdout.on('data', (d) => (log += d));
app.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 60 && !/listening/.test(log); i++) await sleep(250);

// headless Chrome for the browser checks: CHROME_PATH, or the usual place on Windows / Linux
const chrome = process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'google-chrome');
const dbg = 9500 + Math.floor(Math.random() * 100);
const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'hc-fi-'))}`, `--remote-debugging-port=${dbg}`, 'about:blank']);
let ws: WebSocket | undefined;
try {
  check('starts and listens only on this machine (127.0.0.1)', new RegExp(`listening on http://127.0.0.1:${PORT}`).test(log), log);
  check('the shipped catalog and conditions are loaded', /Shipped catalog\/conditions applied/.test(log) && /catalog: added \d+/.test(log), log);
  const files = fs.readdirSync(dataDir);
  check('a fresh data folder: database + master.key created', files.includes('healthcheck.sqlite') && files.includes('master.key'), files);
  let status = await (await fetch(`${BASE}/api/auth/status`)).json();
  check('no accounts at all: setup needed', status.setup_needed === true && status.user === null, status);
  check('the API refuses everything else', (await fetch(`${BASE}/api/servers`)).status === 401);

  let targets: any[] = [];
  for (let i = 0; i < 40; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${dbg}/json`)).json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch {}
    await sleep(250);
  }
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws!.addEventListener('open', r));
  let id = 0;
  const pending = new Map<number, (m: any) => void>();
  ws.addEventListener('message', (e: any) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) pending.get(m.id)!(m);
  });
  const send = (method: string, params: any = {}) => new Promise<any>((r) => { const n = ++id; pending.set(n, r); ws!.send(JSON.stringify({ id: n, method, params })); });
  const js = async (expr: string) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const shot = async (name: string) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  };
  const h1 = () => js(`document.querySelector('h1')?.textContent`);
  const fill = (sel: string, v: string) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return !!el; })()`);
  const click = (sel: string, text?: string) => js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => ${text ? `e.textContent.trim().startsWith(${JSON.stringify(text)})` : 'true'}); el?.click(); return !!el; })()`);

  // 1. the installer opens it
  await send('Page.navigate', { url: `${BASE}/` });
  await sleep(2000);
  check('the browser opens on "Create the first admin"', (await h1()) === 'Create the first admin', await h1());
  await shot('f1-first-admin');
  await fill('#setup-name', 'Market Admin');
  await fill('#setup-username', 'market.admin');
  await js(`(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; for (const el of document.querySelectorAll('.auth-form input[type=password]')) { set.call(el, 'blue harbor lights at night'); el.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
  await click('button.auth-submit');
  await sleep(2000);

  // 2. straight to the authenticator app
  check('next: "Set up your authenticator app"', (await h1()) === 'Set up your authenticator app', await h1());
  await js(`document.querySelector('.totp-key').open = true`);
  const secret = String(await js(`document.querySelector('.totp-key code').textContent`)).replace(/\s/g, '');
  await fill('#totp-code', phoneCode(secret));
  await click('button.auth-submit');
  await sleep(2500);

  // 3. in the app
  check('then the app itself (servers overview)', (await js('location.pathname')) === '/' && (await js(`!!document.querySelector('.sidebar')`)) === true);
  await shot('f2-in-the-app');
  check('the sidebar shows the admin', /Market Admin/.test(String(await js(`document.querySelector('.sb-user')?.textContent`))));
  status = await (await fetch(`${BASE}/api/auth/status`)).json();
  check('setup is closed now', status.setup_needed === false);
  const late = await fetch(`${BASE}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Healthcheck': '1' },
    body: JSON.stringify({ username: 'intruder', display_name: 'Intruder', password: 'some long passphrase here' }),
  });
  check('a second "first admin" is refused', late.status === 409, late.status);

  // 4. the catalog is there, and the admin adds a colleague
  const catalog = await js(`fetch('/api/software-definitions').then(r => r.json()).then(a => a.length)`);
  check(`the software catalog arrived with the app (${catalog} components)`, Number(catalog) > 0, catalog);
  await send('Page.navigate', { url: `${BASE}/users` });
  await sleep(1800);
  await click('button.primary', 'Add user');
  await sleep(300);
  await js(`(() => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; const [n, u] = document.querySelectorAll('.users-add input'); set.call(n, 'First Operator'); n.dispatchEvent(new Event('input', { bubbles: true })); set.call(u, 'operator1'); u.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click('.users-add button.primary', 'Create account');
  await sleep(1500);
  const temp = String(await js(`document.querySelector('.users-temp-pw code')?.textContent ?? ''`));
  check('adding a colleague shows their one-time password', /^\w{4}-\w{4}-\w{4}-\w{4}$/.test(temp), temp);
  await shot('f3-colleague-added');
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Healthcheck': '1' },
    body: JSON.stringify({ username: 'operator1', password: temp }),
  });
  const lj = await login.json();
  check('the colleague signs in and must choose a password (no authenticator: not an admin)', login.status === 200 && lj.user.must_change_password === true && lj.user.needs_authenticator === false, lj);
} finally {
  ws?.close();
  proc.kill();
  app.kill();
  await sleep(800);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
