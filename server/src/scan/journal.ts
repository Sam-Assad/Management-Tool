// Service history from the server's journal: every start, stop, restart and crash systemd logged for each
// service, and who asked for it - the person whose sudo (or polkit) line ran the command, a Healthcheck run,
// systemd itself, or a server restart.
//
// Read in pieces: each read picks up after the last line the previous one handled, carrying what was half seen
// (a stop asked for but not finished, a restart waiting for its start, open root shells, the last minutes of
// commands) in JState. Nothing here touches SSH or the database: history.ts feeds lines in and stores what
// comes out, so this can be tested with lines copied from a real server.

// systemd's message ids (sd-messages.h); older versions without some ids are matched by their text
export const MSG = {
  starting: '7d4958e842da4a758f6c1cdc7b36dcc5',
  started: '39f53479d3a045ac8e11786248231fbf',
  failed: 'be02cf6855d2428ba40df7e9d022f03d',
  stopping: 'de5b426a63be47a7b6ac3eaac82e2f6f',
  stopped: '9d1aaa27d60140bd96365438aad20286',
  reloading: 'd34d037fff1847e6ae669a370e694725',
  reloaded: '7b05ebc668384222baa8881179cfda54',
  exit: '98e322203f7a4ed290d09fe03c09fe15',
  result: 'd9b373ed55a64feb8242e02dbe79a49c',
  success: '7ad2d189f7e94e70a38c781354912448',
  restartScheduled: '5eb03494b6584870a536b337290809b3',
  resources: 'ae8f7b866b0347b9af31fe1c80b127c0',
};

export interface JEntry {
  us: number; // __REALTIME_TIMESTAMP: µs, on the server's clock
  mono: number; // __MONOTONIC_TIMESTAMP: µs since that boot
  boot: string;
  unit?: string;
  ident?: string; // SYSLOG_IDENTIFIER
  pid?: number;
  msgId?: string;
  jobType?: string;
  jobResult?: string;
  exitCode?: string; // exited / killed / dumped
  exitStatus?: number; // the exit code, or the signal number
  unitResult?: string;
  nRestarts?: number;
  message: string;
}

const field = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    // a field logged twice comes as a list; a message that isn't valid UTF-8 as a list of bytes
    if (v.every((x) => typeof x === 'number')) return String.fromCharCode(...(v as number[]));
    return typeof v[0] === 'string' ? v[0] : undefined;
  }
  return undefined;
};
const num = (v: unknown): number | undefined => {
  const s = field(v);
  return s === undefined || s === '' || !Number.isFinite(Number(s)) ? undefined : Number(s);
};

// `journalctl -o json` output: one JSON object per line
export function parseJournal(text: string): JEntry[] {
  const out: JEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // cut off
    }
    const us = num(o.__REALTIME_TIMESTAMP);
    if (us === undefined) continue;
    out.push({
      us,
      mono: num(o.__MONOTONIC_TIMESTAMP) ?? 0,
      boot: field(o._BOOT_ID) ?? '',
      unit: field(o.UNIT),
      ident: field(o.SYSLOG_IDENTIFIER),
      pid: num(o._PID),
      msgId: field(o.MESSAGE_ID),
      jobType: field(o.JOB_TYPE),
      jobResult: field(o.JOB_RESULT),
      exitCode: field(o.EXIT_CODE),
      exitStatus: num(o.EXIT_STATUS),
      unitResult: field(o.UNIT_RESULT),
      nRestarts: num(o.N_RESTARTS),
      message: field(o.MESSAGE) ?? '',
    });
  }
  return out;
}

type LineKind =
  | 'starting'
  | 'started'
  | 'start_failed'
  | 'stopping'
  | 'stopped'
  | 'reloading'
  | 'reloaded'
  | 'exit'
  | 'result'
  | 'success'
  | 'restart_scheduled';

function classify(e: JEntry): LineKind | null {
  switch (e.msgId) {
    case MSG.starting:
      return 'starting';
    case MSG.started:
      return 'started';
    case MSG.failed:
      return 'start_failed';
    case MSG.stopping:
      return 'stopping';
    case MSG.stopped:
      return 'stopped';
    case MSG.reloading:
      return 'reloading';
    case MSG.reloaded:
      return 'reloaded';
    case MSG.exit:
      return 'exit';
    case MSG.result:
      return 'result';
    case MSG.success:
      return 'success';
    case MSG.restartScheduled:
      return 'restart_scheduled';
    case MSG.resources:
      return null;
  }
  const m = e.message;
  if (/Main process exited, code=/.test(m)) return 'exit';
  if (/Failed with result '/.test(m)) return 'result';
  if (/Scheduled restart job/.test(m)) return 'restart_scheduled';
  if (/: (Deactivated successfully|Succeeded)\.$/.test(m)) return 'success';
  if (/^Starting /.test(m)) return 'starting';
  if (/^Started /.test(m)) return 'started';
  if (/^Failed to start /.test(m)) return 'start_failed';
  if (/^Stopping /.test(m)) return 'stopping';
  if (/^Stopped /.test(m)) return 'stopped';
  return null;
}

// ---- who did it -------------------------------------------------------------------------------------------

// A command someone ran with sudo, or that polkit let a non-root user run (systemctl without sudo).
export interface Cmd {
  us: number;
  user: string;
  tty: string | null;
  command: string;
  via: 'sudo' | 'polkit';
}

// A root shell open at the moment, for "outside Healthcheck, not through sudo": the likely candidates.
export interface Session {
  user: string;
  how: string;
  tty: string | null;
  since: number; // µs
}

export type Source = 'healthcheck' | 'terminal' | 'outside' | 'systemd' | 'itself' | 'reboot' | 'boot';

export interface Who {
  source: Source;
  actor?: string | null;
  jobId?: number | null;
  jobKind?: string | null;
  command?: string | null;
  terminal?: string | null;
  sessions?: Session[] | null;
  probable?: boolean;
}

// "sam : TTY=pts/0 ; PWD=/home/sam ; USER=root ; COMMAND=/bin/systemctl start artemis.service". Refusals
// ("3 incorrect password attempts ; TTY=..", "command not allowed ; ..") have text before TTY/PWD: they don't
// match, so they never count as having run.
const SUDO_RE = /^\s*(\S+) : (?:TTY=(\S+) ; )?PWD=[^;]* ; USER=\S+ ; (?:[A-Z]+=[^;]* ; )*COMMAND=(.+)$/;
// "... [systemctl stop artemis.service] (owned by unix-user:sam)"
const POLKIT_RE = /\[(.+)\] \(owned by unix-user:([^)]+)\)/;
const SHELLS = new Set(['su', 'bash', 'sh', 'zsh', 'ksh', 'csh', 'tcsh', 'fish']);

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const normUnit = (u: string) => (/\.[a-z]+$/.test(u) ? u : `${u}.service`);

// What a systemctl (or `service`) command does to which units.
export function systemctlAction(command: string): { verb: string; units: string[] } | null {
  const words = command.trim().split(/\s+/);
  const i = words.findIndex((w) => base(w) === 'systemctl');
  if (i >= 0) {
    const args = words.slice(i + 1);
    const plain = args.filter((w) => !w.startsWith('-'));
    const [verb, ...units] = plain;
    if (!verb) return null;
    const now = args.includes('--now') && ['enable', 'disable', 'mask'].includes(verb);
    return { verb: now ? `${verb}-now` : verb, units: units.map(normUnit) };
  }
  const j = words.findIndex((w) => base(w) === 'service');
  if (j >= 0 && words[j + 2]) return { verb: words[j + 2], units: [normUnit(words[j + 1])] };
  return null;
}

// Which verbs cause a systemd job of this type.
const CAUSES: Record<'start' | 'stop' | 'restart' | 'reload', string[]> = {
  start: ['start', 'restart', 'try-restart', 'condrestart', 'reload-or-restart', 'try-reload-or-restart', 'force-reload', 'enable-now'],
  stop: ['stop', 'restart', 'try-restart', 'condrestart', 'reload-or-restart', 'try-reload-or-restart', 'force-reload', 'disable-now', 'mask-now', 'kill'],
  restart: ['restart', 'try-restart', 'condrestart', 'reload-or-restart', 'try-reload-or-restart', 'force-reload'],
  reload: ['reload', 'reload-or-restart', 'try-reload-or-restart', 'force-reload'],
};

// how the command reads in the history: the path dropped, "sudo " in front when it went through sudo
function commandText(c: Cmd): string {
  const words = c.command.trim().split(/\s+/);
  words[0] = base(words[0]);
  return `${c.via === 'sudo' ? 'sudo ' : ''}${words.join(' ')}`.slice(0, 300);
}

// ---- state carried between reads ---------------------------------------------------------------------------

interface UnitState {
  active?: boolean;
  // a job systemd began (Starting / Stopping / Reloading) and who asked for it
  begin?: { us: number; type: 'start' | 'stop' | 'restart' | 'reload'; who: Who };
  exit?: { code: string; status: number }; // how the process ended during a stop or start
  result?: string; // systemd's verdict line ("Failed with result 'oom-kill'")
  ended?: { us: number; mono: number; code: string; status: number; result?: string }; // it ended, unasked
  sched?: number; // systemd scheduled an automatic restart (its restart counter)
  restarting?: { us: number; who: Who; detail: string | null }; // a restart's stop done, its start to come
  lastStop?: { rows: number[]; us: number; who: Who }; // to make a Healthcheck Restart's stop + start one entry
  lastCrash?: { rows: number[]; us: number; mono: number; detail: string | null };
  cycle?: { rows: number[]; crashUs: number; crashMono: number; startUs: number }; // crash + automatic restart
  loop?: { rows: number[]; count: number; lastUs: number }; // "kept crashing" (several cycles close together)
}

export interface JState {
  v: 1;
  boot: string | null;
  unitUs: number; // the newest service line handled
  authUs: number; // the newest sudo / su / polkit / sshd line handled
  units: Record<string, UnitState>;
  recent: Cmd[]; // commands from the last minutes
  sessions: Record<string, Session>; // open root shells, by how they were opened + pid
  sshPending: Record<string, string>; // sshd pid -> address of a root login whose session hasn't opened yet
  outsideStops: { rows: number[]; us: number }[]; // recent stops nobody asked for: relabelled if a reboot follows
}

export const newState = (): JState => ({ v: 1, boot: null, unitUs: 0, authUs: 0, units: {}, recent: [], sessions: {}, sshPending: {}, outsideStops: [] });

// ---- what comes out ----------------------------------------------------------------------------------------

export type Kind =
  | 'started'
  | 'stopped'
  | 'restarted'
  | 'crashed'
  | 'start_failed'
  | 'crash_loop'
  | 'reloaded'
  | 'enabled'
  | 'disabled'
  | 'masked'
  | 'unmasked';

export interface Emit {
  unit: string;
  kind: Kind;
  us: number;
  mono: number;
  detail: string | null;
  who: Who;
  count?: number;
  untilUs?: number;
}

export interface Ctx {
  sshUser: string; // the account Healthcheck signs in with: its sudo lines without a terminal are Healthcheck's
  myAddress: string | null; // Healthcheck's address as the server sees it (its own root logins aren't "root shells")
  // the Healthcheck run (start / stop / restart) that was handling this service at that moment, if any
  runFor(unit: string, us: number): { id: number; kind: string; started_by: string | null } | undefined;
}

export interface Sink {
  add(e: Emit): number[]; // the rows written (one per catalog entry using the unit)
  update(rows: number[], patch: { count?: number; untilUs?: number; detail?: string | null; source?: Source }): void;
  remove(rows: number[]): void;
}

const MIN = 60_000_000;
const COMMAND_WINDOW = 30_000_000; // a command counts for a job systemd began up to 30 s later
const LOOP_GAP = 10 * MIN; // crashes closer together than this are one "kept crashing" entry
const BOOT_WINDOW = 15 * MIN; // a start nobody asked for this soon after boot is the server starting up
const RECENT_KEEP = 15 * MIN;

const SIGNALS: Record<number, string> = { 1: 'SIGHUP', 2: 'SIGINT', 6: 'SIGABRT', 9: 'SIGKILL', 11: 'SIGSEGV', 15: 'SIGTERM' };
// Java (WildFly, Artemis, the Spring Boot backends) exits with 143 / 130 when asked to stop (128 + SIGTERM / SIGINT)
const STOP_EXIT_CODES = new Set([130, 143]);

const RESULT_TEXT: Record<string, string> = {
  'oom-kill': 'the server ran out of memory and killed it',
  watchdog: 'it stopped responding (watchdog)',
  timeout: "it didn't finish in time",
  'core-dump': 'it crashed and dumped core',
  'start-limit-hit': 'systemd gave up: it failed too many times in a row',
  resources: "systemd couldn't set it up (missing files, user or permissions)",
  dependency: "something it needs didn't start",
};

function exitText(code: string, status: number): string | null {
  if (code === 'exited') return status === 0 ? null : `exit code ${status}`;
  if (code === 'killed' || code === 'dumped') return `killed by ${SIGNALS[status] ?? `signal ${status}`}${code === 'dumped' ? ', core dumped' : ''}`;
  return null;
}
const normalStop = (code: string, status: number) =>
  (code === 'exited' && (status === 0 || STOP_EXIT_CODES.has(status))) || (code === 'killed' && (status === 15 || status === 2));

function downFor(us: number): string {
  const s = Math.max(0, Math.round(us / 1e6));
  if (s < 90) return `down for ${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `down for ${m} min` : `down for ${Math.round(m / 6) / 10} h`;
}

// ---- the reader --------------------------------------------------------------------------------------------

export function processJournal(st: JState, unitLines: JEntry[], authLines: JEntry[], ctx: Ctx, sink: Sink): void {
  const items = [
    ...unitLines.filter((e) => e.us > st.unitUs && e.unit).map((e) => ({ e, auth: false })),
    ...authLines.filter((e) => e.us > st.authUs).map((e) => ({ e, auth: true })),
  ].sort((a, b) => a.e.us - b.e.us || Number(b.auth) - Number(a.auth)); // a command before what it caused
  for (const { e, auth } of items) {
    if (e.boot && st.boot && e.boot !== st.boot) newBoot(st, e.us - e.mono, ctx, sink);
    if (e.boot) st.boot = e.boot;
    if (auth) {
      onAuth(st, e, ctx, sink);
      st.authUs = e.us;
      if (st.recent.length > 2000) st.recent = st.recent.filter((c) => c.us > e.us - RECENT_KEEP);
    } else {
      onUnit(st, e, ctx, sink);
      st.unitUs = e.us;
    }
  }
  for (const [unit, s] of Object.entries(st.units)) flushEnded(st, unit, s, ctx, sink);
  const newest = Math.max(st.unitUs, st.authUs);
  st.recent = st.recent.filter((c) => c.us > newest - RECENT_KEEP);
  st.outsideStops = st.outsideStops.filter((o) => o.us > newest - 10 * MIN);
}

// The server restarted (bootStartUs = when, on its clock). What was running went down with it; stops nobody
// asked for in its last minutes were the shutdown.
export function newBoot(st: JState, bootStartUs: number, ctx: Ctx, sink: Sink): void {
  const lastOld = Math.max(st.unitUs, st.authUs);
  for (const o of st.outsideStops) if (o.us >= lastOld - 5 * MIN) sink.update(o.rows, { source: 'reboot' });
  for (const [unit, s] of Object.entries(st.units)) {
    if (s.active) sink.add({ unit, kind: 'stopped', us: bootStartUs, mono: 0, detail: null, who: { source: 'reboot' } });
    st.units[unit] = { active: false };
  }
  st.recent = [];
  st.sessions = {};
  st.sshPending = {};
  st.outsideStops = [];
}

function onAuth(st: JState, e: JEntry, ctx: Ctx, sink: Sink) {
  const m = e.message;
  const pid = e.pid ?? 0;
  if (e.ident === 'sudo') {
    const c = SUDO_RE.exec(m);
    if (c) {
      const cmd: Cmd = { us: e.us, user: c[1], tty: c[2] && c[2] !== 'unknown' ? c[2] : null, command: c[3].trim(), via: 'sudo' };
      st.recent.push(cmd);
      const words = cmd.command.split(/\s+/);
      if (SHELLS.has(base(words[0]))) {
        st.sessions[`sudo:${pid}`] = { user: cmd.user, how: `sudo ${[base(words[0]), ...words.slice(1)].join(' ')}`.slice(0, 80), tty: cmd.tty, since: e.us };
      }
      unitFileChange(st, cmd, e, ctx, sink);
    } else if (/session closed for user root/.test(m)) delete st.sessions[`sudo:${pid}`];
    return;
  }
  if (e.ident === 'su') {
    const o = /session opened for user root\b.*? by (\S*?)\(uid=\d+\)/.exec(m);
    if (o?.[1]) st.sessions[`su:${pid}`] = { user: o[1], how: 'su', tty: null, since: e.us };
    else if (/session closed for user root/.test(m)) delete st.sessions[`su:${pid}`];
    return;
  }
  if (e.ident === 'polkitd') {
    const p = POLKIT_RE.exec(m);
    if (p && /authenticated|authorized/i.test(m)) {
      const cmd: Cmd = { us: e.us, user: p[2], tty: null, command: p[1].trim(), via: 'polkit' };
      st.recent.push(cmd);
      unitFileChange(st, cmd, e, ctx, sink);
    }
    return;
  }
  if (e.ident === 'sshd') {
    const a = /^Accepted \S+ for root from (\S+)/.exec(m);
    if (a) {
      if (a[1] !== ctx.myAddress) st.sshPending[String(pid)] = a[1];
    } else if (/session opened for user root/.test(m) && st.sshPending[String(pid)]) {
      st.sessions[`ssh:${pid}`] = { user: 'root', how: `ssh as root from ${st.sshPending[String(pid)]}`, tty: null, since: e.us };
      delete st.sshPending[String(pid)];
    } else if (/session closed for user root/.test(m)) delete st.sessions[`ssh:${pid}`];
  }
}

// enable / disable / mask / unmask: systemd logs nothing for these, only the command line shows them
function unitFileChange(st: JState, cmd: Cmd, e: JEntry, ctx: Ctx, sink: Sink) {
  const a = systemctlAction(cmd.command);
  if (!a) return;
  const kind = ({ enable: 'enabled', 'enable-now': 'enabled', disable: 'disabled', 'disable-now': 'disabled', mask: 'masked', 'mask-now': 'masked', unmask: 'unmasked' } as const)[
    a.verb as 'enable'
  ];
  if (!kind) return;
  // (units Healthcheck doesn't watch write nothing)
  for (const unit of a.units) sink.add({ unit, kind, us: e.us, mono: e.mono, detail: null, who: whoFromCommand(cmd, unit, e.us, ctx) });
}

function whoFromCommand(cmd: Cmd, unit: string, us: number, ctx: Ctx, probable = false): Who {
  if (cmd.user === ctx.sshUser && !cmd.tty) {
    const run = ctx.runFor(unit, us);
    if (run) return { source: 'healthcheck', actor: run.started_by, jobId: run.id, jobKind: run.kind };
  }
  return { source: 'terminal', actor: cmd.user, command: commandText(cmd), terminal: cmd.tty, probable };
}

const openSessions = (st: JState, us: number): Session[] =>
  Object.values(st.sessions)
    .filter((s) => s.since <= us)
    .filter((s, i, all) => all.findIndex((x) => x.user === s.user && x.how === s.how) === i);

// Who asked for a job systemd began at this line.
function resolve(st: JState, e: JEntry, unit: string, type: 'start' | 'stop' | 'restart' | 'reload', ctx: Ctx): Who {
  for (let i = st.recent.length - 1; i >= 0; i--) {
    const c = st.recent[i];
    if (c.us < e.us - COMMAND_WINDOW) break; // oldest last
    if (c.us > e.us + 1_000_000) continue;
    const a = systemctlAction(c.command);
    if (a && a.units.includes(unit) && CAUSES[type].includes(a.verb)) return whoFromCommand(c, unit, e.us, ctx);
  }
  const run = ctx.runFor(unit, e.us);
  if (run) return { source: 'healthcheck', actor: run.started_by, jobId: run.id, jobKind: run.kind };
  if (type === 'start' && e.mono < BOOT_WINDOW) return { source: 'boot' };
  const sessions = openSessions(st, e.us);
  return { source: 'outside', sessions: sessions.length ? sessions : null };
}

function emit(sink: Sink, unit: string, kind: Kind, e: { us: number; mono: number }, detail: string | null, who: Who, extra?: Partial<Emit>) {
  return sink.add({ unit, kind, us: e.us, mono: e.mono, detail, who, ...extra });
}

// The process ended without anyone asking it to stop: a crash, or it finished by itself.
function flushEnded(st: JState, unit: string, s: UnitState, ctx: Ctx, sink: Sink) {
  const x = s.ended;
  if (!x) return;
  s.ended = undefined;
  const normal = normalStop(x.code, x.status) && !(x.result && x.result !== 'success' && x.result !== 'exit-code' && x.result !== 'signal');
  const detail =
    (x.result && RESULT_TEXT[x.result]) ||
    (x.code === 'exited' && x.status === 0
      ? 'it finished by itself (exit code 0)'
      : normal
        ? `it got a stop signal from outside systemd, for example kill (${exitText(x.code, x.status) ?? 'SIGTERM'})`
        : exitText(x.code, x.status));
  // someone killed it: `systemctl kill` for this unit, or a kill / pkill / killall just before
  let who: Who = { source: 'itself' };
  for (let i = st.recent.length - 1; i >= 0; i--) {
    const c = st.recent[i];
    if (c.us < x.us - 10_000_000) break;
    if (c.us > x.us + 1_000_000) continue;
    const a = systemctlAction(c.command);
    if (a?.verb === 'kill' && a.units.includes(unit)) {
      who = whoFromCommand(c, unit, x.us, ctx);
      break;
    }
    if (['kill', 'pkill', 'killall'].includes(base(c.command.split(/\s+/)[0]))) {
      who = whoFromCommand(c, unit, x.us, ctx, true);
      break;
    }
  }
  s.active = false;
  s.lastCrash = undefined;
  if (who.source === 'itself' && !normal) {
    // crashing again soon after systemd restarted it: counted in one "kept crashing" entry
    if (s.loop && x.us - s.loop.lastUs <= LOOP_GAP) {
      s.loop.count += 1;
      s.loop.lastUs = x.us;
      sink.update(s.loop.rows, { count: s.loop.count, untilUs: x.us, detail });
      return;
    }
    if (s.cycle && x.us - s.cycle.startUs <= LOOP_GAP) {
      sink.remove(s.cycle.rows);
      const rows = emit(sink, unit, 'crash_loop', { us: s.cycle.crashUs, mono: s.cycle.crashMono }, detail, { source: 'systemd' }, { count: 2, untilUs: x.us });
      s.loop = { rows, count: 2, lastUs: x.us };
      s.cycle = undefined;
      return;
    }
  }
  s.loop = s.cycle = undefined;
  const rows = emit(sink, unit, normal ? 'stopped' : 'crashed', x, detail, who);
  s.lastCrash = { rows, us: x.us, mono: x.mono, detail };
}

function onUnit(st: JState, e: JEntry, ctx: Ctx, sink: Sink) {
  const unit = e.unit!;
  const s = (st.units[unit] ??= {});
  const k = classify(e);
  if (!k) return;
  // the verdict that follows a process ending is the only line allowed between the end and the flush
  if (k !== 'result' && k !== 'exit') flushEnded(st, unit, s, ctx, sink);
  switch (k) {
    case 'starting':
      if (s.sched === undefined && !s.restarting) s.begin = { us: e.us, type: 'start', who: resolve(st, e, unit, 'start', ctx) };
      break;
    case 'stopping': {
      const type = e.jobType === 'restart' ? 'restart' : 'stop';
      s.begin = { us: e.us, type, who: resolve(st, e, unit, type, ctx) };
      s.exit = undefined;
      s.result = undefined;
      break;
    }
    case 'reloading':
      s.begin = { us: e.us, type: 'reload', who: resolve(st, e, unit, 'reload', ctx) };
      break;
    case 'reloaded':
      emit(sink, unit, 'reloaded', e, e.jobResult && e.jobResult !== 'done' ? `it didn't work (${e.jobResult})` : null, s.begin?.type === 'reload' ? s.begin.who : resolve(st, e, unit, 'reload', ctx));
      s.begin = undefined;
      break;
    case 'exit': {
      const code = e.exitCode ?? /code=(\w+)/.exec(e.message)?.[1] ?? 'exited';
      const status = e.exitStatus ?? Number(/status=(\d+)/.exec(e.message)?.[1] ?? 0);
      // ended while a stop or start was under way: part of that; otherwise nobody asked
      if (s.begin) s.exit = { code, status };
      else {
        flushEnded(st, unit, s, ctx, sink);
        s.ended = { us: e.us, mono: e.mono, code, status };
      }
      break;
    }
    case 'result':
      if (s.ended) s.ended.result = e.unitResult ?? /result '([^']+)'/.exec(e.message)?.[1];
      else s.result = e.unitResult ?? /result '([^']+)'/.exec(e.message)?.[1];
      break;
    case 'success':
      // finished cleanly with nobody asking (no "Main process exited" line for a clean exit)
      if (!s.begin && s.active !== false) {
        s.ended = { us: e.us, mono: e.mono, code: 'exited', status: 0 };
        flushEnded(st, unit, s, ctx, sink);
      }
      break;
    case 'restart_scheduled':
      s.sched = e.nRestarts ?? Number(/counter is at (\d+)/.exec(e.message)?.[1] ?? 0);
      break;
    case 'stopped': {
      if (s.sched !== undefined) {
        // the stop half of systemd's automatic restart: the crash before it is the news
        s.active = false;
        break;
      }
      const who = s.begin?.who ?? resolve(st, e, unit, e.jobType === 'restart' ? 'restart' : 'stop', ctx);
      const odd = s.exit && !normalStop(s.exit.code, s.exit.status) ? exitText(s.exit.code, s.exit.status) : null;
      const detail = (s.result && RESULT_TEXT[s.result]) || (odd ? `it ended with ${odd}` : null);
      const beganUs = s.begin?.us ?? e.us;
      if (e.jobType === 'restart' || s.begin?.type === 'restart') s.restarting = { us: beganUs, who, detail };
      else {
        const rows = emit(sink, unit, 'stopped', e, detail, who);
        s.lastStop = { rows, us: beganUs, who };
        if (who.source === 'outside') st.outsideStops.push({ rows, us: e.us });
      }
      s.begin = s.exit = s.result = undefined;
      s.loop = s.cycle = s.lastCrash = undefined;
      s.active = false;
      break;
    }
    case 'started': {
      if (s.sched !== undefined) automaticStart(s, unit, e, sink);
      else if (s.restarting) {
        const r = s.restarting;
        emit(sink, unit, 'restarted', e, [r.detail, downFor(e.us - r.us)].filter(Boolean).join('; '), r.who);
      } else {
        const who = s.begin?.type === 'start' ? s.begin.who : resolve(st, e, unit, 'start', ctx);
        const ls = s.lastStop;
        // Healthcheck's Restart is a stop and a start: one "Restarted"
        if (ls && who.source === 'healthcheck' && ls.who.jobId === who.jobId && /^restart/.test(who.jobKind ?? '')) {
          sink.remove(ls.rows);
          emit(sink, unit, 'restarted', e, downFor(e.us - ls.us), who);
        } else emit(sink, unit, 'started', e, null, who);
        s.loop = s.cycle = undefined;
      }
      s.begin = s.exit = s.result = s.sched = s.restarting = s.lastStop = s.lastCrash = undefined;
      s.active = true;
      break;
    }
    case 'start_failed': {
      const auto = s.sched !== undefined;
      const who: Who = auto ? { source: 'systemd' } : s.begin?.type === 'start' ? s.begin.who : s.restarting?.who ?? resolve(st, e, unit, 'start', ctx);
      const why =
        (s.result && RESULT_TEXT[s.result]) ||
        (e.jobResult && e.jobResult !== 'failed' && RESULT_TEXT[e.jobResult]) ||
        (s.exit ? exitText(s.exit.code, s.exit.status) : null) ||
        (s.lastCrash?.detail ?? null);
      const when = s.restarting ? 'while restarting' : auto && s.result !== 'start-limit-hit' ? 'when systemd tried to restart it' : null;
      emit(sink, unit, 'start_failed', e, [when, why].filter(Boolean).join(': ') || null, who);
      s.begin = s.exit = s.result = s.sched = s.restarting = s.lastStop = s.lastCrash = undefined;
      s.loop = s.cycle = undefined;
      s.active = false;
      break;
    }
  }
}

// systemd restarted it by itself after it ended. One such restart is two entries (the crash, "restarted
// automatically"); crashing again soon after turns them into one "kept crashing" entry (see flushEnded) that
// counts the crashes, and the restarts in between only move its end.
function automaticStart(s: UnitState, unit: string, e: JEntry, sink: Sink) {
  const crash = s.lastCrash;
  const n = s.sched;
  if (s.loop) {
    s.loop.lastUs = e.us;
    sink.update(s.loop.rows, { untilUs: e.us });
  } else {
    const rows = emit(sink, unit, 'started', e, `systemd restarted it automatically${n ? ` (restart ${n} since the server started)` : ''}`, { source: 'systemd' });
    s.cycle = { rows: [...(crash?.rows ?? []), ...rows], crashUs: crash?.us ?? e.us, crashMono: crash?.mono ?? e.mono, startUs: e.us };
  }
  s.lastCrash = undefined;
}
