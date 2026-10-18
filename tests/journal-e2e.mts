// Service history from the journal, isolated: a throwaway database, journal lines written like the real server's
// (same message ids and fields as loyalty_1's journal), the real reading / attribution code, and the API. No SSH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-journal-test-'));
Object.assign(process.env, { HEALTHCHECK_DATA_DIR: dataDir, SERVICE_HISTORY_DAYS: '20' });
delete process.env.HEARTBEAT_INTERVAL_CRON;
const { sqlite } = await import('../server/src/db/client.ts');
const { recordHistory } = await import('../server/src/scan/history.ts');
const { MSG, systemctlAction, parseJournal } = await import('../server/src/scan/journal.ts');
const { createApp } = await import('../server/src/app.ts');
const { hashPassword } = await import('../server/src/auth/passwords.ts');

let fails = 0;
const check = (label: string, ok: boolean, info?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && info !== undefined ? `   got: ${JSON.stringify(info)}` : ''}`);
};

// ---- a server (Healthcheck signs in as svc_user) with two watched services
const T0 = Date.now();
const iso = (agoS: number) => new Date(T0 - agoS * 1000).toISOString();
sqlite.prepare("INSERT INTO groups (id, name, created_at) VALUES (1, 'g', ?)").run(iso(0));
sqlite.prepare("INSERT INTO servers (id, group_id, name, host, ssh_username, ssh_key_path, created_at) VALUES (1, 1, 'loyalty_t', '10.0.0.1', 'svc_user', '/k', ?)").run(iso(0));
const def = (id: number, name: string, units: string) =>
  sqlite
    .prepare("INSERT INTO software_definitions (id, name, kind, detect_method, detect_value, start_cmd, stop_cmd, created_at) VALUES (?, ?, 'service', 'systemd', ?, '', '', ?)")
    .run(id, name, units, iso(0));
def(1, 'Artemis', 'artemis'); // without ".service": the journal names it in full
def(2, 'Keycloak', 'keycloak.service');
for (const id of [1, 2]) sqlite.prepare('INSERT INTO group_software (group_id, software_id, sequence_order) VALUES (1, ?, ?)').run(id, id);
const server = sqlite.prepare('SELECT * FROM servers WHERE id = 1').get() as any;

const run = (kind: string, by: string, fromAgo: number, toAgo: number, steps: [number, string][] = []) => {
  const id = Number(
    sqlite.prepare("INSERT INTO job_runs (group_id, kind, status, started_at, finished_at, started_by) VALUES (1, ?, 'succeeded', ?, ?, ?)").run(kind, iso(fromAgo), iso(toAgo), by).lastInsertRowid,
  );
  for (const [sw, action] of steps)
    sqlite.prepare("INSERT INTO job_steps (job_run_id, server_id, software_id, action, status, started_at, finished_at) VALUES (?, 1, ?, ?, 'healthy', ?, ?)").run(id, sw, action, iso(fromAgo), iso(toAgo));
};

// ---- journal lines, like `journalctl -o json --output-fields=...` prints them (times: seconds before T0)
let BOOT_ID = 'afe24cac65e84a15b592bc5e3431bb87';
let BOOT_AGO = 5000;
const U: string[] = [];
const A: string[] = [];
const base = (ago: number) => ({ __REALTIME_TIMESTAMP: String(Math.round((T0 - ago * 1000) * 1000)), __MONOTONIC_TIMESTAMP: String(Math.round((BOOT_AGO - ago) * 1e6)), _BOOT_ID: BOOT_ID });
const unitLine = (ago: number, unit: string, f: Record<string, string>) => U.push(JSON.stringify({ ...base(ago), _PID: '1', SYSLOG_IDENTIFIER: 'systemd', UNIT: unit, ...f }));
const L = {
  starting: (ago: number, u: string) => unitLine(ago, u, { MESSAGE_ID: MSG.starting, JOB_TYPE: 'start', MESSAGE: `Starting ${u}...` }),
  started: (ago: number, u: string) => unitLine(ago, u, { MESSAGE_ID: MSG.started, JOB_TYPE: 'start', JOB_RESULT: 'done', MESSAGE: `Started ${u}.` }),
  stopping: (ago: number, u: string, type = 'stop') => unitLine(ago, u, { MESSAGE_ID: MSG.stopping, JOB_TYPE: type, MESSAGE: `Stopping ${u}...` }),
  stopped: (ago: number, u: string, type = 'stop') => unitLine(ago, u, { MESSAGE_ID: MSG.stopped, JOB_TYPE: type, JOB_RESULT: 'done', MESSAGE: `Stopped ${u}.` }),
  exit: (ago: number, u: string, code: string, status: number) =>
    unitLine(ago, u, { MESSAGE_ID: MSG.exit, EXIT_CODE: code, EXIT_STATUS: String(status), MESSAGE: `${u}: Main process exited, code=${code}, status=${status}` }),
  result: (ago: number, u: string, r: string) => unitLine(ago, u, { MESSAGE_ID: MSG.result, UNIT_RESULT: r, MESSAGE: `${u}: Failed with result '${r}'.` }),
  success: (ago: number, u: string) => unitLine(ago, u, { MESSAGE_ID: MSG.success, MESSAGE: `${u}: Deactivated successfully.` }),
  sched: (ago: number, u: string, n: number) => unitLine(ago, u, { MESSAGE_ID: MSG.restartScheduled, N_RESTARTS: String(n), MESSAGE: `${u}: Scheduled restart job, restart counter is at ${n}.` }),
  failed: (ago: number, u: string) => unitLine(ago, u, { MESSAGE_ID: MSG.failed, JOB_TYPE: 'start', JOB_RESULT: 'failed', MESSAGE: `Failed to start ${u}.` }),
  consumed: (ago: number, u: string) => unitLine(ago, u, { MESSAGE_ID: MSG.resources, MESSAGE: `${u}: Consumed 1s CPU time.` }),
};
const authLine = (ago: number, ident: string, pid: number, message: string) => A.push(JSON.stringify({ ...base(ago), SYSLOG_IDENTIFIER: ident, _PID: String(pid), MESSAGE: message }));
const sudo = (ago: number, user: string, tty: string | null, command: string, pid = 7000 + A.length) => {
  authLine(ago, 'sudo', pid, `${user.padStart(8)} : ${tty ? `TTY=${tty} ; ` : ''}PWD=/home/${user} ; USER=root ; COMMAND=${command}`);
  authLine(ago - 0.001, 'sudo', pid, `pam_unix(sudo:session): session opened for user root(uid=0) by ${user}(uid=1002)`);
  return pid;
};

// what the whole command prints: btime, boot id, clock, systemctl show, then the journal part
let ACTIVE: Record<string, string> = { 'artemis.service': 'active', 'keycloak.service': 'active' };
let INACTIVE_AGO: Record<string, number> = {}; // systemctl show's InactiveEnterTimestampMonotonic, as seconds ago
let CAN = 1;
function output(): string {
  const now = (Date.now() / 1000).toFixed(6);
  const blocks = Object.entries(ACTIVE).map(
    ([id, active]) =>
      `Id=${id}\nLoadState=loaded\nActiveState=${active}\nResult=success\nNRestarts=0\nExecMainCode=0\nExecMainStatus=0\nActiveEnterTimestampMonotonic=1000\nInactiveEnterTimestampMonotonic=${INACTIVE_AGO[id] ? Math.round((BOOT_AGO - INACTIVE_AGO[id]) * 1e6) : 0}`,
  );
  const bootSec = Math.round((T0 - BOOT_AGO * 1000) / 1000);
  const uuid = `${BOOT_ID.slice(0, 8)}-${BOOT_ID.slice(8, 12)}-${BOOT_ID.slice(12, 16)}-${BOOT_ID.slice(16, 20)}-${BOOT_ID.slice(20)}`;
  return [
    `btime ${bootSec}`,
    uuid,
    now,
    blocks.join('\n\n'),
    '',
    `@@CAN ${CAN}`,
    '@@PERSIST 0',
    '@@ME 10.0.0.9',
    `@@OLDEST ${bootSec}`,
    '@@UNITS',
    ...(CAN ? U.filter((l) => !l.includes(MSG.resources)) : []),
    '@@AUTH',
    ...(CAN ? A : []),
    `@@CLOCK ${now}`,
    '@@END',
    '',
  ].join('\n');
}
const ev = (sw: number) => sqlite.prepare('SELECT * FROM service_events WHERE software_id = ? ORDER BY at, id').all(sw) as any[];
const lastOf = (sw: number) => ev(sw).at(-1);
const near = (at: string, ago: number, slack = 1.5) => Math.abs(new Date(at).getTime() - (T0 - ago * 1000)) <= slack * 1000;
const read = () => recordHistory(server, output());

try {
  // ---- helpers
  check('systemctl commands: path, options and the unit without ".service"', JSON.stringify(systemctlAction('/usr/bin/systemctl --no-pager restart artemis wildfly.service')) === JSON.stringify({ verb: 'restart', units: ['artemis.service', 'wildfly.service'] }));
  check('...`service artemis stop` and `enable --now`', systemctlAction('/sbin/service artemis stop')?.verb === 'stop' && systemctlAction('/bin/systemctl enable --now artemis')?.verb === 'enable-now');
  check('a message that isn\'t valid UTF-8 comes as bytes: still read', parseJournal('{"__REALTIME_TIMESTAMP":"1","MESSAGE":[72,105]}')[0]?.message === 'Hi');

  // ---- read 1: boot, a crash loop, a Healthcheck Stop All, and sam starting Artemis by hand during a Check status
  L.started(4990, 'artemis.service');
  L.started(4990, 'keycloak.service');
  for (let k = 0; k < 5; k++) {
    const t = 4980 - k * 15;
    L.exit(t, 'keycloak.service', 'exited', 1);
    L.result(t - 0.01, 'keycloak.service', 'exit-code');
    L.consumed(t - 0.02, 'keycloak.service');
    L.sched(t - 0.1, 'keycloak.service', k + 1);
    L.stopped(t - 0.1, 'keycloak.service', 'restart');
    L.started(t - 0.2, 'keycloak.service');
  }
  run('stop_all', 'temp', 4892, 3990, [
    [2, 'stop'],
    [1, 'stop'],
  ]);
  sudo(4890.1, 'svc_user', null, '/bin/systemctl stop keycloak.service');
  L.stopping(4890, 'keycloak.service');
  L.success(4889.9, 'keycloak.service');
  L.stopped(4889.9, 'keycloak.service');
  sudo(4000.5, 'svc_user', null, '/bin/systemctl stop artemis.service');
  L.stopping(4000.3, 'artemis.service');
  L.exit(3999.5, 'artemis.service', 'exited', 143);
  L.result(3999.49, 'artemis.service', 'exit-code');
  L.stopped(3999.48, 'artemis.service');
  run('scan', 'temp', 3505, 3495);
  sudo(3500.05, 'sam', 'pts/0', '/bin/systemctl start artemis.service');
  L.started(3500, 'artemis.service');
  ACTIVE = { 'artemis.service': 'active', 'keycloak.service': 'inactive' };
  read();

  let a = ev(1);
  check('started when the server booted: "boot"', a[0]?.kind === 'started' && a[0].source === 'boot' && near(a[0].at, 4990), a[0]);
  check('Healthcheck Stop All (svc_user, no terminal): "In Healthcheck, by temp (Stop All)"', a[1]?.kind === 'stopped' && a[1].source === 'healthcheck' && a[1].actor === 'temp' && a[1].job_kind === 'stop_all', a[1]);
  check('...Java\'s exit code 143 on the way down: a normal stop, no error', a[1]?.detail === null, a[1]);
  check('started by sam in a terminal during a Check status: sam, not the Check status', a[2]?.source === 'terminal' && a[2].actor === 'sam' && a[2].terminal === 'pts/0' && a[2].command === 'sudo systemctl start artemis.service' && near(a[2].at, 3500), a[2]);
  check('...from the journal (origin "journal")', a.every((e) => e.origin === 'journal'));
  const k = ev(2);
  check('Keycloak: started at boot, then ONE "kept crashing" entry, then stopped by Stop All', k.map((e) => e.kind).join(',') === 'started,crash_loop,stopped', k.map((e) => e.kind));
  check('...counts all 5 crashes, from the first crash to the last restart, with the error', k[1]?.count === 5 && near(k[1].at, 4980) && near(k[1].until_at, 4920.2) && k[1].detail === 'exit code 1' && k[1].source === 'systemd', k[1]);
  check('...the stop is Healthcheck\'s (temp, Stop All)', k[2]?.source === 'healthcheck' && k[2].actor === 'temp', k[2]);

  // a second read with nothing new adds nothing (the same lines come again)
  check('reading the same lines again adds nothing', read() === 0);

  // ---- read 2: sam restarts it; Healthcheck restarts it; someone with a root shell stops it; a start that's
  // still going when the read happens
  sudo(3000.1, 'sam', 'pts/0', '/bin/systemctl restart artemis.service');
  L.stopping(3000, 'artemis.service', 'restart');
  L.exit(2999, 'artemis.service', 'exited', 143);
  L.result(2999, 'artemis.service', 'exit-code');
  L.stopped(2999, 'artemis.service', 'restart');
  L.started(2994, 'artemis.service');
  run('restart_one', 'mona', 2502, 2480, [[1, 'restart']]);
  sudo(2500.1, 'svc_user', null, '/bin/systemctl stop artemis.service');
  L.stopping(2500, 'artemis.service');
  L.stopped(2499, 'artemis.service');
  sudo(2490.1, 'svc_user', null, '/bin/systemctl start artemis.service');
  L.started(2490, 'artemis.service');
  const shell = sudo(2000, 'sam', 'pts/1', '/bin/su -');
  L.stopping(1900, 'artemis.service');
  L.stopped(1899, 'artemis.service');
  sudo(1800.1, 'sam', 'pts/0', '/bin/systemctl start artemis.service');
  L.starting(1800, 'artemis.service');
  read();
  a = ev(1).slice(3);
  check('sam\'s `systemctl restart`: one "Restarted" by sam, with how long it was down', a[0]?.kind === 'restarted' && a[0].actor === 'sam' && a[0].command === 'sudo systemctl restart artemis.service' && a[0].detail === 'down for 6 s', a[0]);
  check('Healthcheck\'s Restart (a stop, then a start): one "Restarted", by mona (Restart)', a[1]?.kind === 'restarted' && a[1].source === 'healthcheck' && a[1].actor === 'mona' && a[1].job_kind === 'restart_one' && a[1].detail === 'down for 10 s', a[1]);
  check('stopped from a root shell (no sudo line): "outside", with sam\'s open "sudo su -" shown', a[2]?.kind === 'stopped' && a[2].source === 'outside' && /"user":"sam","how":"sudo su -","tty":"pts\/1"/.test(a[2].sessions ?? ''), a[2]);
  check('a start still going at the read: nothing yet', a.length === 3, a.map((e) => e.kind));

  // ---- read 3: the start finishes; the shell closes; settings changes; kills; out of memory; a failed start
  L.started(1795, 'artemis.service');
  authLine(1700, 'sudo', shell, 'pam_unix(sudo:session): session closed for user root');
  L.stopping(1600, 'artemis.service');
  L.stopped(1599, 'artemis.service');
  sudo(1500.2, 'sam', 'pts/0', '/bin/systemctl disable artemis.service');
  sudo(1500.1, 'sam', 'pts/0', '/bin/systemctl enable --now artemis');
  L.started(1499.9, 'artemis.service');
  sudo(1400.5, 'sam', 'pts/0', '/bin/kill -9 4242');
  L.exit(1400, 'artemis.service', 'killed', 9);
  L.result(1400, 'artemis.service', 'signal');
  sudo(1300.1, 'sam', 'pts/0', '/bin/systemctl start artemis.service');
  L.started(1300, 'artemis.service');
  L.exit(1200, 'artemis.service', 'killed', 9);
  L.result(1200, 'artemis.service', 'oom-kill');
  sudo(1100.1, 'sam', 'pts/0', '/bin/systemctl start artemis.service');
  L.starting(1100, 'artemis.service');
  L.exit(1095, 'artemis.service', 'exited', 1);
  L.result(1095, 'artemis.service', 'exit-code');
  L.failed(1095, 'artemis.service');
  authLine(1000.1, 'sudo', 9999, '     sam : 3 incorrect password attempts ; TTY=pts/0 ; PWD=/home/sam ; USER=root ; COMMAND=/bin/systemctl start artemis.service');
  L.started(1000, 'artemis.service');
  read();
  a = ev(1).slice(6);
  const kinds = a.map((e) => `${e.kind}:${e.source}`);
  check('the start that was going finishes: "Started" by sam (who came from the earlier read)', a[0]?.kind === 'started' && a[0].actor === 'sam' && near(a[0].at, 1795), a[0]);
  check('stopped with no sudo after the root shell closed: "outside", no shells listed', a[1]?.kind === 'stopped' && a[1].source === 'outside' && a[1].sessions === null, a[1]);
  check('`systemctl disable` and `enable --now`: "disabled", "enabled", then "Started" by sam', kinds.slice(2, 5).join(' ') === 'disabled:terminal enabled:terminal started:terminal' && a[4].command === 'sudo systemctl enable --now artemis', kinds);
  check('`sudo kill -9` just before it died: "Stopped with an error" (killed by SIGKILL), probably by sam', a[5]?.kind === 'crashed' && a[5].detail === 'killed by SIGKILL' && a[5].actor === 'sam' && a[5].probable === 1, a[5]);
  check('killed for lack of memory: says so, nobody asked', a[7]?.kind === 'crashed' && /ran out of memory/.test(a[7].detail) && a[7].source === 'itself', a[7]);
  check('a start that fails: "Failed to start" (exit code 1), by sam', a[8]?.kind === 'start_failed' && a[8].detail === 'exit code 1' && a[8].actor === 'sam', a[8]);
  check('a refused sudo (wrong password) never counts as who did it', a[9]?.kind === 'started' && a[9].source === 'outside', a[9]);

  // ---- read 4: the server restarted; its journal didn't survive (only the new boot's lines)
  const before = ev(1).length;
  U.length = 0;
  A.length = 0;
  BOOT_ID = '0c3b35efee6f4bf2be279fda8862ec4f';
  BOOT_AGO = 500;
  L.started(495, 'artemis.service');
  read();
  a = ev(1).slice(before);
  check('after a restart: "Stopped" (the server restarted) for what was running, then "Started" at boot', a.map((e) => `${e.kind}:${e.source}`).join(' ') === 'stopped:reboot started:boot' && near(a[0].at, 500), a);
  check('...Keycloak, already stopped, gets no "stopped by the restart"', !ev(2).some((e) => e.source === 'reboot'));

  // ---- read 5: the journal can't be read any more: systemd's timestamps take over
  CAN = 0;
  ACTIVE = { 'artemis.service': 'inactive', 'keycloak.service': 'inactive' };
  INACTIVE_AGO = { 'artemis.service': 200 };
  read();
  check('journal unreadable: the server switches to "snapshot"', (sqlite.prepare('SELECT mode FROM history_state').get() as any).mode === 'snapshot');
  check('...and changes come from the timestamps (Artemis stopped 200 s ago, origin "snapshot")', lastOf(1).origin === 'snapshot' && lastOf(1).kind === 'stopped' && near(lastOf(1).at, 200), lastOf(1));
  ACTIVE = { 'artemis.service': 'active', 'keycloak.service': 'inactive' };

  // ---- read 6: readable again: a fresh journal read, nothing doubled
  CAN = 1;
  sudo(100.1, 'sam', 'pts/0', '/bin/systemctl stop artemis.service');
  L.stopping(100, 'artemis.service');
  L.stopped(99, 'artemis.service');
  read();
  a = ev(1);
  check('readable again: back to "journal", the boot start not doubled, sam\'s stop recorded', (sqlite.prepare('SELECT mode FROM history_state').get() as any).mode === 'journal' && a.filter((e) => e.source === 'boot' && near(e.at, 495)).length === 1 && lastOf(1).actor === 'sam', a.slice(-3));
  check('...and no entries from the timestamps left where the journal covers', !a.some((e) => e.origin === 'snapshot' && new Date(e.at).getTime() >= T0 - 500_000), a.filter((e) => e.origin === 'snapshot'));

  // ---- the API the history window reads
  sqlite
    .prepare("INSERT INTO users (username, display_name, password_hash, is_admin, permissions, password_changed_at, created_at) VALUES ('viewer', 'V', ?, 0, '[]', ?, ?)")
    .run(await hashPassword('long enough pass phrase'), iso(0), iso(0));
  const app = createApp().listen(4192, '127.0.0.1');
  const login = await fetch('http://127.0.0.1:4192/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Healthcheck': '1' }, body: JSON.stringify({ username: 'viewer', password: 'long enough pass phrase' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const body = await (await fetch('http://127.0.0.1:4192/api/servers/1/software/1/history', { headers: { Cookie: cookie } })).json();
  check('API: how it\'s read (journal), that the journal is cleared on restart, the account Healthcheck uses', body.mode === 'journal' && body.journal_kept === false && body.ssh_user === 'svc_user', { mode: body.mode, kept: body.journal_kept, user: body.ssh_user });
  const withShell = body.events.find((e: any) => e.sessions);
  check('...root shells come as a list, "probably" as true/false, the command as text', Array.isArray(withShell?.sessions) && withShell.sessions[0].user === 'sam' && body.events.some((e: any) => e.probable === true) && body.events.some((e: any) => e.command === 'sudo systemctl restart artemis.service'));
  const kc = (await (await fetch('http://127.0.0.1:4192/api/servers/1/software/2/history', { headers: { Cookie: cookie } })).json()).events.find((e: any) => e.kind === 'crash_loop');
  check('...a "kept crashing" entry with its count and end', kc?.count === 5 && !!kc.until_at, kc);
  await new Promise((r) => app.close(r));
} finally {
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
