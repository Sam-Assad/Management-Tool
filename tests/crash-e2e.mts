// Crash alerts, isolated: a throwaway database, journal lines like the real server's, the real reading / alert
// code, the reason finder on real-looking logs, and the API. No SSH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-crash-test-'));
Object.assign(process.env, { HEALTHCHECK_DATA_DIR: dataDir, SERVICE_HISTORY_DAYS: '20', CRASH_ALERT_COUNT: '3', CRASH_START_ALERT_COUNT: '5', CRASH_RUNNING_FINE_MINUTES: '20', CRASH_LOOP_MINUTES: '60' });
const { sqlite } = await import('../server/src/db/client.ts');
const { recordHistory } = await import('../server/src/scan/history.ts');
const { MSG } = await import('../server/src/scan/journal.ts');
const { evaluateCrashes, lastErrorBlock, plainReason, parseFacts, conflictPorts, portsReasonWithHolders } = await import('../server/src/scan/crashAlerts.ts');
const { createApp } = await import('../server/src/app.ts');
const { hashPassword } = await import('../server/src/auth/passwords.ts');

let fails = 0;
const check = (label: string, ok: boolean, info?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && info !== undefined ? `   got: ${JSON.stringify(info)}` : ''}`);
};

const T0 = Date.now();
const iso = (agoS: number) => new Date(T0 - agoS * 1000).toISOString();
sqlite.prepare("INSERT INTO groups (id, name, created_at) VALUES (1, 'g', ?)").run(iso(0));
sqlite.prepare("INSERT INTO servers (id, group_id, name, host, ssh_username, ssh_key_path, created_at) VALUES (1, 1, 'loyalty_t', '10.0.0.1', 'svc_user', '/k', ?)").run(iso(0));
// voucher: started from a terminal, then keeps crashing; hc: started by a Healthcheck run, then keeps crashing
const UNITS = ['artemis.service', 'keycloak.service', 'wildfly.service', 'backend.service', 'voucher.service', 'hc.service'];
UNITS.forEach((u, i) => {
  sqlite
    .prepare("INSERT INTO software_definitions (id, name, kind, detect_method, detect_value, start_cmd, stop_cmd, created_at) VALUES (?, ?, 'service', 'systemd', ?, '', '', ?)")
    .run(i + 1, u.replace('.service', ''), u, iso(0));
  sqlite.prepare('INSERT INTO group_software (group_id, software_id, sequence_order) VALUES (1, ?, ?)').run(i + 1, i + 1);
});
const server = sqlite.prepare('SELECT * FROM servers WHERE id = 1').get() as any;

const BOOT_ID = 'afe24cac65e84a15b592bc5e3431bb87';
const BOOT_AGO = 30000;
const U: string[] = [];
const A: string[] = [];
const base = (ago: number) => ({ __REALTIME_TIMESTAMP: String(Math.round((T0 - ago * 1000) * 1000)), __MONOTONIC_TIMESTAMP: String(Math.round((BOOT_AGO - ago) * 1e6)), _BOOT_ID: BOOT_ID });
const line = (ago: number, unit: string, f: Record<string, string>) => U.push(JSON.stringify({ ...base(ago), _PID: '1', SYSLOG_IDENTIFIER: 'systemd', UNIT: unit, ...f }));
const started = (ago: number, u: string) => line(ago, u, { MESSAGE_ID: MSG.started, JOB_TYPE: 'start', JOB_RESULT: 'done', MESSAGE: `Started ${u}.` });
// a crash and systemd's automatic restart 0.2 s later
const crash = (ago: number, u: string, n: number, restart = true) => {
  line(ago, u, { MESSAGE_ID: MSG.exit, EXIT_CODE: 'exited', EXIT_STATUS: '1', MESSAGE: `${u}: Main process exited, code=exited, status=1/FAILURE` });
  line(ago - 0.01, u, { MESSAGE_ID: MSG.result, UNIT_RESULT: 'exit-code', MESSAGE: `${u}: Failed with result 'exit-code'.` });
  line(ago - 0.1, u, { MESSAGE_ID: MSG.restartScheduled, N_RESTARTS: String(n), MESSAGE: `${u}: Scheduled restart job, restart counter is at ${n}.` });
  line(ago - 0.1, u, { MESSAGE_ID: MSG.stopped, JOB_TYPE: 'restart', JOB_RESULT: 'done', MESSAGE: `Stopped ${u}.` });
  if (restart) started(ago - 0.2, u);
};
const sudo = (ago: number, user: string, tty: string | null, command: string) =>
  A.push(JSON.stringify({ ...base(ago), SYSLOG_IDENTIFIER: 'sudo', _PID: String(7000 + A.length), MESSAGE: `${user} : ${tty ? `TTY=${tty} ; ` : ''}PWD=/home/${user} ; USER=root ; COMMAND=${command}` }));

let ACTIVE: Record<string, string> = Object.fromEntries(UNITS.map((u) => [u, 'active']));
function output(): string {
  const now = (Date.now() / 1000).toFixed(6);
  const blocks = Object.entries(ACTIVE).map(([id, active]) => `Id=${id}\nLoadState=loaded\nActiveState=${active}\nResult=success\nNRestarts=0\nExecMainCode=0\nExecMainStatus=0\nActiveEnterTimestampMonotonic=1000\nInactiveEnterTimestampMonotonic=0`);
  const bootSec = Math.round((T0 - BOOT_AGO * 1000) / 1000);
  const uuid = `${BOOT_ID.slice(0, 8)}-${BOOT_ID.slice(8, 12)}-${BOOT_ID.slice(12, 16)}-${BOOT_ID.slice(16, 20)}-${BOOT_ID.slice(20)}`;
  return [`btime ${bootSec}`, uuid, now, blocks.join('\n\n'), '', '@@CAN 1', '@@PERSIST 1', '@@ME 10.0.0.9', '@@UNITS', ...U, '@@AUTH', ...A, `@@CLOCK ${now}`, '@@END', ''].join('\n');
}
const read = () => {
  recordHistory(server, output());
  return evaluateCrashes(1);
};
const alerts = () => sqlite.prepare('SELECT * FROM crash_alerts ORDER BY id').all() as any[];
const alertOf = (sw: number) => alerts().filter((a) => a.software_id === sw);
const near = (at: string, ago: number, slack = 2) => Math.abs(new Date(at).getTime() - (T0 - ago * 1000)) <= slack * 1000;

try {
  // ---- read 1
  for (const u of UNITS.slice(0, 4)) started(29990, u);
  // keycloak: crashed 5 times right after the server started, 8 hours ago, and has run fine since: no alert
  for (let k = 0; k < 5; k++) crash(29950 - k * 15, 'keycloak.service', k + 1);
  // wildfly: sam restarts it from a terminal, and it crashes 3 times right after (fewer than 5): no alert
  sudo(3000.1, 'sam', 'pts/0', '/bin/systemctl restart wildfly.service');
  line(3000, 'wildfly.service', { MESSAGE_ID: MSG.stopping, JOB_TYPE: 'restart', MESSAGE: 'Stopping wildfly...' });
  line(2999, 'wildfly.service', { MESSAGE_ID: MSG.stopped, JOB_TYPE: 'restart', JOB_RESULT: 'done', MESSAGE: 'Stopped wildfly.' });
  started(2995, 'wildfly.service');
  for (let k = 0; k < 3; k++) crash(2980 - k * 15, 'wildfly.service', k + 1);
  // backend: running fine since boot, crashes twice (fewer than 3): no alert yet
  crash(900, 'backend.service', 1);
  crash(885, 'backend.service', 2);
  // artemis: running fine for 8 hours, then crashes 3 times (case 3): the alert
  crash(600, 'artemis.service', 1);
  crash(585, 'artemis.service', 2);
  crash(570, 'artemis.service', 3);
  // voucher: sam starts it from a terminal, it crashes 10 s later, 5 times in a row, and is still at it: the alert
  sudo(400.1, 'sam', 'pts/0', '/bin/systemctl start voucher.service');
  started(400, 'voucher.service');
  for (let k = 0; k < 5; k++) crash(390 - k * 15, 'voucher.service', k + 1);
  // hc: a Healthcheck run starts it, and it crashes 6 times: no alert (the run deals with it itself)
  sqlite.prepare("INSERT INTO job_runs (id, group_id, kind, status, started_by, started_at) VALUES (50, 1, 'start_one', 'failed', 'sam', ?)").run(iso(402));
  sqlite.prepare("INSERT INTO job_steps (job_run_id, server_id, software_id, action, status, started_at, finished_at) VALUES (50, 1, 6, 'start', 'failed', ?, ?)").run(iso(401), iso(300));
  started(400, 'hc.service');
  for (let k = 0; k < 6; k++) crash(390 - k * 15, 'hc.service', k + 1);
  let open = read();
  const art = alertOf(1);
  check('a service running fine for hours that crashes 3 times: one alert, "crashing"', art.length === 1 && art[0].state === 'crashing', art);
  check('...with the count, the first and last crash, how long it had run (about 8 hours)', art[0]?.count === 3 && near(art[0].first_crash_at, 600) && near(art[0].last_crash_at, 569.8) && Math.abs(art[0].ran_for_s - (29990 - 600)) <= 2, art[0]);
  check('...and how it ends (exit code 1)', art[0]?.detail === 'exit code 1', art[0]?.detail);
  check('crashed 5 times right after the server started, but running fine for hours since: no alert (keycloak)', alertOf(2).length === 0, alertOf(2));
  check('crashed 3 times right after a start from a terminal (fewer than 5): no alert (wildfly)', alertOf(3).length === 0, alertOf(3));
  const vo = alertOf(5);
  check('started from a terminal and crashing 5 times since, 10 s after the start: the alert', vo.length === 1 && vo[0].state === 'crashing' && vo[0].count === 5 && vo[0].ran_for_s === 10, vo);
  check('...saying who started it (sam, from a terminal)', vo[0]?.started_source === 'terminal' && vo[0].started_actor === 'sam', vo[0]);
  check('started by a Healthcheck run and crashing 6 times: no alert', alertOf(6).length === 0, alertOf(6));
  check('...open: artemis and voucher', open.length === 2, open);
  check('only 2 crashes: no alert yet (backend)', alertOf(4).length === 0, alertOf(4));
  const kc = sqlite.prepare("SELECT ran_for_s, count FROM service_events WHERE software_id = 2 AND kind = 'crash_loop'").get() as any;
  check('...the history still shows keycloak\'s crashes ("Kept crashing" 5 times, after 40 s running)', kc?.count === 5 && kc.ran_for_s === 40, kc);

  // ---- read 2: artemis crashes more, then systemd gives up; backend crashes a 3rd time within the hour
  crash(300, 'artemis.service', 4);
  crash(285, 'artemis.service', 5);
  crash(270, 'artemis.service', 6, false);
  line(269.8, 'artemis.service', { MESSAGE_ID: MSG.result, UNIT_RESULT: 'start-limit-hit', MESSAGE: "artemis.service: Failed with result 'start-limit-hit'." });
  line(269.8, 'artemis.service', { MESSAGE_ID: MSG.failed, JOB_TYPE: 'start', JOB_RESULT: 'failed', MESSAGE: 'Failed to start artemis.' });
  crash(280, 'backend.service', 3);
  ACTIVE = { ...ACTIVE, 'artemis.service': 'failed' };
  open = read();
  const art2 = alertOf(1);
  check('more crashes: the same alert, count updated (6)', art2.length === 1 && art2[0].id === art[0].id && art2[0].count === 6, art2);
  check('systemd gave up restarting it: the alert says "gave_up" (down, needs a person)', art2[0]?.state === 'gave_up', art2[0]?.state);
  const be = alertOf(4);
  check('a 3rd crash 10 minutes later (within the hour): backend\'s alert, 3 times, after running ~8 hours', be.length === 1 && be[0].state === 'crashing' && be[0].count === 3 && be[0].ran_for_s > 20 * 60, be);
  check('...three are open (artemis, backend, voucher)', open.length === 3, open);

  // ---- the API the popup and the server page read
  sqlite
    .prepare("INSERT INTO users (username, display_name, password_hash, is_admin, permissions, password_changed_at, created_at) VALUES ('viewer', 'V', ?, 0, '[]', ?, ?)")
    .run(await hashPassword('long enough pass phrase'), iso(0), iso(0));
  const app = createApp().listen(4194, '127.0.0.1');
  const login = await fetch('http://127.0.0.1:4194/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Healthcheck': '1' }, body: JSON.stringify({ username: 'viewer', password: 'long enough pass phrase' }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const getAlerts = async () => (await (await fetch('http://127.0.0.1:4194/api/alerts', { headers: { Cookie: cookie } })).json()) as any;
  let body = await getAlerts();
  const crashes = body.alerts.filter((a: any) => a.kind === 'crash');
  check('API: the three crash alerts, with service and server names, count and state', crashes.length === 3 && crashes.some((a: any) => a.software_name === 'artemis' && a.state === 'gave_up' && a.crash.count === 6) && crashes.every((a: any) => a.server_name === 'loyalty_t'), crashes.map((a: any) => [a.software_name, a.state, a.crash?.count]));
  check('...and how often crashes are looked for (every hour)', body.crash_check_minutes === 60, body.crash_check_minutes);
  const voA = crashes.find((a: any) => a.software_name === 'voucher');
  check('...voucher: crashing right after a start, started by sam from a terminal', voA?.crash.after_start === true && voA.crash.started_source === 'terminal' && voA.crash.started_actor === 'sam', voA?.crash);
  check('...artemis: after running fine (not right after a start)', crashes.find((a: any) => a.software_name === 'artemis')?.crash.after_start === false);

  // ---- the popup's Stop
  const stopUrl = (sw: number) => `http://127.0.0.1:4194/api/servers/1/software/${sw}/stop-crashing`;
  const postAs = (c: string, url: string) => fetch(url, { method: 'POST', headers: { Cookie: c, 'X-Healthcheck': '1' } });
  check('Stop needs the "Stop a service" permission (a viewer: 403)', (await postAs(cookie, stopUrl(5))).status === 403);
  sqlite
    .prepare("INSERT INTO users (username, display_name, password_hash, is_admin, permissions, password_changed_at, created_at) VALUES ('ops', 'O', ?, 0, ?, ?, ?)")
    .run(await hashPassword('long enough pass phrase'), JSON.stringify(['stop_one']), iso(0), iso(0));
  const opsLogin = await fetch('http://127.0.0.1:4194/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Healthcheck': '1' }, body: JSON.stringify({ username: 'ops', password: 'long enough pass phrase' }) });
  const ops = opsLogin.headers.get('set-cookie')!.split(';')[0];
  let res = await postAs(ops, stopUrl(4 + 2)); // hc: no alert
  check('...a service that isn\'t crashing (no open alert): refused, saying why', res.status === 409 && /isn't crashing any more/.test(((await res.json()) as any).error), res.status);
  // the stop's SSH fails here (no key, nothing listening): the job is what counts
  sqlite.prepare("UPDATE servers SET host = '127.0.0.1', port = 1").run();
  res = await postAs(ops, stopUrl(5));
  const jobId = res.status === 202 ? (((await res.json()) as any).jobId as number) : null;
  const voRow = alertOf(5)[0];
  check('...voucher: a Stop run (stop_one), remembered on the alert with who', res.status === 202 && voRow.stop_job_id === jobId && voRow.stopped_by === 'ops', [res.status, voRow]);
  check('...by ops', (sqlite.prepare('SELECT kind, started_by FROM job_runs WHERE id = ?').get(jobId) as any)?.started_by === 'ops');
  // the history then shows that run's stop (Healthcheck's account, no terminal)
  sqlite.prepare("INSERT INTO job_steps (job_run_id, server_id, software_id, action, status, started_at, finished_at) VALUES (?, 1, 5, 'stop', 'ok', ?, ?)").run(jobId, iso(201), iso(190));
  sudo(200.1, 'svc_user', null, '/bin/systemctl stop voucher.service');
  line(200, 'voucher.service', { MESSAGE_ID: MSG.stopping, JOB_TYPE: 'stop', MESSAGE: 'Stopping voucher...' });
  line(199.5, 'voucher.service', { MESSAGE_ID: MSG.stopped, JOB_TYPE: 'stop', JOB_RESULT: 'done', MESSAGE: 'Stopped voucher.' });
  ACTIVE = { ...ACTIVE, 'voucher.service': 'inactive' };
  open = read();
  check('after the stop: the alert is "stopped", no longer open (no popup)', alertOf(5)[0]?.state === 'stopped' && !open.includes(voRow.id), alertOf(5)[0]);
  body = await getAlerts();
  check('API: not in the popup\'s alerts, but in crash_stopped (for the server page), with who', !body.alerts.some((a: any) => a.software_name === 'voucher') && body.crash_stopped.length === 1 && body.crash_stopped[0].crash.stopped_by === 'ops' && !!body.crash_stopped[0].crash.stopped_at, body.crash_stopped);

  // ---- read 3: sam starts artemis again from a terminal: that alert is over
  sudo(100.1, 'sam', 'pts/0', '/bin/systemctl start artemis.service');
  started(100, 'artemis.service');
  ACTIVE = { ...ACTIVE, 'artemis.service': 'active' };
  // ...and voucher, stopped from the popup, after fixing it
  sudo(95.1, 'sam', 'pts/0', '/bin/systemctl start voucher.service');
  started(95, 'voucher.service');
  ACTIVE = { ...ACTIVE, 'voucher.service': 'active' };
  read();
  check('someone starts it again: the alert is over, saying who', alertOf(1)[0]?.state === 'over' && alertOf(1)[0].ended_how === 'started by sam in a terminal', alertOf(1)[0]);
  check('stopped from the popup, then started again: over (no more "stopped because it kept crashing")', alertOf(5)[0]?.state === 'over' && alertOf(5)[0].ended_how === 'started by sam in a terminal', alertOf(5)[0]);
  // half an hour later backend has been running fine since its last restart (280 s ago + 30 min): over
  evaluateCrashes(1, T0 + 30 * 60_000);
  check('running fine again for 20 minutes: the alert is over by itself', alertOf(4)[0]?.state === 'over' && alertOf(4)[0].ended_how === 'running fine again', alertOf(4)[0]);
  body = await getAlerts();
  check('API: no crash alerts left', !body.alerts.some((a: any) => a.kind === 'crash') && body.crash_stopped.length === 0, [body.alerts.length, body.crash_stopped.length]);
  await new Promise((r) => app.close(r));

  // ---- why: the error from the log, in plain words
  const springLog = [
    '2026-10-11 03:12:01.100  INFO 4242 --- [main] c.v.l.LoyaltyApplication : Starting LoyaltyApplication',
    '2026-10-11 03:12:09.300 ERROR 4242 --- [main] o.s.b.SpringApplication : Application run failed',
    'org.springframework.beans.factory.BeanCreationException: Error creating bean with name dataSource',
    '\tat org.springframework.beans.factory.support.A.a(A.java:1)',
    '\tat org.springframework.beans.factory.support.B.b(B.java:2)',
    '\tat org.springframework.beans.factory.support.C.c(C.java:3)',
    '\tat org.springframework.beans.factory.support.D.d(D.java:4)',
    'Caused by: java.sql.SQLException: ORA-28001: the password has expired',
    '\tat oracle.jdbc.driver.T4CTTIoer11.processError(T4CTTIoer11.java:509)',
    '\t... 42 more',
    '',
  ].join('\n');
  const block = lastErrorBlock(springLog)!;
  check('the error block starts at the ERROR line and keeps the "Caused by"', block.startsWith('2026-10-11 03:12:09.300 ERROR') && block.includes('Caused by: java.sql.SQLException: ORA-28001'), block);
  check('...the stack trace is cut down (2 frames, then "...")', !block.includes('D.d(D.java:4)') && block.includes('\t...') && !block.includes('42 more'), block);
  check('...older INFO lines left out', !block.includes('Starting LoyaltyApplication'));
  const none = { disks: [], memory: null, oom: [] };
  check('reason: an expired database password', plainReason(block, 'exit code 1', none) === 'The database password has expired.');
  const portLog = 'x ERROR o.s.b.d.LoggingFailureAnalysisReporter :\n\n***************************\nAPPLICATION FAILED TO START\n***************************\n\nDescription:\n\nWeb server failed to start. Port 8085 was already in use.\n';
  const pb = lastErrorBlock(portLog)!;
  check('reason: the port in use, with its number (Spring Boot\'s "APPLICATION FAILED TO START" block)', pb.includes('Port 8085 was already in use') && plainReason(pb, 'exit code 1', none) === 'Its port 8085 is already used by another program.', [pb, plainReason(pb, 'exit code 1', none)]);
  // loyalty_1's Keycloak: two ports, one of them held by WSO2 Streaming Integrator
  const kcLog = '2026-10-21 16:37:25,394 ERROR [org.keycloak.quarkus.runtime.cli.ExecutionExceptionHandler] (main) ERROR: io.quarkus.runtime.QuarkusBindException: Port(s) already bound: 9663, 7443: Address already in use';
  check('reason: several ports in use, all named', plainReason(kcLog, 'exit code 1', none) === 'Its ports 9663 and 7443 are already used by another program.', plainReason(kcLog, 'exit code 1', none));
  const holders = [{ port: 7443, pid: 2043, process: 'java', user: 'svc_user', unit: 'wso2si.service', startedByHand: false, freeable: true }];
  check(
    '...and by what (the catalog name of the service holding it)',
    portsReasonWithHolders(conflictPorts(kcLog), holders, 'keycloak.service', (u) => (u === 'wso2si.service' ? 'WSO2 Streaming Integrator' : null)) ===
      'Its ports 9663 and 7443 are already used by another program: 7443 by WSO2 Streaming Integrator (wso2si.service).',
    portsReasonWithHolders(conflictPorts(kcLog), holders, 'keycloak.service', () => 'WSO2 Streaming Integrator'),
  );
  check('...an older copy of itself', /7443 by an older copy of itself/.test(portsReasonWithHolders([7443], [{ ...holders[0], unit: 'keycloak.service' }], 'keycloak.service', () => null)));
  // loyalty_1's voucher-management: its settings file was renamed
  const cfgLog = "***************************\nAPPLICATION FAILED TO START\n***************************\n\nDescription:\n\nConfig data resource 'file [/Data/system-modules/voucher-management/conf/application.properties]' via location '/Data/system-modules/voucher-management/conf/application.properties' does not exist\n";
  check('reason: a missing settings file, named', plainReason(lastErrorBlock(cfgLog), 'exit code 1', none) === 'A file it needs is missing: /Data/system-modules/voucher-management/conf/application.properties', plainReason(lastErrorBlock(cfgLog), 'exit code 1', none));
  check('...Java\'s FileNotFoundException, named', plainReason('ERROR x\njava.io.FileNotFoundException: /Data/keys/app.jks (No such file or directory)', 'exit code 1', none) === 'A file it needs is missing: /Data/keys/app.jks');
  check('reason: the server killed it for memory (kernel line)', plainReason(null, 'killed by SIGKILL', { ...none, oom: ['Out of memory: Killed process 4242 (java)'] }) === 'It runs out of memory, and the server kills it.');
  check('reason: a full disk', plainReason('ERROR could not write', 'exit code 1', { ...none, disks: [{ mount: '/Data', sizeKb: 100, availKb: 1, usedPct: 99 }] }) === 'The disk is full (/Data).');
  check('reason: the database can\'t be reached', /can't connect to something it needs/.test(plainReason('ERROR x\nCaused by: java.net.ConnectException: Connection refused', 'exit code 1', none)));
  check('reason: nothing recognised, no error in its log', plainReason(null, 'exit code 1', none) === 'It ends with exit code 1. Its log shows no error lines.');
  const facts = parseFacts(
    [
      '@@DF',
      'Filesystem     1024-blocks     Used Available Capacity Mounted on',
      '/dev/mapper/rl-root 52403200 20961280 31441920      40% /',
      '/dev/mapper/data   209612800 203324416  6288384      97% /Data',
      '/dev/mapper/rl-root 52403200 20961280 31441920      40% /',
      '@@MEM',
      'MemTotal:       32617232 kB',
      'MemAvailable:    1258291 kB',
      '@@OOM',
      '@@END',
    ].join('\n'),
  );
  check('disk and memory read (each disk once)', facts.disks.length === 2 && facts.disks[1].mount === '/Data' && facts.disks[1].usedPct === 97 && facts.memory?.availableKb === 1258291 && facts.oom.length === 0, facts);
} finally {
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
