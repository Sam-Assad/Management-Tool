// Clear DLQ, isolated: how the broker's answer to `artemis queue purge` is read, and the API (admins only, a server
// with Artemis, one run at a time, a run recorded with who). A throwaway database; the only "server" is a closed
// port on this machine, so nothing is purged anywhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enroll } from './totp-helper.mts';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-dlq-test-'));
Object.assign(process.env, { HEALTHCHECK_DATA_DIR: dataDir, ARTEMIS_USER: 'loyalty_management', ARTEMIS_PASSWORD: 'pw-test' });
const { sqlite } = await import('../server/src/db/client.ts');
const { createApp } = await import('../server/src/app.ts');
const { hashPassword } = await import('../server/src/auth/passwords.ts');
const { purgeOutcome } = await import('../server/src/scan/artemis.ts');

let fails = 0;
const check = (label: string, ok: boolean, info?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && info !== undefined ? `   got: ${JSON.stringify(info)}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const app = createApp().listen(4198, '127.0.0.1');
const API = 'http://127.0.0.1:4198/api';
class Browser {
  cookie = '';
  async call(method: string, p: string, body?: unknown) {
    const res = await fetch(API + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Healthcheck': '1', ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    let json: any = null;
    try {
      json = JSON.parse(await res.text());
    } catch {}
    return { status: res.status, json };
  }
}

try {
  // ---- what the broker answered
  check('exit 0, nothing else: cleared', purgeOutcome('exit=0').ok === true);
  check('...with the CLI\'s connection line in front: still cleared', purgeOutcome('Connection brokerURL = tcp://localhost:61616\nexit=0').ok === true);
  const slow = purgeOutcome('exit=124');
  check('timed out (exit 124): says it may still be deleting, and Check now', !slow.ok && /didn't finish within 10 minutes/.test(slow.problem!) && /Check now/.test(slow.problem!), slow);
  const perm = purgeOutcome("Connection brokerURL = tcp://localhost:61616\nAMQ229213: User: loyalty_management does not have permission='MANAGE' on address activemq.management\nexit=1");
  check('no permission: names the account and the "manage" permission', !perm.ok && /loyalty_management isn't allowed to delete messages/.test(perm.problem!) && /"manage" permission/.test(perm.problem!), perm);
  const login = purgeOutcome('AMQ229031: Unable to validate user from /127.0.0.1:51234. Username: loyalty_management; SSL certificate subject DN: unavailable\nexit=1');
  check('login refused: says so', !login.ok && /refused the login of loyalty_management/.test(login.problem!), login);
  check('no DLQ on this broker: says so', purgeOutcome('AMQ229017: Queue DLQ does not exist\nexit=1').problem === 'This broker has no queue called DLQ.');
  check('the CLI missing from the instance folder: says so', /command-line tool \(bin\/artemis\) wasn't found/.test(purgeOutcome('bash: line 6: /x/bin/artemis: No such file or directory\nexit=127').problem ?? ''));
  const odd = purgeOutcome('java.lang.IllegalStateException: something odd\nexit=1');
  check('anything else that failed: the last line, and the full text kept', !odd.ok && /something odd/.test(odd.problem!) && /IllegalStateException/.test(odd.technical), odd);
  check('an error printed with exit 0 still counts as failed', purgeOutcome('ERROR: Could not connect\nexit=0').ok === false);

  // ---- the API
  const now = new Date().toISOString();
  sqlite.prepare("INSERT INTO groups (id, name, created_at) VALUES (1, 'g1', ?)").run(now);
  // a closed port: the run can't reach it, so nothing is purged
  sqlite.prepare("INSERT INTO servers (id, group_id, name, host, port, ssh_username, ssh_key_path, created_at) VALUES (1, 1, 'Worker_t', '127.0.0.1', 1, 'svc_user', '/k', ?)").run(now);
  sqlite.prepare("INSERT INTO software_definitions (id, name, kind, detect_method, detect_value, start_cmd, stop_cmd, created_at) VALUES (1, 'Artemis', 'service', 'systemd', 'artemis.service', '', '', ?)").run(now);

  const boss = new Browser();
  await boss.call('POST', '/auth/setup', { username: 'boss', display_name: 'Boss', password: 'orange kayak at dawn' });
  await enroll(boss);
  sqlite
    .prepare("INSERT INTO users (username, display_name, password_hash, is_admin, permissions, password_changed_at, created_at) VALUES ('ops', 'Ops', ?, 0, ?, ?, ?)")
    .run(
      await hashPassword('long enough pass phrase'),
      JSON.stringify(['start_all', 'restart_all', 'stop_all', 'start_one', 'restart_one', 'stop_one', 'check_status', 'run_checks', 'view_logs']),
      now,
      now,
    );
  const ops = new Browser();
  await ops.call('POST', '/auth/login', { username: 'ops', password: 'long enough pass phrase' });

  let r = await ops.call('POST', '/servers/1/artemis/clear-dlq');
  check('an operator (every run and check permission, not admin): refused (403)', r.status === 403, r);
  r = await boss.call('POST', '/servers/1/artemis/clear-dlq');
  check('admin, on a server without Artemis in its list: refused, saying so', r.status === 409 && /doesn't have Artemis/.test(r.json?.error), r);

  sqlite.prepare('INSERT INTO group_software (group_id, software_id, sequence_order) VALUES (1, 1, 0)').run();
  sqlite.prepare("INSERT INTO job_runs (id, group_id, kind, status, started_at) VALUES (90, 1, 'start_all', 'running', ?)").run(now);
  r = await boss.call('POST', '/servers/1/artemis/clear-dlq');
  check('another run going on that server: refused', r.status === 409 && /already running/.test(r.json?.error), r);
  sqlite.prepare("UPDATE job_runs SET status = 'succeeded' WHERE id = 90").run();

  r = await boss.call('POST', '/servers/1/artemis/clear-dlq');
  const jobId = r.json?.jobId;
  check('admin, with Artemis: a run (202)', r.status === 202 && typeof jobId === 'number', r);
  let job: any;
  for (let i = 0; i < 40; i++) {
    job = (await boss.call('GET', `/jobs/${jobId}`)).json;
    if (job?.status !== 'running') break;
    await sleep(250);
  }
  check('..."clear_dlq", started by boss (for Recent activity)', job?.kind === 'clear_dlq' && job.started_by === 'boss', job && { kind: job.kind, by: job.started_by });
  const step = job?.steps?.[0];
  check('...one step on Artemis', job?.steps?.length === 1 && step.action === 'clear_dlq' && step.software_name === 'Artemis', job?.steps);
  check('...the server can\'t be reached here: the run fails and says why, nothing is cleared', job?.status === 'failed' && step?.status === 'failed' && !!step.log_excerpt, job && { status: job.status, step: step?.status, log: step?.log_excerpt });
} finally {
  app.close();
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
