// Can a running service do its job, beyond systemd saying "active"? Read-only, one command per service:
// - a jar: does one of its ports give a web answer (any HTTP status, even 401 or 404, means it accepts requests)?
//   The ports are read from its own process, so nothing is set per market. The big services also listen on internal
//   ports that never answer a web request (Keycloak's cluster port, Artemis's broker port), so they aren't probed;
//   WildFly has its own traffic check (wildfly.ts).
// - "Needs the database" / "Needs Artemis" in the Software Catalog: does it hold an open connection to DATABASE_PORT /
//   the port in ARTEMIS_URL right now?
// - its log since it last started: connection errors to the broker or the database, with their time. They explain a
//   problem; on their own (its connections look fine, it may have reconnected) a recent one is only a note.
// - its database accounts (scan/dbAccounts.ts): a locked or expired account, or a wrong password, in its log since it
//   started, or a locked / expired one in the log of another service that signs in with the same account, until
//   someone marks it fixed. Oracle keeps the sessions it already has, so nothing else shows it until it needs a new
//   connection.
import type { Client } from 'ssh2';
import type { SoftwareDefinition } from '@healthcheck/shared';
import { runCommand } from '../ssh/exec.js';
import { env } from '../env.js';
import {
  ACCOUNT_CODES,
  accountErrorsSeenElsewhere,
  accountsFromConfig,
  dbConfigCommand,
  loadFixes,
  saveAccountErrors,
  saveServiceAccounts,
  type AccountTrouble,
  type DbAccount,
  type Fixes,
  type SeenAccountError,
} from './dbAccounts.js';

const shQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
const MARK = '@@';
const PROBE_TIMEOUT_S = 5;
// a log error this recent, with nothing else wrong, is shown as a note
const NOTE_MINUTES = 60;
// how far back the log is read (it stops earlier at the line where the service last started)
const LOG_HOURS = 24;
const LOG_MAX_LINES = 200_000;

export const artemisPort = () => Number(/:(\d+)\s*$/.exec(env.artemisUrl.split('?')[0])?.[1] ?? 61616);

const ARTEMIS_ERR = /AMQ219007|AMQ219010|AMQ219015|AMQ212037|Cannot connect to server\(s\)/;
const DATABASE_ERR = /ORA-\d{5}|Connection is not available|Unable to acquire JDBC Connection|Communications link failure|Could not open JPA EntityManager|JDBCConnectionException/;
// awk has no {n}: the same patterns, spelled out
const AWK_ERR =
  'AMQ219007|AMQ219010|AMQ219015|AMQ212037|Cannot connect to server\\(s\\)|ORA-[0-9][0-9][0-9][0-9][0-9]|Connection is not available|Unable to acquire JDBC Connection|Communications link failure|Could not open JPA EntityManager|JDBCConnectionException';
const AWK_ACCOUNT = Object.keys(ACCOUNT_CODES).join('|');
const ACCOUNT_RE = new RegExp(AWK_ACCOUNT);
const AWK_TS = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][ T][0-9][0-9]:[0-9][0-9]:[0-9][0-9]';
// where the log of its current run begins: Spring Boot, WildFly, Artemis
const AWK_START = 'Starting [A-Za-z0-9]*Application |WFLYSRV0049|AMQ221000';
// A line's time: "2026-10-22 13:46:04 ..." at its start, or WildFly's JSON log {"timestamp":"2026-10-22T13:46:04.735+03:00",...}
const AWK_STAMP =
  `function stamp(  s) { if ($0 ~ /^${AWK_TS}/) s = substr($0, 1, 19); else if (match($0, /"timestamp":"${AWK_TS}/)) s = substr($0, RSTART + 13, 19); else return ""; ` +
  `sub(/T/, " ", s); return s }`;
// The log since the service last started (at most LOG_HOURS back), read from its end: each different error once, with
// how often it came, its last time, the WildFly pool it was about (IJ000610 "Unable to fill pool: java:/X", IJ000453
// "Unable to get managed connection for java:/X"; the stack trace lines below a record belong to it) and its text.
// Prints "count|time|pool|text".
function logCommand(path: string): string {
  const scan =
    `${AWK_STAMP} { s = stamp(); if (s != "") { ts = s; pool = "" } } ` +
    `match($0, /(fill pool:|connection for) java:[^ ",\\\\]+/) { p = substr($0, RSTART, RLENGTH); sub(/^.* java:/, "java:", p); sub(/:$/, "", p); pool = p } ` +
    // an account error counts first, even after a more general phrase on the same line
    `{ if (match($0, /${AWK_ACCOUNT}/) || match($0, /${AWK_ERR}/)) { k = pool "|" substr($0, RSTART, RLENGTH); n[k]++; last[k] = ts "|" pool "|" substr($0, RSTART, 300) } } ` +
    `END { for (k in last) print n[k] "|" last[k] }`;
  return (
    `if [ -r ${shQuote(path)} ]; then CUT=$(date -d '-${LOG_HOURS} hours' '+%Y-%m-%d %H:%M:%S' 2>/dev/null); ` +
    `tac ${shQuote(path)} | head -n ${LOG_MAX_LINES} | awk -v cut="$CUT" '${AWK_STAMP} { s = stamp(); if (s != "" && cut != "" && s < cut) exit } { print } /${AWK_START}/ { exit }' | ` +
    `tac | awk '${scan}' | sort -t'|' -k2 | tail -n 30; fi`
  );
}

export function healthCommand(def: SoftwareDefinition, unit: string): string {
  const probe = def.kind === 'jar';
  return [
    `PID=$(systemctl show -p MainPID --value ${shQuote(unit)} 2>/dev/null); [ "$PID" = "0" ] && PID=""`,
    `if [ -n "$PID" ] && [ "$(ps -o comm= -p "$PID" 2>/dev/null)" != "java" ]; then C=$(pgrep -P "$PID" java | head -1); [ -n "$C" ] && PID=$C; fi`,
    `echo ${MARK}NOW; date '+%Y-%m-%d %H:%M:%S'`,
    // whose process it is (user ids): ss only shows another user's sockets to root
    `echo ${MARK}WHO; O=$([ -n "$PID" ] && ps -o uid= -p "$PID" 2>/dev/null | tr -d ' '); echo "\${O:--}"; id -u`,
    // its TCP sockets, read once (ss -p looks through every process, which takes a moment on a busy server)
    `SOCK=$([ -n "$PID" ] && ss -tanpH 2>/dev/null | grep "pid=$PID,")`,
    `LISTEN=$(printf '%s\\n' "$SOCK" | awk '$1 == "LISTEN" {print $4}' | sort -u | head -8)`,
    `echo ${MARK}LISTEN; printf '%s\\n' "$LISTEN" | grep -v '^$'`,
    `echo ${MARK}CONN; printf '%s\\n' "$SOCK" | awk '$1 == "ESTAB" {print $5}' | sed 's/.*://'`,
    `echo ${MARK}MQHERE; ss -ltnH "( sport = :${artemisPort()} )" 2>/dev/null | wc -l`,
    `echo ${MARK}PROBE`,
    probe
      ? `if [ -n "$PID" ] && command -v curl >/dev/null 2>&1; then for a in $(printf '%s\\n' "$LISTEN" | head -3); do ` +
        `port=\${a##*:}; host=\${a%:*}; host=\${host#[}; host=\${host%]}; host=\${host#::ffff:}; case "$host" in 0.0.0.0|'*'|::) host=127.0.0.1;; esac; ` +
        `case "$host" in *:*) h="[$host]";; *) h=$host;; esac; ` +
        `s=$(curl -sk -o /dev/null -m ${PROBE_TIMEOUT_S} -w '%{http_code}' "https://$h:$port/" 2>/dev/null); e=$?; ` +
        `t=$(curl -s -o /dev/null -m ${PROBE_TIMEOUT_S} -w '%{http_code}' "http://$h:$port/" 2>/dev/null); f=$?; echo "$port $s $e $t $f"; done; ` +
        `elif [ -n "$PID" ]; then echo nocurl; fi`
      : 'true',
    `echo ${MARK}LOG`,
    def.log_path ? logCommand(def.log_path) : 'true',
    // a jar's database user names, from its settings (WildFly's come from jboss-cli)
    probe ? dbConfigCommand(unit, shQuote) : 'true',
    `echo ${MARK}END`,
  ].join('\n');
}

function sections(out: string): Record<string, string[]> {
  const s: Record<string, string[]> = {};
  let name = '';
  for (const line of out.split('\n')) {
    const m = /^@@([A-Z]+)$/.exec(line.trim());
    if (m) s[(name = m[1])] = [];
    else if (name) s[name].push(line.replace(/\s+$/, ''));
  }
  return s;
}

export interface HealthResult {
  checked: boolean; // false: nothing could be concluded (couldn't see the process, the command failed)
  problems: string[];
  note: string | null;
  // the database accounts it signs in with
  accounts: DbAccount[];
  // its open connections to DATABASE_PORT (null: its sockets couldn't be seen)
  dbConnections: number | null;
  // account errors in its own log that could be pinned to an account: what the other services are told
  accountErrors: { account: DbAccount; code: string; text: string; at: string }[];
}

interface LogHit {
  at: string | null; // "2026-10-22 12:13:28" on the server's clock
  kind: 'artemis' | 'database';
  code: string; // ORA-28000, AMQ219007, "Connection is not available"
  pool: string | null; // WildFly: java:/LOYALTY_CONF
  count: number;
  text: string; // from the error code on: "AMQ219007: Cannot connect to server(s). ..."
}

// "count|time|pool|text"
function logHits(lines: string[]): LogHit[] {
  return lines
    .map((l) => /^(\d+)\|([^|]*)\|([^|]*)\|(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => {
      const line = m[4];
      const acct = ACCOUNT_RE.exec(line);
      const isArtemis = !acct && ARTEMIS_ERR.test(line);
      const found = acct ?? (isArtemis ? ARTEMIS_ERR : DATABASE_ERR).exec(line);
      // a JSON log line goes on after the message: stop at its end
      const text = (found ? line.slice(found.index) : line).split(/\\[nt]|"/)[0].trim().replace(/\s+/g, ' ').slice(0, 160);
      return {
        at: m[2].trim() || null,
        kind: (isArtemis ? 'artemis' : 'database') as LogHit['kind'],
        code: found?.[0] ?? '',
        pool: m[3].trim() || null,
        count: Number(m[1]),
        text,
      };
    })
    .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
}

const hhmm = (at: string | null) => (at ? at.slice(11, 16) : null);
// "at 13:46", or "on 2026-10-21 at 13:46" when it isn't from the same day as `today` (both "YYYY-MM-DD HH:MM...")
const atTime = (when: string, today?: string) => (today && when.slice(0, 10) !== today.slice(0, 10) ? `on ${when.slice(0, 10)} at ${when.slice(11, 16)}` : `at ${when.slice(11, 16)}`);
const fromLog = (hit: LogHit | undefined, now?: string) => (hit ? ` Its log${hit.at ? ` ${atTime(hit.at, now)}` : ''}: ${hit.text}` : '');
const pad2 = (n: number) => String(n).padStart(2, '0');
const localText = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const orList = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}` : xs[0]);

// "The database account X is locked, so ..." for one account, or for "one of" several when the log doesn't say which
function troubleSentence(trouble: AccountTrouble, users: string[]): string {
  const cant = "so it can't open new connections to the database.";
  if (users.length === 1) {
    const u = users[0];
    if (trouble === 'locked') return `The database account ${u} is locked, ${cant}`;
    if (trouble === 'expired') return `The password of the database account ${u} has expired, ${cant}`;
    return `The database refuses the password in its settings for ${u}, ${cant} Every attempt brings that account closer to being locked.`;
  }
  const which = users.length > 1 ? `one of the database accounts it signs in with (${orList(users)})` : 'its database account';
  if (trouble === 'locked') return `${which[0].toUpperCase()}${which.slice(1)} is locked, ${cant}`;
  if (trouble === 'expired') return `The password of ${which} has expired, ${cant}`;
  return `The database refuses the password in its settings for ${which}, ${cant} Every attempt brings that account closer to being locked.`;
}

function accountProblem(trouble: AccountTrouble, users: string[], dbConnections: number | null, source: string): string {
  const left =
    dbConnections === null
      ? ' A restart or a busy moment will break it.'
      : dbConnections > 0
        ? ' It still works on the connections it already has; a restart or a busy moment will break it.'
        : ' It has no database connection open, so whatever needs that account fails.';
  const advice =
    trouble === 'locked'
      ? " Don't restart it before the account is unlocked: it would stop working completely."
      : trouble === 'expired'
        ? " Don't restart it before the password is renewed: it would stop working completely."
        : ' Fix the password in its settings before restarting it.';
  return `${troubleSentence(trouble, users)}${left}${source}${advice}`;
}

// A locked / expired account seen in another service's log -> what this service is told
function seenElsewhereProblems(elsewhere: SeenAccountError[], dbConnections: number | null, serverId?: number, skip = new Set<string>()): string[] {
  const out: string[] = [];
  const done = new Set(skip);
  for (const e of elsewhere) {
    const trouble = ACCOUNT_CODES[e.code];
    const key = `${e.user}|${trouble}`;
    if (!trouble || done.has(key)) continue;
    done.add(key);
    const where = serverId !== undefined && e.server_id !== serverId ? ` on ${e.server}` : '';
    const seen = atTime(localText(new Date(e.logged_at)), localText(new Date()));
    out.push(accountProblem(trouble, [e.user], dbConnections, ` Seen in the log of ${e.software}${where} ${seen} (${e.code}).`));
  }
  return out;
}

export interface HealthContext {
  // the accounts it signs in with, when they're known from elsewhere (WildFly: jboss-cli); a jar's are read from its
  // settings by the same command
  accounts?: DbAccount[];
  // locked / expired accounts seen in other services' logs (accountErrorsSeenElsewhere)
  elsewhere?: SeenAccountError[];
  // the server it runs on: an account seen in a log on another server says which
  serverId?: number;
  // "It's fixed": errors logged before are left out
  fixes?: Fixes;
}

// The accounts it signs in with: from `ctx` (WildFly), else from its settings as the command printed them
export function accountsOf(out: string, ctx: HealthContext = {}): DbAccount[] {
  return ctx.accounts ?? accountsFromConfig(sections(out).DBCONF ?? []);
}

// What the command printed -> problems (the service can't do its job) and a note. `artemisHere`: this server runs
// Artemis itself, so "nothing listens on Artemis's port" means it is down.
export function judgeHealth(def: SoftwareDefinition, out: string, artemisHere = false, ctx: HealthContext = {}): HealthResult {
  const s = sections(out);
  if (!('END' in s)) return { checked: false, problems: [], note: null, accounts: [], dbConnections: null, accountErrors: [] };
  const [owner, me] = (s.WHO ?? []).map((l) => l.trim());
  // no process, or another user's: its sockets are invisible without root, so no conclusion from them
  const visible = Boolean(owner) && owner !== '-' && (owner === me || me === '0');
  const hits = logHits(s.LOG ?? []);
  const now = (s.NOW ?? [])[0];
  const accounts = accountsOf(out, ctx);
  const conns = (s.CONN ?? []).map((l) => Number(l.trim())).filter(Boolean);
  const dbPort = env.databasePort;
  const dbConnections = visible ? conns.filter((p) => p === dbPort).length : null;
  const problems: string[] = [];

  // ---- its database accounts: errors in its own log since it started, not marked fixed since
  const accountErrors: HealthResult['accountErrors'] = [];
  const told = new Set<string>(); // "USER|trouble" already said
  const fixedService = ctx.fixes && ctx.serverId !== undefined ? ctx.fixes.service(ctx.serverId, def.id) : 0;
  const fixedAccount = (a: DbAccount) => Math.max(fixedService, ctx.fixes?.account(a) ?? 0);
  const loggedMs = (h: LogHit) => Date.parse(onOurClock(h.at!, now));
  for (const trouble of ['locked', 'expired', 'refused'] as AccountTrouble[]) {
    // pinned to an account: WildFly names the pool, a service with one account can only mean that one
    const pinned = new Map<string, { account: DbAccount; hit: LogHit }>();
    let unpinned: LogHit | undefined;
    for (const h of hits.filter((x) => x.at && ACCOUNT_CODES[x.code] === trouble)) {
      const a = h.pool ? accounts.find((x) => x.jndi === h.pool) : accounts.length === 1 ? accounts[0] : undefined;
      if (a && loggedMs(h) > fixedAccount(a)) pinned.set(`${a.user}@${a.db}`, { account: a, hit: h });
      else if (!a && loggedMs(h) > Math.max(fixedService, ...accounts.map(fixedAccount))) unpinned = h;
    }
    for (const { account, hit } of pinned.values()) {
      told.add(`${account.user}|${trouble}`);
      problems.push(accountProblem(trouble, [account.user], dbConnections, fromLog(hit, now)));
      accountErrors.push({ account, code: hit.code, text: hit.text, at: hit.at! });
    }
    if (unpinned && pinned.size === 0) {
      problems.push(accountProblem(trouble, [...new Set(accounts.map((a) => a.user))], dbConnections, fromLog(unpinned, now)));
      for (const a of accounts) told.add(`${a.user}|${trouble}`);
      // kept only for this service ("It's fixed" on it): another one can't tell it's about its account
      accountErrors.push({ account: { user: '', db: '' }, code: unpinned.code, text: unpinned.text, at: unpinned.at! });
    }
  }
  // ---- ... and in the logs of other services that sign in with the same account
  problems.push(...seenElsewhereProblems(ctx.elsewhere ?? [], dbConnections, ctx.serverId, told));
  const accountTrouble = problems.length > 0;

  if (visible) {
    const mqPort = artemisPort();
    // a locked / expired account already says why it has no connection
    if (def.needs_database && !conns.includes(dbPort) && !accountTrouble) problems.push(`It has no connection to the database (port ${dbPort}).${fromLog(last(hits, 'database'), now)}`);
    // A service that only sends now and then (balance-notification) connects when it has a message: no connection on
    // its own is fine. It's a problem when Artemis on this server is down, or its log reported a broker error lately.
    if (def.needs_artemis && !conns.includes(mqPort)) {
      const down = artemisHere && Number((s.MQHERE ?? [])[0] ?? 0) === 0;
      const lastError = last(hits, 'artemis');
      if (down) problems.push(`It can't reach Artemis: Artemis on this server isn't running (nothing listens on port ${mqPort}).${fromLog(lastError, now)}`);
      else if (lastError?.at && isRecent(lastError.at, now, NOTE_MINUTES)) problems.push(`It has no connection to Artemis (port ${mqPort}).${fromLog(lastError, now)}`);
    }
    const probes = (s.PROBE ?? []).filter((l) => /^\d+ /.test(l)).map((l) => l.trim().split(/\s+/));
    // a port that neither attempt reached: refused (7) or nothing came back in time (28)
    const dead = (p: string[]) => ['7', '28'].includes(p[2]) && ['7', '28'].includes(p[4]);
    if (probes.length > 0 && probes.every(dead)) {
      const ports = probes.map((p) => p[0]).join(', ');
      const timedOut = probes.some((p) => p[2] === '28' || p[4] === '28');
      problems.push(
        timedOut
          ? `It doesn't answer requests: nothing came back from port ${ports} within ${PROBE_TIMEOUT_S} seconds.`
          : `It doesn't answer requests: port ${ports} refused the connection.`,
      );
    }
  }
  let note: string | null = null;
  if (problems.length === 0) {
    const recent = [...hits].reverse().find((h) => h.at && isRecent(h.at, now, NOTE_MINUTES));
    if (recent)
      note = `Its log reported a ${recent.kind === 'artemis' ? 'broker' : 'database'} connection error at ${hhmm(recent.at)}: ${recent.text}`;
  }
  return { checked: visible || problems.length > 0, problems, note, accounts, dbConnections, accountErrors };
}

const last = (hits: LogHit[], kind: LogHit['kind']) => [...hits].reverse().find((h) => h.kind === kind);

// both on the server's clock, "YYYY-MM-DD HH:MM:SS"
function isRecent(at: string, now: string | undefined, minutes: number): boolean {
  if (!now) return false;
  const t = Date.parse(at.replace(' ', 'T'));
  const n = Date.parse(now.trim().replace(' ', 'T'));
  return Number.isFinite(t) && Number.isFinite(n) && n - t >= 0 && n - t <= minutes * 60_000;
}

// a time on the server's clock -> ISO on Healthcheck's, from the server's "now" in the same answer
function onOurClock(at: string, serverNow: string | undefined): string {
  const t = Date.parse(`${at.replace(' ', 'T')}Z`);
  const n = serverNow ? Date.parse(`${serverNow.trim().replace(' ', 'T')}Z`) : NaN;
  return new Date(Number.isFinite(t) && Number.isFinite(n) ? Date.now() - (n - t) : Date.now()).toISOString();
}

// `serverId`: its account errors are kept for the other services, and theirs are read.
export async function checkServiceHealth(
  client: Client,
  def: SoftwareDefinition,
  unit: string,
  artemisHere = false,
  where: { serverId?: number; accounts?: DbAccount[] } = {},
): Promise<HealthResult> {
  try {
    const res = await runCommand(client, `bash -c ${shQuote(healthCommand(def, unit))} 2>&1`, 60_000);
    const ctx: HealthContext = { accounts: where.accounts, serverId: where.serverId };
    if (where.serverId !== undefined) {
      ctx.fixes = loadFixes();
      ctx.elsewhere = accountErrorsSeenElsewhere(where.serverId, def.id, accountsOf(res.stdout, ctx), ctx.fixes);
    }
    const result = judgeHealth(def, res.stdout, artemisHere, ctx);
    if (where.serverId !== undefined && 'END' in sections(res.stdout)) {
      const now = (sections(res.stdout).NOW ?? [])[0];
      saveServiceAccounts(where.serverId, def.id, result.accounts);
      saveAccountErrors(where.serverId, def.id, result.accountErrors.map((e) => ({ account: e.account, code: e.code, text: e.text, loggedAt: onOurClock(e.at, now) })));
    }
    return result;
  } catch {
    return { checked: false, problems: [], note: null, accounts: [], dbConnections: null, accountErrors: [] };
  }
}

// The account errors its log pinned to an account, as the cause of a failing datasource: "the database account
// LOYALTY_CONF is locked (ORA-28000)". '' when there are none.
export function accountCause(errors: HealthResult['accountErrors']): string {
  const users = (trouble: AccountTrouble) => [...new Set(errors.filter((e) => e.account.user && ACCOUNT_CODES[e.code] === trouble).map((e) => e.account.user))];
  const and = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);
  const parts: string[] = [];
  const locked = users('locked');
  const expired = users('expired');
  const refused = users('refused');
  if (locked.length) parts.push(`the database account${locked.length > 1 ? 's' : ''} ${and(locked)} ${locked.length > 1 ? 'are' : 'is'} locked (ORA-28000)`);
  if (expired.length) parts.push(`the password of the database account${expired.length > 1 ? 's' : ''} ${and(expired)} has expired (ORA-28001)`);
  if (refused.length) parts.push(`the database refuses the password in its settings for ${and(refused)} (ORA-01017)`);
  return parts.join('; ');
}

// After every service of a check has been looked at: one that was judged before another service's log showed its
// account locked hears about it now. -> its problems, or none.
export function accountProblemsSeenLater(serverId: number, softwareId: number, accounts: DbAccount[], dbConnections: number | null): string[] {
  return seenElsewhereProblems(accountErrorsSeenElsewhere(serverId, softwareId, accounts), dbConnections, serverId);
}
