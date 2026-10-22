// Can a running service do its job (scan/serviceHealth.ts), isolated: what the server's answer means (connections to
// the database / Artemis, a jar's port answering, its log), its database accounts (scan/dbAccounts.ts: read from its
// settings without passwords, a locked / expired one in its log or another service's), how the status is stored and
// read back, the shipped "Needs the database / Artemis" values reaching an existing installation, and the shell command
// itself (its syntax, and run here on sample logs and settings). No SSH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-health-test-'));
Object.assign(process.env, { HEALTHCHECK_DATA_DIR: dataDir, DATABASE_PORT: '1521', ARTEMIS_URL: 'tcp://localhost:61616' });
const { sqlite } = await import('../server/src/db/client.ts');
const { judgeHealth, healthCommand, accountProblemsSeenLater, accountCause } = await import('../server/src/scan/serviceHealth.ts');
const {
  databaseOf,
  accountsFromConfig,
  parseAttributeList,
  wildflyAccounts,
  dbConfigCommand,
  saveAccountErrors,
  saveServiceAccounts,
  accountErrorsSeenElsewhere,
  accountTroubles,
  markAccountsFixed,
  loadFixes,
} = await import('../server/src/scan/dbAccounts.ts');
const { getServerComponentStatus } = await import('../server/src/scan/status.ts');
const { applyBundledDefaults } = await import('../server/src/db/defaults.ts');

let fails = 0;
const check = (label: string, ok: boolean, info?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && info !== undefined ? `   got: ${JSON.stringify(info)}` : ''}`);
};

const jar = (needs: { db?: boolean; mq?: boolean } = {}) =>
  ({ id: 1, name: 'balance-notification', kind: 'jar', log_path: '/Data/logs/x.log', needs_database: needs.db ? 1 : 0, needs_artemis: needs.mq ? 1 : 0 }) as any;
const wildfly = { id: 5, name: 'WildFly (JBoss)', kind: 'service', log_path: '/Data/logs/application-server/server.log', needs_database: 1, needs_artemis: 1 } as any;
// what the command prints on the server
const answer = (o: { who?: [string, string]; conns?: number[]; mqHere?: number; probes?: string[]; log?: string[]; conf?: string[]; now?: string; end?: boolean } = {}) =>
  [
    '@@NOW',
    o.now ?? '2026-10-22 12:20:00',
    '@@WHO',
    ...(o.who ?? ['1000', '1000']),
    '@@LISTEN',
    '*:7088',
    '@@CONN',
    ...(o.conns ?? []).map(String),
    '@@MQHERE',
    String(o.mqHere ?? 1),
    '@@PROBE',
    ...(o.probes ?? ['7088 400 0 000 52']),
    '@@LOG',
    ...(o.log ?? []),
    '@@DBCONF',
    ...(o.conf ?? []),
    ...(o.end === false ? [] : ['@@END']),
  ].join('\n');
// the log lines as the command prints them: "count|time|pool|text"
// balance-notification's log on Worker_1 (12:13:28)
const AMQ_LINE = '1|2026-10-22 12:13:28||Caused by: org.apache.activemq.artemis.api.core.ActiveMQNotConnectedException: AMQ219007: Cannot connect to server(s). Tried with all available servers.';
const ORA_LINE = '3|2026-10-22 12:18:02||ORA-12516, TNS:listener could not find available handler with matching protocol stack';
// WildFly's JSON log on loyalty_1 after LOYALTY_CONF was locked (13:46:04)
const LOCKED_WF = '2|2026-10-22 13:46:04|java:/LOYALTY_CONF|ORA-28000: The account is locked.\\n\\nhttps://docs.oracle.com/error-help/db/ora-28000/"}}}}';
const WF_ACCOUNTS = [
  { user: 'LOYALTY_CONF', db: 'db.lm.example.com:1521/LOYALTY', jndi: 'java:/LOYALTY_CONF' },
  { user: 'STREAK', db: 'db.lm.example.com:1521/LOYALTY', jndi: 'java:/STREAK' },
];
const LOYALTY_BACKEND_CONF = [
  '#FILE /Data/system-modules/admin/backend/loyalty/conf/application.properties',
  'loyalty.conf.datasource.url=jdbc:oracle:thin:@//db.lm.${DOMAIN}:1521/LOYALTY',
  'loyalty.conf.datasource.username=LOYALTY_CONF',
  'sms.datasource.url=jdbc:oracle:thin:@//db.lm.${DOMAIN}:1521/LOYALTY',
  'sms.datasource.username=SMS_TEMPLATES',
  'email.datasource.url=jdbc:oracle:thin:@//db.lm.${DOMAIN}:1521/LOYALTY',
  'email.datasource.username=EMAIL_TEMPLATES',
  '#VAR DOMAIN=example.com',
];
const pad = (n: number) => String(n).padStart(2, '0');
const local = (d: Date, sep = ' ') => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}${sep}${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

try {
  // ---- connections
  let r = judgeHealth(jar({ db: true, mq: true }), answer({ conns: [1521, 1521, 1521, 61616], log: [AMQ_LINE] }));
  check('needs both, connected to both: no problem', r.checked && r.problems.length === 0, r);
  check('...its log reported a broker error 7 minutes ago: a note with the time, not a problem', r.note === 'Its log reported a broker connection error at 12:13: AMQ219007: Cannot connect to server(s). Tried with all available servers.', r.note);
  r = judgeHealth(jar({ db: true, mq: true }), answer({ conns: [1521, 61616], log: [AMQ_LINE], now: '2026-10-22 15:20:00' }));
  check('...the same error 3 hours ago: no note', r.note === null, r.note);

  r = judgeHealth(jar({ db: true, mq: true }), answer({ conns: [1521], mqHere: 0, log: [AMQ_LINE] }), true);
  check(
    'needs Artemis, no connection, and Artemis on this server is down: says so, with the log line',
    r.problems.length === 1 && /Artemis on this server isn't running \(nothing listens on port 61616\)/.test(r.problems[0]) && /Its log at 12:13: AMQ219007/.test(r.problems[0]) && r.note === null,
    r,
  );
  r = judgeHealth(jar({ mq: true }), answer({ conns: [], mqHere: 1 }), true);
  check('needs Artemis, no connection, Artemis is up, nothing in its log: fine (it connects when it has a message to send)', r.problems.length === 0, r.problems);
  r = judgeHealth(jar({ mq: true }), answer({ conns: [], mqHere: 1, log: [AMQ_LINE] }), true);
  check('...with a broker error in its log 7 minutes ago: "no connection to Artemis (port 61616)", with the line', /^It has no connection to Artemis \(port 61616\)\. Its log at 12:13: AMQ219007/.test(r.problems[0] ?? ''), r.problems);
  r = judgeHealth(jar({ mq: true }), answer({ conns: [], mqHere: 0, log: [AMQ_LINE] }), false);
  check('...Artemis runs elsewhere (not on this server): doesn\'t claim it is down here', /^It has no connection to Artemis \(port 61616\)\./.test(r.problems[0] ?? ''), r.problems);
  r = judgeHealth(jar({ db: true }), answer({ conns: [61616], log: [ORA_LINE] }));
  check('needs the database, no connection: says so, with the ORA line from its log', r.problems.length === 1 && /no connection to the database \(port 1521\)\. Its log at 12:18: ORA-12516/.test(r.problems[0]), r.problems);
  r = judgeHealth(jar(), answer({ conns: [] }));
  check('needs nothing, no connections at all: fine (voucher-backend)', r.problems.length === 0, r);

  // ---- a jar's port
  r = judgeHealth(jar(), answer({ probes: ['7088 000 28 000 28'] }));
  check('its port took the connection but nothing came back: "doesn\'t answer requests ... within 5 seconds"', r.problems[0] === "It doesn't answer requests: nothing came back from port 7088 within 5 seconds.", r.problems);
  r = judgeHealth(jar(), answer({ probes: ['7088 000 7 000 7'] }));
  check('...refused: says so', /port 7088 refused the connection/.test(r.problems[0] ?? ''), r.problems);
  r = judgeHealth(jar(), answer({ probes: ['7088 000 28 000 28', '7090 200 0 000 52'] }));
  check('...another of its ports answers: fine (a second, non-web port)', r.problems.length === 0, r);
  r = judgeHealth(jar(), answer({ probes: ['4040 200 0 400 0'] }));
  check('...an HTTPS port answering "Unauthorized" (as on Worker_1): fine', r.problems.length === 0, r);

  // ---- what can't be concluded
  r = judgeHealth(jar({ db: true }), answer({ who: ['1001', '1000'], conns: [] }));
  check('another user\'s process (its sockets are invisible): no conclusion, no false alarm', !r.checked && r.problems.length === 0, r);
  r = judgeHealth(jar({ db: true }), answer({ who: ['1001', '0'], conns: [] }));
  check('...unless Healthcheck signs in as root', r.checked && r.problems.length === 1, r);
  r = judgeHealth(jar({ db: true }), answer({ who: ['-', '1000'], conns: [] }));
  check('the process is gone: no conclusion', !r.checked && r.problems.length === 0, r);
  r = judgeHealth(jar({ db: true }), answer({ end: false }));
  check('the command didn\'t finish: no conclusion', !r.checked && r.problems.length === 0, r);

  // ---- which database accounts it signs in with
  check(
    'a JDBC url -> its database: //host:port/SERVICE, host:port/SERVICE, host:port:SID, a descriptor',
    databaseOf('jdbc:oracle:thin:@//DB.lm.Example.com:1521/loyalty') === 'db.lm.example.com:1521/LOYALTY' &&
      databaseOf('jdbc:oracle:thin:@db.lm.example.com:1521/LOYALTY') === 'db.lm.example.com:1521/LOYALTY' &&
      databaseOf('jdbc:oracle:thin:@db1:1522:ORCL') === 'db1:1522/ORCL' &&
      databaseOf('jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=db.um.x)(PORT=1523))(CONNECT_DATA=(SERVICE_NAME=usage)))') === 'db.um.x:1523/USAGE' &&
      databaseOf('jdbc:oracle:thin:***@db.sm.x:1521/SALES') === 'db.sm.x:1521/SALES',
    [databaseOf('jdbc:oracle:thin:@db1:1522:ORCL'), databaseOf('jdbc:oracle:thin:***@db.sm.x:1521/SALES')],
  );
  let accts = accountsFromConfig(LOYALTY_BACKEND_CONF);
  check(
    'loyalty-backend\'s settings: its three accounts, ${DOMAIN} filled in from its environment',
    accts.map((a) => a.user).join(',') === 'LOYALTY_CONF,SMS_TEMPLATES,EMAIL_TEMPLATES' && accts.every((a) => a.db === 'db.lm.example.com:1521/LOYALTY'),
    accts,
  );
  accts = accountsFromConfig([
    '#FILE /x/application.properties',
    'spring.datasource.hikari.jdbc-url=jdbc:oracle:thin:@//h:1521/A',
    'spring.datasource.hikari.username=HIKARI_USER',
    'spring.datasource.voucher.jdbc-url=jdbc:oracle:thin:@//h:1521/A',
    'spring.datasource.voucher.username=VOUCHER',
    'spring.datasource.voucher.password=secret',
    'spring.datasource.url=jdbc:oracle:thin:@//h:1521/${DB:FALLBACK}',
    'spring.datasource.username=${UNKNOWN_USER}',
  ]);
  check(
    '...a Hikari block, voucher-management\'s spring.datasource.voucher.*, a ${X:default}; a user name that can\'t be filled in is left out',
    accts.map((a) => `${a.user}@${a.db}`).join(',') === 'HIKARI_USER@h:1521/A,VOUCHER@h:1521/A',
    accts,
  );
  accts = accountsFromConfig(['#FILE /x/application.yml', 'spring:', '  datasource:', '    username: YAML_USER', '    url: jdbc:oracle:thin:@//h:1521/B']);
  check('...a .yml file: the url with the user name next to it', accts.length === 1 && accts[0].user === 'YAML_USER' && accts[0].db === 'h:1521/B', accts);

  // WildFly: jboss-cli's answer to /subsystem=datasources/data-source=*:read-attribute(name=...)
  const cliReply = (pairs: [string, string][]) =>
    `{\n    "outcome" => "success",\n    "result" => [\n${pairs
      .map(([ds, v]) => `        {\n            "address" => [\n                ("subsystem" => "datasources"),\n                ("data-source" => "${ds}")\n            ],\n            "outcome" => "success",\n            "result" => "${v}"\n        }`)
      .join(',\n')}\n    ]\n}`;
  const users = parseAttributeList(cliReply([['injaz', 'INJAZ'], ['LOYALTY_CONF', 'LOYALTY_CONF']]));
  const jndis = parseAttributeList(cliReply([['injaz', 'java:/injaz'], ['LOYALTY_CONF', 'java:/LOYALTY_CONF']]));
  const urls = parseAttributeList(cliReply([['injaz', 'jdbc:oracle:thin:@db.lm.x:1521/LOYALTY'], ['LOYALTY_CONF', 'jdbc:oracle:thin:@db.lm.x:1521/LOYALTY']]));
  const wf = wildflyAccounts(users, jndis, urls);
  check(
    'WildFly: each datasource\'s user name, JNDI name and database, from jboss-cli',
    wf.length === 2 && wf[1].user === 'LOYALTY_CONF' && wf[1].jndi === 'java:/LOYALTY_CONF' && wf[1].db === 'db.lm.x:1521/LOYALTY' && wf[0].user === 'INJAZ',
    wf,
  );

  // ---- a database account in its own log
  r = judgeHealth(wildfly, answer({ conns: [1521, 1521, 61616], log: [LOCKED_WF], now: '2026-10-22 13:58:00' }), false, { accounts: WF_ACCOUNTS });
  check(
    'WildFly\'s log (JSON): pool java:/LOYALTY_CONF can\'t be filled, ORA-28000: names the account, the time, what still works, and not to restart',
    r.problems.length === 1 &&
      r.problems[0] ===
        "The database account LOYALTY_CONF is locked, so it can't open new connections to the database. It still works on the connections it already has; a restart or a busy moment will break it. Its log at 13:46: ORA-28000: The account is locked. Don't restart it before the account is unlocked: it would stop working completely.",
    r.problems,
  );
  check('...and keeps it, with the account, for the other services', r.accountErrors.length === 1 && r.accountErrors[0].account.user === 'LOYALTY_CONF' && r.accountErrors[0].code === 'ORA-28000', r.accountErrors);
  check(
    '...and names it as the cause when a Start / Restart stops WildFly for that datasource',
    accountCause(r.accountErrors) === 'the database account LOYALTY_CONF is locked (ORA-28000)' && accountCause([]) === '',
    accountCause(r.accountErrors),
  );
  r = judgeHealth(wildfly, answer({ conns: [1521], log: [LOCKED_WF], now: '2026-10-22 14:47:00' }), false, { accounts: WF_ACCOUNTS });
  check('...an hour later with nothing new in its log: still shown (a log never says the account works again)', r.problems.length === 1 && r.accountErrors.length === 1, r);
  r = judgeHealth(wildfly, answer({ conns: [1521], log: [LOCKED_WF], now: '2026-10-23 09:00:00' }), false, { accounts: WF_ACCOUNTS });
  check('...the next day: its date is said', / Its log on 2026-10-22 at 13:46: ORA-28000/.test(r.problems[0] ?? ''), r.problems);
  r = judgeHealth(jar({ db: true }), answer({ conns: [], log: ['1|2026-10-22 13:50:00||ORA-28000: the account is locked'], conf: LOYALTY_BACKEND_CONF.slice(0, 3).concat('#VAR DOMAIN=example.com'), now: '2026-10-22 13:58:00' }));
  check(
    'a jar with one account: it can only be that one; no connection open; "no connection to the database" isn\'t said on top',
    r.problems.length === 1 && /^The database account LOYALTY_CONF is locked.* It has no database connection open, so whatever needs that account fails\. Its log at 13:50: ORA-28000/.test(r.problems[0]),
    r.problems,
  );
  r = judgeHealth(jar(), answer({ log: ['1|2026-10-22 13:50:00||ORA-28000: the account is locked'], conf: LOYALTY_BACKEND_CONF, now: '2026-10-22 13:58:00' }));
  check(
    'a jar with three accounts: the log doesn\'t say which, so "one of" them, kept only for itself (no account name)',
    /^One of the database accounts it signs in with \(LOYALTY_CONF, SMS_TEMPLATES or EMAIL_TEMPLATES\) is locked/.test(r.problems[0] ?? '') && r.accountErrors.length === 1 && r.accountErrors[0].account.user === '',
    r,
  );
  r = judgeHealth(jar(), answer({ log: ['4|2026-10-22 13:50:00||ORA-01017: invalid username/password; logon denied'], conf: LOYALTY_BACKEND_CONF.slice(0, 3), now: '2026-10-22 13:58:00' }));
  check('a wrong password (ORA-01017): says each attempt brings the account closer to locking', /refuses the password in its settings for LOYALTY_CONF.*closer to being locked.*Fix the password in its settings before restarting it\./.test(r.problems[0] ?? ''), r.problems);
  r = judgeHealth(wildfly, answer({ who: ['1001', '1000'], log: [LOCKED_WF], now: '2026-10-22 13:58:00' }), false, { accounts: WF_ACCOUNTS });
  check('...its process can\'t be seen (another user): the log still tells, without guessing its connections', r.checked && /locked.* A restart or a busy moment will break it\. Its log/.test(r.problems[0] ?? ''), r.problems);

  // ---- ... and in another service's log, kept in the database
  const now = new Date().toISOString();
  sqlite.prepare("INSERT INTO groups (id, name, created_at) VALUES (1, 'g', ?)").run(now);
  sqlite.prepare("INSERT INTO servers (id, group_id, name, host, ssh_username, ssh_key_path, created_at) VALUES (1, 1, 'Loyalty', 'h', 'u', '/k', ?), (2, 1, 'Worker_1', 'h2', 'u', '/k', ?)").run(now, now);
  applyBundledDefaults();
  const idOf = (name: string) => (sqlite.prepare('SELECT id FROM software_definitions WHERE name = ?').get(name) as any).id as number;
  const WF = idOf('WildFly (JBoss)');
  const LB = idOf('loyalty-backend');
  const lbAccounts = accountsFromConfig(LOYALTY_BACKEND_CONF);
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  saveAccountErrors(1, WF, [{ account: { user: 'LOYALTY_CONF', db: 'db.lm.example.com:1521/LOYALTY' }, code: 'ORA-28000', text: 'ORA-28000: The account is locked.', loggedAt: ago(12) }]);
  let seen = accountErrorsSeenElsewhere(1, LB, lbAccounts);
  check('loyalty-backend signs in as LOYALTY_CONF on the same database: WildFly\'s locked account is found', seen.length === 1 && seen[0].software === 'WildFly (JBoss)', seen);
  r = judgeHealth(jar(), answer({ conns: [], conf: LOYALTY_BACKEND_CONF, now: local(new Date()) }), false, { elsewhere: seen, serverId: 1 });
  check(
    '...and loyalty-backend, with nothing in its own log (no request needed the account yet), is told',
    r.problems.length === 1 && /^The database account LOYALTY_CONF is locked.* Seen in the log of WildFly \(JBoss\) at \d\d:\d\d \(ORA-28000\)\. Don't restart it/.test(r.problems[0]),
    r.problems,
  );
  check('...on another server the message says which', / Seen in the log of WildFly \(JBoss\) on Loyalty at /.test(judgeHealth(jar(), answer({ conf: LOYALTY_BACKEND_CONF }), false, { elsewhere: seen, serverId: 2 }).problems[0] ?? ''));
  check('...the same, told after the whole check (it was looked at before WildFly)', /LOYALTY_CONF is locked/.test(accountProblemsSeenLater(1, LB, lbAccounts, 0)[0] ?? ''));
  check('WildFly isn\'t told its own error a second time', accountErrorsSeenElsewhere(1, WF, WF_ACCOUNTS).length === 0);
  check(
    'SMS_TEMPLATES on another database is another account: not affected',
    accountErrorsSeenElsewhere(1, LB, [{ user: 'LOYALTY_CONF', db: 'db.sm.example.com:1521/SALES' }]).length === 0,
  );
  saveAccountErrors(1, WF, [{ account: { user: 'LOYALTY_CONF', db: 'db.lm.example.com:1521/LOYALTY' }, code: 'ORA-01017', text: 'ORA-01017: invalid username/password', loggedAt: ago(5) }]);
  check('a wrong password in WildFly\'s settings isn\'t told to loyalty-backend (its own settings may be right)', accountErrorsSeenElsewhere(1, LB, lbAccounts).length === 0);
  saveAccountErrors(1, WF, [{ account: { user: 'LOYALTY_CONF', db: 'db.lm.example.com:1521/LOYALTY' }, code: 'ORA-28000', text: 'x', loggedAt: ago(61) }]);
  check('an hour-old one: still told (the account may well still be locked)', accountErrorsSeenElsewhere(1, LB, lbAccounts).length === 1);
  saveAccountErrors(1, WF, [{ account: { user: 'LOYALTY_CONF', db: 'db.lm.example.com:1521/LOYALTY' }, code: 'ORA-28000', text: 'x', loggedAt: ago(25 * 60) }]);
  check('...a day-old one: not any more', accountErrorsSeenElsewhere(1, LB, lbAccounts).length === 0);
  saveAccountErrors(1, WF, [{ account: { user: 'LOYALTY_CONF', db: 'db.lm.example.com:1521/LOYALTY' }, code: 'ORA-28000', text: 'x', loggedAt: ago(2) }]);
  saveAccountErrors(1, WF, []);
  check('WildFly checked again with a quiet log (restarted after the unlock): nothing left to tell', accountErrorsSeenElsewhere(1, LB, lbAccounts).length === 0);

  // ---- "It's fixed"
  const lockedAt = ago(30);
  saveAccountErrors(1, WF, [{ account: { user: 'LOYALTY_CONF', db: 'db.lm.example.com:1521/LOYALTY' }, code: 'ORA-28000', text: 'ORA-28000: The account is locked.', loggedAt: lockedAt }]);
  saveServiceAccounts(1, WF, WF_ACCOUNTS);
  saveServiceAccounts(1, LB, lbAccounts);
  saveServiceAccounts(2, LB, lbAccounts); // loyalty-backend on Worker_1 too
  const SB = idOf('streak-backend');
  saveServiceAccounts(1, SB, [{ user: 'STREAK', db: 'db.lm.example.com:1521/LOYALTY' }]);
  let troubles = accountTroubles(1);
  check(
    'where "It\'s fixed" is offered: WildFly (its own log) and loyalty-backend (told), not streak-backend',
    troubles.map((t) => `${t.software_id}:${t.users.join(',')}`).sort().join(' ') === [`${WF}:LOYALTY_CONF`, `${LB}:LOYALTY_CONF`].sort().join(' '),
    troubles,
  );
  const fixedOut = markAccountsFixed(1, LB, 'sam');
  check(
    '"It\'s fixed" on loyalty-backend: LOYALTY_CONF; looks again at every service that signs in with it or logged it (both servers), not streak-backend',
    fixedOut.users.join(',') === 'LOYALTY_CONF' &&
      fixedOut.recheck.map((x) => `${x.server_id}:${x.software_id}`).sort().join(' ') === [`1:${WF}`, `1:${LB}`, `2:${LB}`].sort().join(' '),
    fixedOut,
  );
  check('...then nothing is offered or told any more', accountTroubles(1).length === 0 && accountErrorsSeenElsewhere(1, LB, lbAccounts).length === 0);
  // as if it had been clicked 10 minutes ago, so that an error can come after it
  sqlite.prepare('UPDATE db_account_fixes SET fixed_at = ?').run(ago(10));
  const fixes = loadFixes();
  const fixedStamp = (iso: string) => local(new Date(iso));
  r = judgeHealth(wildfly, answer({ conns: [1521], log: [`2|${fixedStamp(lockedAt)}|java:/LOYALTY_CONF|ORA-28000: The account is locked.`], now: local(new Date()) }), false, { accounts: WF_ACCOUNTS, fixes, serverId: 1 });
  check('...WildFly\'s own log still has the error from before: left out', r.problems.length === 0 && r.accountErrors.length === 0, r);
  r = judgeHealth(wildfly, answer({ conns: [1521], log: [`1|${local(new Date(Date.now() - 5 * 60_000))}|java:/LOYALTY_CONF|ORA-28000: The account is locked.`], now: local(new Date()) }), false, { accounts: WF_ACCOUNTS, fixes, serverId: 1 });
  check('...a new error after "It\'s fixed": shown again (still locked)', r.problems.length === 1 && /LOYALTY_CONF is locked/.test(r.problems[0]), r.problems);
  saveAccountErrors(1, LB, [{ account: { user: '', db: '' }, code: 'ORA-28000', text: 'x', loggedAt: ago(1) }]);
  troubles = accountTroubles(1);
  check('a jar whose log didn\'t say which account: offered on it, naming its accounts', troubles.length === 1 && troubles[0].software_id === LB && troubles[0].users.length === 3, troubles);
  markAccountsFixed(1, LB, 'sam');
  check('...and "It\'s fixed" on it clears that too', accountTroubles(1).length === 0);

  // ---- the shell command itself
  const svc = { ...jar({ db: true }), kind: 'service', log_path: "/Data/logs/it's.log" };
  for (const [label, d] of [['a jar', jar({ db: true, mq: true })], ['a service (no port probe), quote in its log path', svc]] as const) {
    const res = spawnSync('bash', ['-n', '-c', healthCommand(d, 'balance-util.service')], { encoding: 'utf8' });
    check(`the command for ${label} is valid shell`, res.status === 0, res.stderr);
  }
  check('...the port probe and the settings only for jars', /curl/.test(healthCommand(jar(), 'x.service')) && /DBCONF/.test(healthCommand(jar(), 'x.service')) && !/curl|DBCONF/.test(healthCommand(svc, 'x.service')));

  // run here, where bash, tac and awk exist: on sample logs, and on a settings file with passwords in it
  if (spawnSync('bash', ['-c', 'command -v tac && command -v awk && date -d "-1 hours" >/dev/null'], { encoding: 'utf8' }).status === 0) {
    const t = (min: number, sep = ' ') => local(new Date(Date.now() - min * 60_000), sep);
    const files: Record<string, string> = {
      'wf.json.log': [
        `{"timestamp":"${t(26 * 60, 'T')}.100+03:00","level":"WARN","message":"IJ000610: Unable to fill pool: java:/STREAK","exception":{"message":"ORA-28000: The account is locked."}}`,
        `{"timestamp":"${t(120, 'T')}.100+03:00","level":"INFO","message":"WFLYSRV0049: WildFly Full 26.1.3.Final starting"}`,
        `{"timestamp":"${t(20, 'T')}.735+03:00","level":"WARN","message":"IJ000610: Unable to fill pool: java:/LOYALTY_CONF","exception":{"message":"IJ031084: Unable to create connection","causedBy":{"message":"ORA-28000: The account is locked.\\n\\nhttps://docs.oracle.com/error-help/db/ora-28000/"}}}`,
        `{"timestamp":"${t(5, 'T')}.735+03:00","level":"WARN","message":"IJ000610: Unable to fill pool: java:/LOYALTY_CONF","exception":{"message":"ORA-28000: The account is locked."}}`,
      ].join('\n'),
      'wf.text.log': [
        `${t(300)},001 INFO  [org.jboss.as] WFLYSRV0049: WildFly Full 26.1.3.Final starting`,
        `${t(10)},500 WARN  [org.jboss.jca.core.connectionmanager.pool.strategy.OnePool] (JCA PoolFiller) IJ000610: Unable to fill pool: java:/STREAK: javax.resource.ResourceException: IJ031084: Unable to create connection`,
        '\tat org.jboss.jca.adapters.jdbc.local.LocalManagedConnectionFactory.createLocalManagedConnection(LocalManagedConnectionFactory.java:345)',
        'Caused by: java.sql.SQLException: ORA-28001: the password has expired',
      ].join('\n'),
      'spring.log': [
        `${t(90)}.100 | main | ERROR | x | ORA-28000: the account is locked (before its last start)`,
        `${t(60)}.218 | main | INFO  | o.s.b.StartupInfoLogger | Starting LoyaltyAdminApplication v0.0.2 using Java 17`,
        `${t(5)}.010 | https-exec-3 | ERROR | o.h.e.j.s.SqlExceptionHelper | Could not open JPA EntityManager for transaction; nested exception ... ORA-28000: the account is locked`,
      ].join('\n'),
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-health-sh-'));
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), `${text}\n`);
    const runLog = (f: string, def: any) => spawnSync('bash', ['-c', healthCommand({ ...def, log_path: path.join(dir, f) }, 'hc-test-no-such-unit.service')], { encoding: 'utf8' }).stdout;
    r = judgeHealth(wildfly, runLog('wf.json.log', wildfly), false, { accounts: WF_ACCOUNTS });
    check(
      'run on a WildFly JSON log: its time read, the pool named, counted once, since its last start only (STREAK\'s older one left out)',
      r.problems.length === 1 && /LOYALTY_CONF is locked.* Its log at \d\d:\d\d: ORA-28000: The account is locked\. Don't/.test(r.problems[0]) && r.accountErrors.length === 1,
      [r.problems, runLog('wf.json.log', wildfly).split('@@LOG')[1]],
    );
    r = judgeHealth(wildfly, runLog('wf.text.log', wildfly), false, { accounts: WF_ACCOUNTS });
    check('run on a WildFly text log: the stack trace line belongs to the pool above it', /The password of the database account STREAK has expired/.test(r.problems[0] ?? ''), [r.problems, runLog('wf.text.log', wildfly).split('@@LOG')[1]]);
    r = judgeHealth(jar(), runLog('spring.log', jar()));
    check('run on a Spring log: the account error counts even after a more general phrase on its line', /^Its database account is locked/.test(r.problems[0] ?? '') && r.problems.length === 1, [r.problems, runLog('spring.log', jar()).split('@@LOG')[1]]);

    // the settings part, with the start command and environment it would read on the server
    fs.mkdirSync(path.join(dir, 'app/conf'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'app/conf/application.properties'),
      [
        'loyalty.conf.datasource.url=jdbc:oracle:thin:@//db.lm.${DOMAIN}:1521/${LOYALTY_DB}',
        'loyalty.conf.datasource.username=LOYALTY_CONF',
        'loyalty.conf.datasource.password=TopSecret1',
        'sms.datasource.url = jdbc:oracle:thin:scott/tiger@db.sm.example:1521/SALES',
        'sms.datasource.username = SMS_TEMPLATES',
        'spring.datasource.hikari.jdbc-url=jdbc:oracle:thin:@//h:1521/A?password=inurl',
        'spring.datasource.hikari.username=USAGE',
        'db.user.password=nope',
        'LOYALTY_DB=LOYALTY',
      ].join('\n'),
    );
    const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
    const cmd = dbConfigCommand('hc-test-no-such-unit.service', q)
      .replace(/^EXEC=.*$/m, `EXEC='{ path=/usr/bin/java ; argv[]=/usr/bin/java -jar /x/app.jar --spring.config.location=conf/application.properties ; }'; WD=${q(path.join(dir, 'app'))}`)
      .replace(/^ENVF=.*$/m, `ENVF='DOMAIN=example.eg\nDB_PASSWORD=hunter2'`);
    const out = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' }).stdout;
    check('run on a settings file: no password, from any line, leaves the server', !/TopSecret1|tiger|hunter2|nope|inurl/.test(out), out);
    accts = accountsFromConfig(out.split('\n'));
    check(
      '...and the accounts come out, placeholders filled in from its environment and the file',
      accts.map((a) => `${a.user}@${a.db}`).join(',') === 'LOYALTY_CONF@db.lm.example.eg:1521/LOYALTY,SMS_TEMPLATES@db.sm.example:1521/SALES,USAGE@h:1521/A',
      accts,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- stored and read back
  const put = (sw: number, status: string, detail: string) =>
    sqlite.prepare("INSERT INTO heartbeat_log (server_id, software_id, source, status, detail, checked_at) VALUES (1, ?, 'heartbeat', ?, ?, ?)").run(sw, status, detail, now);
  put(101, 'down', 'unhealthy:It has no connection to Artemis (port 61616).');
  put(102, 'up', 'running:Its log reported a broker connection error at 12:13: AMQ219007');
  put(103, 'up', 'running');
  const s1 = getServerComponentStatus(1, 's', 101);
  const s2 = getServerComponentStatus(1, 's', 102);
  const s3 = getServerComponentStatus(1, 's', 103);
  check('"unhealthy:<why>" reads back as Running, but not working, with why', s1.state === 'unhealthy' && s1.detail === 'It has no connection to Artemis (port 61616).', s1);
  check('"running:<note>" reads back as running, with the note', s2.state === 'running' && s2.status === 'up' && /AMQ219007/.test(s2.detail ?? ''), s2);
  check('plain "running": running, no note', s3.state === 'running' && s3.detail === null, s3);

  // ---- the shipped values reach an installation
  const needs = (name: string) => sqlite.prepare('SELECT needs_database AS db, needs_artemis AS mq FROM software_definitions WHERE name = ?').get(name) as any;
  check('a new installation: WildFly and balance-notification need both, balance-management the database', needs('WildFly (JBoss)')?.db === 1 && needs('WildFly (JBoss)')?.mq === 1 && needs('balance-notification')?.mq === 1 && needs('balance-management')?.db === 1 && needs('balance-management')?.mq === 0, [needs('WildFly (JBoss)'), needs('balance-management')]);
  check('...voucher-backend needs neither', needs('voucher-backend')?.db === 0 && needs('voucher-backend')?.mq === 0);
  // an installation from before these fields: its rows have the column default, its snapshot doesn't know them
  sqlite.prepare("UPDATE software_definitions SET needs_database = 0, needs_artemis = 0 WHERE name IN ('balance-management', 'WildFly (JBoss)')").run();
  sqlite.prepare("UPDATE software_definitions SET needs_artemis = 1 WHERE name = 'voucher-backend'").run(); // an operator ticked it
  const snap = JSON.parse((sqlite.prepare("SELECT value FROM app_meta WHERE key = 'defaults_snapshot'").get() as any).value);
  for (const v of Object.values(snap.catalog) as any[]) {
    delete v.needs_database;
    delete v.needs_artemis;
  }
  sqlite.prepare("UPDATE app_meta SET value = ? WHERE key = 'defaults_snapshot'").run(JSON.stringify(snap));
  const result = applyBundledDefaults();
  check('upgrading an older installation: the shipped values arrive', needs('balance-management')?.db === 1 && needs('WildFly (JBoss)')?.mq === 1, [needs('balance-management'), needs('WildFly (JBoss)'), result.updatedSoftware]);
  check('...but an operator\'s own tick is kept', needs('voucher-backend')?.mq === 1, needs('voucher-backend'));
} finally {
  sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
