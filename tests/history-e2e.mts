// Service history (Level 1), isolated: a throwaway database, systemd output written by hand (what `systemctl show`
// prints), the real parsing / comparing / attribution code, and the API. No SSH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-history-test-'));
Object.assign(process.env, { HEALTHCHECK_DATA_DIR: dataDir, SERVICE_HISTORY_DAYS: '20' });
delete process.env.HEARTBEAT_INTERVAL_CRON;
const { sqlite } = await import('../server/src/db/client.ts');
const { recordHistory, parseHistoryOutput } = await import('../server/src/scan/history.ts');
const { intervalMinutes } = await import('../server/src/routes/heartbeat.ts');
const { createApp } = await import('../server/src/app.ts');
const { hashPassword } = await import('../server/src/auth/passwords.ts');
const { encryptSecret } = await import('../server/src/crypto/secretBox.ts');

let fails = 0;
const check = (label: string, ok: boolean, info?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && info !== undefined ? `   got: ${JSON.stringify(info)}` : ''}`);
};

// ---- a server with three watched services
const now = () => new Date().toISOString();
sqlite.prepare("INSERT INTO groups (id, name, created_at) VALUES (1, 'g', ?), (2, 'other', ?)").run(now(), now());
sqlite.prepare("INSERT INTO servers (id, group_id, name, host, ssh_username, ssh_key_path, created_at) VALUES (1, 1, 'loyalty_t', '10.0.0.1', 'svc', '/k', ?)").run(now());
const def = (id: number, name: string, units: string) =>
  sqlite
    .prepare("INSERT INTO software_definitions (id, name, kind, detect_method, detect_value, start_cmd, stop_cmd, created_at) VALUES (?, ?, 'service', 'systemd', ?, '', '', ?)")
    .run(id, name, units, now());
def(1, 'Artemis', 'artemis.service');
def(2, 'API Manager', 'wso2am.service|wso2apim.service');
def(3, 'Keycloak', 'keycloak.service');
for (const id of [1, 2, 3]) sqlite.prepare('INSERT INTO group_software (group_id, software_id, sequence_order) VALUES (1, ?, ?)').run(id, id);
const server = sqlite.prepare('SELECT * FROM servers WHERE id = 1').get() as any;

// what `grep btime /proc/stat; date +%s; systemctl show ...` prints. Times are "seconds ago" on the server's clock.
type U = { id: string; load?: string; active: string; result?: string; nr?: number; code?: number; status?: number; startedAgo?: number | null; stoppedAgo?: number | null };
let BOOT = Math.floor(Date.now() / 1000) - 100_000;
let SKEW = 0; // server clock minus this machine's, in seconds
let BOOT_ID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
function output(units: U[]): string {
  const serverNow = Math.floor(Date.now() / 1000) + SKEW;
  // btime is the boot moment on the server's own clock, so it moves with that clock
  const btime = BOOT + SKEW;
  const mono = (ago: number | null | undefined) => (ago == null ? 0 : (serverNow - ago - btime) * 1_000_000);
  const blocks = units.map((u) =>
    [
      `Id=${u.id}`,
      `LoadState=${u.load ?? 'loaded'}`,
      `ActiveState=${u.active}`,
      `Result=${u.result ?? 'success'}`,
      `NRestarts=${u.nr ?? 0}`,
      `ExecMainCode=${u.code ?? 0}`,
      `ExecMainStatus=${u.status ?? 0}`,
      `ActiveEnterTimestampMonotonic=${mono(u.startedAgo)}`,
      `InactiveEnterTimestampMonotonic=${mono(u.stoppedAgo)}`,
    ].join('\n'),
  );
  return `btime ${btime}\n${BOOT_ID}\n${serverNow}\n${blocks.join('\n\n')}\n`;
}
const others: U[] = [
  { id: 'wso2am.service', load: 'not-found', active: 'inactive' },
  { id: 'wso2apim.service', active: 'active', startedAgo: 50_000 },
  { id: 'keycloak.service', active: 'inactive', stoppedAgo: 60_000, code: 2, status: 15 },
];
// in the order they were recorded (the made-up timeline below isn't always in time order across a reboot)
const events = (sw: number) => sqlite.prepare('SELECT * FROM service_events WHERE software_id = ? ORDER BY id').all(sw) as any[];
// a Healthcheck run, and its step on one service (the history counts a run only for the services it handled)
const run = (group: number, kind: string, by: string, fromAgoS: number, toAgoS: number, steps: [number, string][] = []) => {
  const id = Number(
    sqlite
      .prepare("INSERT INTO job_runs (group_id, kind, status, started_at, finished_at, started_by) VALUES (?, ?, 'succeeded', ?, ?, ?)")
      .run(group, kind, new Date(Date.now() - fromAgoS * 1000).toISOString(), new Date(Date.now() - toAgoS * 1000).toISOString(), by).lastInsertRowid,
  );
  for (const [sw, action] of steps)
    sqlite
      .prepare("INSERT INTO job_steps (job_run_id, server_id, software_id, action, status, started_at, finished_at) VALUES (?, 1, ?, ?, 'healthy', ?, ?)")
      .run(id, sw, action, new Date(Date.now() - fromAgoS * 1000).toISOString(), new Date(Date.now() - toAgoS * 1000).toISOString());
  return id;
};
const last = (sw: number) => events(sw).at(-1);
const near = (iso: string, agoS: number, slackS = 3) => Math.abs(new Date(iso).getTime() - (Date.now() - agoS * 1000)) <= slackS * 1000;

try {
  // ---- parsing
  const parsed = parseHistoryOutput(output([{ id: 'artemis.service', active: 'active', startedAgo: 9000, nr: 2 }]));
  check('parses boot time, boot id, server clock and each unit', parsed.bootTime === BOOT && parsed.bootId === BOOT_ID && parsed.units[0]?.id === 'artemis.service' && parsed.units[0].nRestarts === 2);

  // ---- 1. first read: each service's latest change, so the history isn't empty
  let n = recordHistory(server, output([{ id: 'artemis.service', active: 'active', startedAgo: 9000 }, ...others]));
  check('first read: one entry per service (their latest change)', n === 3 && events(1).length === 1 && events(2).length === 1 && events(3).length === 1, n);
  check('...Artemis "started", at systemd\'s exact time', last(1).kind === 'started' && near(last(1).at, 9000), last(1));
  check('...a service with alternative unit names uses the one that exists (wso2apim)', last(2).kind === 'started' && near(last(2).at, 50_000), last(2));
  check('...Keycloak stopped normally (SIGTERM is a normal stop)', last(3).kind === 'stopped' && last(3).detail === null, last(3));
  check('...nobody ran anything in Healthcheck: "outside"', last(1).source === 'outside');

  // ---- 2. nothing changed
  n = recordHistory(server, output([{ id: 'artemis.service', active: 'active', startedAgo: 9000 }, ...others]));
  check('nothing changed: nothing recorded', n === 0, n);

  // ---- 3. someone stops it from the terminal
  n = recordHistory(server, output([{ id: 'artemis.service', active: 'inactive', startedAgo: 9000, stoppedAgo: 600, code: 2, status: 15 }, ...others]));
  check('stopped from a terminal: "Stopped", outside Healthcheck, at the real time (10 min ago)', n === 1 && last(1).kind === 'stopped' && last(1).source === 'outside' && near(last(1).at, 600), last(1));

  // ---- 4. started from Healthcheck by sam
  run(1, 'start_one', 'sam', 120, 58, [[1, 'start']]);
  run(2, 'stop_all', 'other', 600, 0);
  n = recordHistory(server, output([{ id: 'artemis.service', active: 'active', startedAgo: 60, stoppedAgo: 600 }, ...others]));
  check('started by a Healthcheck run: "In Healthcheck, by sam (Start)"', n === 1 && last(1).kind === 'started' && last(1).source === 'healthcheck' && last(1).actor === 'sam' && last(1).job_kind === 'start_one', last(1));
  check('...a run on another server at the same time is not mixed in', last(1).actor !== 'other');
  check('...recorded as read from the timestamps (origin "snapshot")', last(1).origin === 'snapshot', last(1).origin);

  // ---- 4b. a Check status (or a run on other services) at the same moment never takes the credit
  run(1, 'scan', 'temp', 40, 20);
  run(1, 'stop_one', 'temp', 40, 20, [[3, 'stop']]);
  n = recordHistory(server, output([{ id: 'artemis.service', active: 'active', startedAgo: 30, stoppedAgo: 35 }, ...others]));
  check('stopped + started from a terminal during a Check status: "outside", not the Check status', n === 2 && events(1).slice(-2).every((e) => e.source === 'outside'), events(1).slice(-2));

  // ---- 5. it crashes
  n = recordHistory(server, output([{ id: 'artemis.service', active: 'failed', result: 'exit-code', code: 1, status: 1, startedAgo: 60, stoppedAgo: 5 }, ...others]));
  check('crash: "Stopped with an error", exit code 1', n === 1 && last(1).kind === 'crashed' && last(1).detail === 'exit code 1', last(1));

  // ---- 6. stopped and started again between two checks, from a terminal
  n = recordHistory(server, output([{ id: 'artemis.service', active: 'active', startedAgo: 2, stoppedAgo: 4 }, ...others]));
  const two = events(1).slice(-2);
  check('stop + start between two checks: both recorded, in order', n === 2 && two[0].kind === 'stopped' && two[1].kind === 'started' && two.every((e) => e.source === 'outside'), two);

  // ---- 7. systemd restarts it by itself after a crash
  BOOT -= 0;
  n = recordHistory(server, output([{ id: 'artemis.service', active: 'active', nr: 3, startedAgo: 1, stoppedAgo: 1.5 }, ...others]));
  const auto = events(1).slice(-2);
  check('automatic restarts: "Stopped with an error" + started by systemd, with how many times', n === 2 && auto[0].kind === 'crashed' && auto[1].source === 'systemd' && /3 times/.test(auto[1].detail), auto);

  // ---- 8. the whole server restarts
  BOOT = Math.floor(Date.now() / 1000) - 120;
  BOOT_ID = '6f0c2d1e-9a7b-4c3d-8e5f-0a1b2c3d4e5f';
  n = recordHistory(server, output([{ id: 'artemis.service', active: 'active', startedAgo: 100 }, ...others.map((o) => ({ ...o, startedAgo: o.startedAgo ? 110 : o.startedAgo, stoppedAgo: o.stoppedAgo ? 90 : o.stoppedAgo }))]));
  const boot = events(1).slice(-2);
  check('server restart: "Stopped" (the server restarted) then "Started"', boot[0].kind === 'stopped' && boot[0].source === 'reboot' && boot[1].kind === 'started' && near(boot[1].at, 100), boot);
  check('...a service that was already stopped gets no "stopped by the restart"', !events(3).some((e) => e.source === 'reboot'), events(3));

  // ---- 9. the server's clock is an hour behind: times land on this machine's clock
  SKEW = -3600;
  n = recordHistory(server, output([{ id: 'artemis.service', active: 'inactive', startedAgo: 100, stoppedAgo: 20 }, ...others.map((o) => ({ ...o, startedAgo: o.startedAgo ? 110 : o.startedAgo, stoppedAgo: o.stoppedAgo ? 90 : o.stoppedAgo }))]));
  check('server clock corrected by an hour: still recorded at the right moment (20 s ago)', n === 1 && near(last(1).at, 20), last(1));
  check('...and the clock change alone is not taken for a server restart', !events(1).slice(-1).some((e) => e.source === 'reboot') && events(1).filter((e) => e.source === 'reboot').length === 1);
  SKEW = 0;

  // ---- 9b. how Java stops: exit code 143 is a normal stop; an exit code during a Healthcheck Stop isn't a crash
  const art = { id: 'artemis.service', active: 'inactive', startedAgo: 100, stoppedAgo: 20 };
  const kc = (u: Partial<U>): U => ({ id: 'keycloak.service', active: 'active', startedAgo: 15, stoppedAgo: 90, ...u });
  const rest = others.filter((o) => o.id !== 'keycloak.service').map((o) => ({ ...o, startedAgo: o.startedAgo ? 110 : o.startedAgo }));
  recordHistory(server, output([art, ...rest, kc({})]));
  n = recordHistory(server, output([art, ...rest, kc({ active: 'failed', result: 'exit-code', code: 1, status: 143, stoppedAgo: 12 })]));
  check('Java stopped from a terminal (exit code 143): a normal "Stopped", not an error', n === 1 && last(3).kind === 'stopped' && last(3).detail === null, last(3));
  recordHistory(server, output([art, ...rest, kc({ startedAgo: 11, stoppedAgo: 12 })]));
  run(1, 'stop_all', 'mona', 9, 3, [[3, 'stop']]);
  n = recordHistory(server, output([art, ...rest, kc({ active: 'failed', result: 'exit-code', code: 1, status: 1, startedAgo: 11, stoppedAgo: 6 })]));
  check('exit code 1 during a Healthcheck Stop All: "Stopped" (it ended with exit code 1), by mona', n === 1 && last(3).kind === 'stopped' && last(3).detail === 'it ended with exit code 1' && last(3).actor === 'mona', last(3));

  // ---- 10. keeping SERVICE_HISTORY_DAYS (20 here)
  const old = (days: number) =>
    sqlite
      .prepare("INSERT INTO service_events (server_id, software_id, at, kind, source, boot_time, mono, recorded_at) VALUES (1, 3, ?, 'stopped', 'outside', 1, ?, ?)")
      .run(new Date(Date.now() - days * 86400_000).toISOString(), days, now());
  old(25);
  old(15);
  recordHistory(server, output([{ id: 'artemis.service', active: 'inactive', startedAgo: 100, stoppedAgo: 20 }, ...others.map((o) => ({ ...o, startedAgo: o.startedAgo ? 110 : o.startedAgo, stoppedAgo: o.stoppedAgo ? 90 : o.stoppedAgo }))]));
  const kept = events(3).map((e) => Math.round((Date.now() - new Date(e.at).getTime()) / 86400_000));
  check('older than SERVICE_HISTORY_DAYS (20) is deleted, newer kept', !kept.includes(25) && kept.includes(15), kept);

  // ---- 11. the check interval
  check('interval: "*/30 * * * *" = 30 min, "0 */2 * * *" = 120, "0 * * * *" = 60, "15 */6 * * *" = 360', intervalMinutes('*/30 * * * *') === 30 && intervalMinutes('0 */2 * * *') === 120 && intervalMinutes('0 * * * *') === 60 && intervalMinutes('15 */6 * * *') === 360);
  check('...the default is every 2 hours', intervalMinutes() === 120, intervalMinutes());

  // ---- 12. the API the history window reads
  sqlite
    .prepare("INSERT INTO users (username, display_name, password_hash, is_admin, permissions, password_changed_at, created_at, totp_secret_enc) VALUES ('viewer', 'V', ?, 0, '[]', ?, ?, NULL)")
    .run(await hashPassword('long enough pass phrase'), now(), now());
  void encryptSecret;
  const app = createApp().listen(4191, '127.0.0.1');
  const login = await fetch('http://127.0.0.1:4191/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Healthcheck': '1' }, body: JSON.stringify({ username: 'viewer', password: 'long enough pass phrase' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const res = await fetch('http://127.0.0.1:4191/api/servers/1/software/1/history', { headers: { Cookie: cookie } });
  const body = await res.json();
  check('a viewer (no permissions) can read the history', res.status === 200, res.status);
  check('...newest first, with how long it is kept and the check interval', body.events.length === events(1).length && body.events[0].at >= body.events.at(-1).at && body.days === 20 && body.interval_minutes === 120, { days: body.days, n: body.events.length });
  check('...signed out: refused', (await fetch('http://127.0.0.1:4191/api/servers/1/software/1/history')).status === 401);
  await new Promise((r) => app.close(r));
} finally {
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
