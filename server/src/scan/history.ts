// Service history: when each service started, stopped, restarted or crashed, and who did it - a Healthcheck run
// (and whose), a person in a terminal (their sudo line), systemd restarting it, or a server restart.
//
// Read at each check, each Check status and after each run, in one SSH command per server, one of two ways:
// - the journal (journal.ts), when the account Healthcheck signs in with may read it (on Rocky / RHEL members of
//   wheel or adm can, elsewhere systemd-journal): every start, stop and crash systemd logged, and who asked;
// - otherwise systemd's timestamps: `systemctl show` gives, per unit, when it last became active and inactive,
//   how its last run ended and how often it restarted itself; comparing with the previous read tells what
//   happened in between. Several stops and starts between two reads show as the latest ones, and who did it
//   in a terminal isn't known.
// The timestamps are read and kept either way, so switching from one to the other never invents events.
import type { Client } from 'ssh2';
import type { SoftwareDefinition, Server as ServerRow } from '@healthcheck/shared';
import { sqlite } from '../db/client.js';
import { env } from '../env.js';
import { runCommand } from '../ssh/exec.js';
import { getConnection } from '../ssh/connectionManager.js';
import { unitNames } from './detectors.js';
import { MSG, newBoot, newState, parseJournal, processJournal, type Ctx, type JEntry, type JState, type Sink, type Who } from './journal.js';

export type EventKind = 'started' | 'stopped' | 'crashed';
export type EventSource = 'healthcheck' | 'outside' | 'systemd' | 'reboot';

export interface UnitSnap {
  id: string;
  load: string;
  active: string;
  result: string;
  nRestarts: number;
  exitCode: number; // ExecMainCode: 1 exited, 2 killed, 3 dumped core
  exitStatus: number; // ExecMainStatus: exit code, or the signal number when killed
  activeEnter: number; // µs since boot, 0 = never
  inactiveEnter: number;
}

const PROPS = ['Id', 'LoadState', 'ActiveState', 'Result', 'NRestarts', 'ExecMainCode', 'ExecMainStatus', 'ActiveEnterTimestampMonotonic', 'InactiveEnterTimestampMonotonic'];
const shQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
// the journal names units in full ("artemis.service"); the catalog may leave ".service" out
const fullUnit = (u: string) => (/\.[a-z]+$/.test(u) ? u : `${u}.service`);

// boot_id changes only when the server restarts; btime (boot time on the clock) also moves when the clock is
// corrected, so it only converts times - it never decides "the server restarted".
export function historyCommand(units: string[]): string {
  return `grep '^btime ' /proc/stat; cat /proc/sys/kernel/random/boot_id; date +%s.%N; systemctl show ${units.map(shQuote).join(' ')} ${PROPS.map((p) => `-p ${p}`).join(' ')} 2>/dev/null`;
}

const UNIT_FIELDS = 'MESSAGE,MESSAGE_ID,JOB_TYPE,JOB_RESULT,UNIT,EXIT_CODE,EXIT_STATUS,UNIT_RESULT,N_RESTARTS';
const AUTH_FIELDS = 'MESSAGE,SYSLOG_IDENTIFIER,_PID';
const utc = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ');
// at most this many service lines per read (~300 bytes each): the newest are kept
const MAX_UNIT_LINES = 250_000;

// The journal part: whether it can be read, whether it survives a restart, Healthcheck's address as the server
// sees it, then systemd's lines about the services and the sudo / su / polkit / root ssh lines since the last
// read (times in UTC, so a clock change for summer time can't skip or repeat an hour).
export function journalCommand(units: string[], unitSince: number, authSince: number, first: boolean): string {
  const J = 'TZ=UTC journalctl -q --no-pager';
  // --output-fields (systemd 236+) keeps the lines short; older versions print every field. The cursor (always
  // printed, ~150 characters, not used) is cut off too: a server whose services crash in a loop logs ~10,000
  // lines an hour.
  const q = (match: string, since: number, fields: string) =>
    `{ ${J} ${match} --since '${utc(since)}' -o json --output-fields=${fields} 2>/dev/null || ${J} ${match} --since '${utc(since)}' -o json 2>/dev/null; } | sed -e 's/"__CURSOR":"[^"]*",//' -e 's/,"__CURSOR":"[^"]*"//'`;
  const units_ = units.map((u) => `UNIT=${shQuote(fullUnit(u))}`).join(' ');
  return [
    'echo "@@CAN $(journalctl -q -n 1 _PID=1 -o cat 2>/dev/null | wc -l)"',
    'echo "@@PERSIST $([ -d /var/log/journal ] && echo 1 || echo 0)"',
    'echo "@@ME ${SSH_CLIENT%% *}"',
    ...(first ? [`echo "@@OLDEST $(journalctl -q --no-pager -o short-unix 2>/dev/null | head -1 | cut -d' ' -f1)"`] : []),
    'echo @@UNITS',
    `${q(`_PID=1 ${units_}`, unitSince, UNIT_FIELDS)} | grep -v ${MSG.resources} | tail -n ${MAX_UNIT_LINES}`,
    'echo @@AUTH',
    `${q('SYSLOG_IDENTIFIER=sudo SYSLOG_IDENTIFIER=su SYSLOG_IDENTIFIER=polkitd SYSLOG_IDENTIFIER=sshd', authSince, AUTH_FIELDS)} | grep -E '"SYSLOG_IDENTIFIER":"(sudo|su|polkitd)"|root' | tail -n 20000`,
    // the server's clock as the output ends: compared with the moment it arrives
    'echo "@@CLOCK $(date +%s.%N)"',
    'echo @@END',
  ].join('; ');
}

export function parseJournalOutput(out: string) {
  const a = out.indexOf('\n@@UNITS\n');
  const b = out.indexOf('\n@@AUTH\n');
  const c = out.indexOf('\n@@END');
  const oldest = Number(/^@@OLDEST (\d+)/m.exec(out)?.[1] ?? NaN);
  return {
    can: Number(/^@@CAN (\d+)/m.exec(out)?.[1] ?? 0) > 0,
    persistent: /^@@PERSIST 1/m.test(out),
    me: /^@@ME (\S+)/m.exec(out)?.[1] ?? null,
    oldest: Number.isFinite(oldest) ? oldest : null,
    units: a >= 0 && b > a ? parseJournal(out.slice(a, b)) : ([] as JEntry[]),
    auth: b >= 0 && c > b ? parseJournal(out.slice(b, c)) : ([] as JEntry[]),
    complete: a >= 0 && b > a && c > b,
  };
}

// `date +%s.%N`: seconds, with the fraction where date knows %N (busybox prints "%N" as is)
function clockSeconds(s: string): number {
  const m = /^(\d{9,})(?:\.(\d+|%N))?$/.exec(s);
  return m ? Number(m[1]) + (m[2] && m[2] !== '%N' ? Number(`0.${m[2]}`) : 0) : NaN;
}

// The command's output: boot time, boot id and the server's clock (seconds), then one block per unit.
export function parseHistoryOutput(out: string): { bootTime: number; bootId: string | null; serverNow: number; units: UnitSnap[] } {
  const lines = out.split('\n');
  const bootTime = Number(/^btime (\d+)/m.exec(out)?.[1] ?? NaN);
  const bootId = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/m.exec(out)?.[1] ?? null;
  const serverNow = lines.map((l) => clockSeconds(l.trim())).find((n) => !Number.isNaN(n)) ?? NaN;
  const units: UnitSnap[] = [];
  let cur: Record<string, string> = {};
  const flush = () => {
    if (cur.Id) {
      units.push({
        id: cur.Id,
        load: cur.LoadState ?? '',
        active: cur.ActiveState ?? '',
        result: cur.Result ?? '',
        nRestarts: Number(cur.NRestarts ?? 0) || 0,
        exitCode: Number(cur.ExecMainCode ?? 0) || 0,
        exitStatus: Number(cur.ExecMainStatus ?? 0) || 0,
        activeEnter: Number(cur.ActiveEnterTimestampMonotonic ?? 0) || 0,
        inactiveEnter: Number(cur.InactiveEnterTimestampMonotonic ?? 0) || 0,
      });
    }
    cur = {};
  };
  for (const line of lines) {
    const i = line.indexOf('=');
    if (i > 0 && PROPS.includes(line.slice(0, i))) {
      const key = line.slice(0, i);
      if (key in cur) flush(); // a new unit's block started without a blank line
      cur[key] = line.slice(i + 1).trim();
    } else if (!line.trim()) flush();
  }
  flush();
  return { bootTime, bootId, serverNow, units };
}

interface Snapshot {
  unit: string;
  boot_id: string | null;
  boot_time: number;
  active_enter: number;
  inactive_enter: number;
  n_restarts: number;
  active: string;
}

export interface NewEvent {
  kind: EventKind;
  mono: number; // µs since boot (0 with a reboot: the boot itself)
  detail: string | null;
  automatic?: boolean; // systemd restarted it by itself
  reboot?: boolean;
}

const SIGNALS: Record<number, string> = { 1: 'SIGHUP', 2: 'SIGINT', 6: 'SIGABRT', 9: 'SIGKILL', 11: 'SIGSEGV', 15: 'SIGTERM' };
// Java (WildFly, Artemis, the Spring Boot backends) exits with 143 / 130 when asked to stop (128 + SIGTERM /
// SIGINT): systemd calls that "exit-code", but it's a normal stop.
const STOP_EXIT_CODES = new Set([130, 143]);

export function howItEnded(u: UnitSnap): string | null {
  if (u.result === 'success' && u.active !== 'failed') return null;
  if (u.exitCode === 1 && STOP_EXIT_CODES.has(u.exitStatus)) return null;
  if (u.exitCode === 1) return `exit code ${u.exitStatus}`;
  if (u.exitCode === 2 || u.exitCode === 3) return `killed by ${SIGNALS[u.exitStatus] ?? `signal ${u.exitStatus}`}${u.exitCode === 3 ? ', core dumped' : ''}`;
  return u.result && u.result !== 'success' ? u.result : null;
}

// What happened between the previous read and this one.
export function diff(prev: Snapshot | undefined, u: UnitSnap, bootTime: number, bootId: string | null): NewEvent[] {
  const running = u.active === 'active' || u.active === 'reloading' || u.active === 'deactivating';
  const ended = howItEnded(u);
  const stop = (mono: number, extra?: Partial<NewEvent>): NewEvent => ({ kind: ended && !running ? 'crashed' : 'stopped', mono, detail: running ? null : ended, ...extra });

  if (!prev) {
    // first read of this service: its latest change, so the history isn't empty
    if (u.activeEnter > u.inactiveEnter && u.activeEnter > 0) return [{ kind: 'started', mono: u.activeEnter, detail: null }];
    if (u.inactiveEnter > 0) return [stop(u.inactiveEnter)];
    return [];
  }
  // a restart is a new boot id (or, for a snapshot from before boot ids were kept, a boot time minutes away)
  const rebooted = prev.boot_id && bootId ? prev.boot_id !== bootId : Math.abs(prev.boot_time - bootTime) > 300;
  if (rebooted) {
    // the server restarted: whatever ran before went down with it
    const out: NewEvent[] = [];
    if (prev.active === 'active') out.push({ kind: 'stopped', mono: 0, detail: 'the server restarted', reboot: true });
    if (u.activeEnter > 0) {
      out.push({ kind: 'started', mono: u.activeEnter, detail: null });
      // ...and stopped again since the restart
      if (u.inactiveEnter > u.activeEnter) out.push(stop(u.inactiveEnter));
    }
    return out.sort((a, b) => a.mono - b.mono);
  }
  const out: NewEvent[] = [];
  const automatic = u.nRestarts > prev.n_restarts;
  if (u.inactiveEnter > prev.inactive_enter) {
    // it stopped and started again since: how the stop ended is gone (the new run reset it)
    const restartedSince = u.activeEnter > u.inactiveEnter;
    out.push(
      restartedSince
        ? { kind: automatic ? 'crashed' : 'stopped', mono: u.inactiveEnter, detail: automatic ? 'it stopped by itself' : null }
        : stop(u.inactiveEnter),
    );
  }
  if (u.activeEnter > prev.active_enter) {
    const times = u.nRestarts - prev.n_restarts;
    out.push({
      kind: 'started',
      mono: u.activeEnter,
      detail: automatic ? `restarted automatically by systemd${times > 1 ? ` (${times} times since the last check)` : ''}` : null,
      automatic,
    });
  }
  return out.sort((a, b) => a.mono - b.mono);
}

const iso = (ms: number) => new Date(ms).toISOString();

// The Healthcheck run that was starting, stopping or restarting this service on this server at that moment.
// (By its steps, not just "a run in the group": a Check status or a run on other services never counts.)
function runFor(serverId: number, softwareIds: number[], atMs: number): { id: number; kind: string; started_by: string | null } | undefined {
  if (softwareIds.length === 0) return undefined;
  return sqlite
    .prepare(
      `SELECT r.id, r.kind, r.started_by FROM job_steps s JOIN job_runs r ON r.id = s.job_run_id
       WHERE s.server_id = ? AND s.software_id IN (${softwareIds.map(() => '?').join(', ')}) AND s.action IN ('start', 'stop', 'restart')
         AND s.started_at <= ? AND s.started_at >= ? AND (s.finished_at IS NULL OR s.finished_at >= ?)
       ORDER BY s.id DESC LIMIT 1`,
    )
    .get(serverId, ...softwareIds, iso(atMs + 15_000), iso(atMs - 6 * 3600_000), iso(atMs - 15_000)) as
    | { id: number; kind: string; started_by: string | null }
    | undefined;
}

const watchedDefs = (server: ServerRow) =>
  sqlite
    .prepare("SELECT d.* FROM software_definitions d JOIN group_software g ON g.software_id = d.id WHERE g.group_id = ? AND d.detect_method = 'systemd'")
    .all(server.group_id) as unknown as SoftwareDefinition[];

interface StateRow {
  mode: string;
  state: string | null;
  persistent: number | null;
  updated_at: string;
}
const loadState = (serverId: number) => sqlite.prepare('SELECT * FROM history_state WHERE server_id = ?').get(serverId) as StateRow | undefined;
function journalState(row: StateRow | undefined): JState | null {
  if (row?.mode !== 'journal' || !row.state) return null;
  try {
    const st = JSON.parse(row.state) as JState;
    return st.v === 1 ? st : null;
  } catch {
    return null;
  }
}

// One read at a time per server: the check, Check status and the end of a run can come together.
const reading = new Map<number, Promise<unknown>>();
function oneAtATime<T>(serverId: number, fn: () => Promise<T>): Promise<T> {
  const next = (reading.get(serverId) ?? Promise.resolve()).catch(() => undefined).then(fn);
  reading.set(serverId, next);
  next
    .finally(() => {
      if (reading.get(serverId) === next) reading.delete(serverId);
    })
    .catch(() => undefined);
  return next;
}

// Read one server's service history and record what's new. Returns how many entries were added.
export function readServiceHistory(server: ServerRow, client?: Client): Promise<number> {
  return oneAtATime(server.id, async () => {
    const defs = watchedDefs(server);
    if (defs.length === 0) return 0;
    const units = [...new Set(defs.flatMap(unitNames))];
    const st = journalState(loadState(server.id));
    // the first journal read goes back as far as the history is kept
    const firstSince = Math.floor(Date.now() / 1000 - env.serviceHistoryDays * 86400);
    const unitSince = st?.unitUs ? Math.floor(st.unitUs / 1e6) : firstSince;
    const authSince = st?.authUs ? Math.floor(st.authUs / 1e6) : unitSince;
    const conn = client ?? (await getConnection(server as any));
    const sentAt = Date.now();
    const res = await runCommand(conn, `${historyCommand(units)}; ${journalCommand(units, unitSince, authSince, !st)}`, 90000);
    if (!/^btime /m.test(res.stdout)) throw new Error(`could not read the service history: ${res.stderr.trim() || 'no output'}`);
    return recordHistory(server, res.stdout, sentAt);
  });
}

const INSERT_EVENT = `INSERT OR IGNORE INTO service_events
  (server_id, software_id, at, kind, detail, source, actor, job_id, job_kind, boot_time, mono, recorded_at, origin, command, terminal, sessions, probable, count, until_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// The part after SSH: what the command printed -> new entries, snapshots and the journal position. sentAt: when
// the command was sent (the server's clock is read near its start).
export function recordHistory(server: ServerRow, output: string, sentAt = Date.now()): number {
  const arrived = Date.now();
  const cut = output.indexOf('@@CAN');
  const defs = watchedDefs(server);
  const { bootTime, bootId, serverNow, units } = parseHistoryOutput(cut >= 0 ? output.slice(0, cut) : output);
  if (!Number.isFinite(bootTime) || !Number.isFinite(serverNow)) throw new Error('could not read the service history: unexpected output');
  const journal = cut >= 0 ? parseJournalOutput(output.slice(Math.max(0, cut - 1))) : null;
  if (journal?.can && !journal.complete) throw new Error('could not read the service history: the journal read was cut off');
  // the server's clock may differ from this machine's: event times are moved onto this machine's clock. Its
  // clock at the end of the output, against when that arrived, isn't thrown off by a long read or by waiting
  // for an SSH channel; the one at the start is the fallback.
  const end = clockSeconds(/^@@CLOCK (\S+)/m.exec(output)?.[1] ?? '');
  const skewMs = Math.round(Number.isNaN(end) ? sentAt - serverNow * 1000 : arrived - end * 1000);
  const now = iso(Date.now());

  let added = 0;
  sqlite.exec('BEGIN');
  try {
    added += recordSnapshots(server, defs, units, bootTime, bootId, skewMs, !journal?.can);
    if (journal?.can) added += recordJournal(server, defs, journal, units, bootTime, bootId, skewMs);
    else sqlite.prepare("INSERT OR REPLACE INTO history_state (server_id, mode, state, persistent, updated_at) VALUES (?, 'snapshot', NULL, NULL, ?)").run(server.id, now);
    const cutoff = iso(Date.now() - env.serviceHistoryDays * 24 * 3600_000);
    sqlite.prepare('DELETE FROM service_events WHERE COALESCE(until_at, at) < ?').run(cutoff);
    sqlite.exec('COMMIT');
  } catch (err) {
    sqlite.exec('ROLLBACK');
    throw err;
  }
  return added;
}

// systemd's timestamps: always kept; turned into entries only when the journal can't be read.
function recordSnapshots(server: ServerRow, defs: SoftwareDefinition[], units: UnitSnap[], bootTime: number, bootId: string | null, skewMs: number, makeEvents: boolean): number {
  const toMs = (mono: number) => bootTime * 1000 + mono / 1000 + skewMs;
  const byId = new Map(units.map((u) => [u.id, u]));
  const getSnap = sqlite.prepare('SELECT * FROM service_snapshots WHERE server_id = ? AND software_id = ?');
  const putSnap = sqlite.prepare(
    'INSERT OR REPLACE INTO service_snapshots (server_id, software_id, unit, boot_id, boot_time, active_enter, inactive_enter, n_restarts, active, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const addEvent = sqlite.prepare(INSERT_EVENT);
  let added = 0;
  for (const def of defs) {
    // a catalog entry can list alternative unit names: the one that exists here (running one first)
    const found = unitNames(def)
      .map((n) => byId.get(n) ?? byId.get(fullUnit(n)))
      .filter((u): u is UnitSnap => Boolean(u && u.load && u.load !== 'not-found'));
    const u = found.find((x) => x.active === 'active') ?? found[0];
    if (!u) continue;
    const prev = getSnap.get(server.id, def.id) as Snapshot | undefined;
    if (makeEvents) {
      for (const e of diff(prev?.unit === u.id ? prev : undefined, u, bootTime, bootId)) {
        const atMs = e.reboot ? bootTime * 1000 + skewMs : toMs(e.mono);
        const run = e.automatic || e.reboot ? undefined : runFor(server.id, [def.id], atMs);
        const source: EventSource = e.reboot ? 'reboot' : run ? 'healthcheck' : e.automatic ? 'systemd' : 'outside';
        // Healthcheck asked it to stop (Stop / Restart, one or all): an odd exit code on the way down isn't a crash
        if (e.kind === 'crashed' && run && /^(stop|restart)_/.test(run.kind)) {
          e.detail = e.detail && e.detail !== 'it stopped by itself' ? `it ended with ${e.detail}` : null;
          e.kind = 'stopped';
        }
        const r = addEvent.run(
          server.id,
          def.id,
          iso(atMs),
          e.kind,
          e.detail,
          source,
          run?.started_by ?? null,
          run?.id ?? null,
          run?.kind ?? null,
          bootTime,
          e.mono,
          iso(Date.now()),
          'snapshot',
          null,
          null,
          null,
          null,
          null,
          null,
        );
        added += Number(r.changes);
      }
    }
    putSnap.run(server.id, def.id, u.id, bootId, bootTime, u.activeEnter, u.inactiveEnter, u.nRestarts, u.active, iso(Date.now()));
  }
  return added;
}

function recordJournal(
  server: ServerRow,
  defs: SoftwareDefinition[],
  journal: ReturnType<typeof parseJournalOutput>,
  live: UnitSnap[],
  bootTime: number,
  bootId: string | null,
  skewMs: number,
): number {
  const row = loadState(server.id);
  let st = journalState(row);
  if (!st) {
    // first journal read for this server: it covers what the timestamps had recorded since the journal's start,
    // with the people behind each - those entries go, the journal's take their place
    const from = journal.oldest ? iso(journal.oldest * 1000 + skewMs) : '';
    sqlite.prepare("DELETE FROM service_events WHERE server_id = ? AND (origin IS NULL OR origin = 'snapshot') AND at >= ?").run(server.id, from);
    st = newState();
  }

  const unitDefs = new Map<string, number[]>();
  for (const def of defs) for (const u of unitNames(def)) unitDefs.set(fullUnit(u), [...(unitDefs.get(fullUnit(u)) ?? []), def.id]);
  const toIso = (us: number) => iso(us / 1000 + skewMs);
  const insert = sqlite.prepare(INSERT_EVENT);
  const upd = sqlite.prepare(
    'UPDATE service_events SET count = COALESCE(?, count), until_at = COALESCE(?, until_at), detail = CASE WHEN ? THEN ? ELSE detail END, source = COALESCE(?, source) WHERE id = ?',
  );
  const del = sqlite.prepare('DELETE FROM service_events WHERE id = ?');
  const now = iso(Date.now());
  let added = 0;
  const sink: Sink = {
    add(e) {
      const rows: number[] = [];
      const w: Who = e.who;
      const sessions = w.sessions?.length ? JSON.stringify(w.sessions.map((s) => ({ user: s.user, how: s.how, tty: s.tty, since: toIso(s.since) }))) : null;
      for (const softwareId of unitDefs.get(e.unit) ?? []) {
        const r = insert.run(
          server.id,
          softwareId,
          toIso(e.us),
          e.kind,
          e.detail,
          w.source,
          w.actor ?? null,
          w.jobId ?? null,
          w.jobKind ?? null,
          Math.round((e.us - e.mono) / 1e6),
          e.mono,
          now,
          'journal',
          w.command ?? null,
          w.terminal ?? null,
          sessions,
          w.probable ? 1 : null,
          e.count ?? null,
          e.untilUs ? toIso(e.untilUs) : null,
        );
        if (Number(r.changes)) rows.push(Number(r.lastInsertRowid));
      }
      added += rows.length;
      return rows;
    },
    update(rows, p) {
      for (const id of rows) upd.run(p.count ?? null, p.untilUs ? toIso(p.untilUs) : null, p.detail !== undefined ? 1 : 0, p.detail ?? null, p.source ?? null, id);
    },
    remove(rows) {
      for (const id of rows) added -= Number(del.run(id).changes);
    },
  };
  const ctx: Ctx = {
    sshUser: server.ssh_username,
    myAddress: journal.me,
    runFor: (unit, us) => runFor(server.id, unitDefs.get(unit) ?? [], us / 1000 + skewMs),
  };

  processJournal(st, journal.units, journal.auth, ctx, sink);
  // restarted with nothing logged since (or its journal didn't survive the restart): what ran went down with it
  if (bootId && st.boot && st.boot.replace(/-/g, '') !== bootId.replace(/-/g, '')) newBoot(st, bootTime * 1e6, ctx, sink);
  if (bootId) st.boot = bootId.replace(/-/g, '');
  // what systemd says now settles what's running (the first read starts with no idea)
  for (const u of live) if (unitDefs.has(u.id) && u.load !== 'not-found') (st.units[u.id] ??= {}).active = u.active === 'active' || u.active === 'reloading';

  sqlite
    .prepare("INSERT OR REPLACE INTO history_state (server_id, mode, state, persistent, updated_at) VALUES (?, 'journal', ?, ?, ?)")
    .run(server.id, JSON.stringify(st), journal.persistent ? 1 : 0, now);
  return added;
}

// After a Healthcheck run: record its starts and stops right away, while the run is fresh.
export function readHistoryForGroup(groupId: number | null) {
  if (groupId == null) return;
  const servers = sqlite.prepare('SELECT * FROM servers WHERE group_id = ?').all(groupId) as unknown as ServerRow[];
  for (const s of servers) readServiceHistory(s).catch((err) => console.error(`Service history for ${s.name} failed:`, err?.message ?? err));
}
