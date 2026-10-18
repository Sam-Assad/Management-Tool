// Crash alerts: a service that had been running fine (up CRASH_RUNNING_FINE_MINUTES or more) and now keeps
// crashing - CRASH_ALERT_COUNT crashes in a row, systemd restarting it each time. Only that case: crashes soon after
// a start (the server starting up, a start from a terminal or from Healthcheck) never raise one, and Healthcheck's
// own starts already deal with their crashes. Healthcheck never stops the service: the alert says how many times,
// why (the error from its log, in plain words where possible) and how the server looks (disk, memory).
//
// Built from the service history after every read of it (each background check, Check status, run, and the hourly
// crash check): journal.ts already groups a run of crashes into one "Kept crashing" entry, with how long the
// service had been running before the first one. Needs the journal (servers read from systemd's timestamps only
// don't know the separate crashes).
import path from 'node:path';
import type { Client } from 'ssh2';
import type { SoftwareDefinition, Server as ServerRow } from '@healthcheck/shared';
import { sqlite } from '../db/client.js';
import { env } from '../env.js';
import { runCommand } from '../ssh/exec.js';
import { unitNames } from './detectors.js';
import { CREDENTIAL_EXPIRED_RE } from './wildfly.js';
import { PORT_CONFLICT_RE } from './ports.js';

export type CrashState = 'crashing' | 'gave_up' | 'over';

export interface CrashFacts {
  disks: { mount: string; sizeKb: number; availKb: number; usedPct: number }[];
  memory: { totalKb: number; availableKb: number } | null;
  oom: string[]; // the kernel killing processes for lack of memory, since the crashes began
}

const iso = (ms: number) => new Date(ms).toISOString();
// a fresh look at the log, disk and memory at most this often while it keeps crashing
const LOOK_EVERY_MS = 10 * 60_000;

interface RunRow {
  id: number;
  software_id: number;
  at: string;
  kind: string;
  count: number | null;
  until_at: string | null;
  ran_for_s: number | null;
  detail: string | null;
}
interface After {
  kind: string;
  source: string;
  actor: string | null;
  job_kind: string | null;
  at: string;
}

// How a run of crashes stands now: still crashing, systemd gave up on it (down, needs a person), or over (someone
// stopped / started it, or it has been running fine again for CRASH_RUNNING_FINE_MINUTES).
function stateOf(serverId: number, run: RunRow, lastMs: number, nowMs: number): { state: CrashState; endedAt: string | null; endedHow: string | null } {
  const after = sqlite
    .prepare(
      `SELECT kind, source, actor, job_kind, at FROM service_events
       WHERE server_id = ? AND software_id = ? AND at > ? AND id != ? AND kind NOT IN ('enabled', 'disabled', 'masked', 'unmasked', 'reloaded')
       ORDER BY at, id LIMIT 20`,
    )
    .all(serverId, run.software_id, iso(lastMs), run.id) as unknown as After[];
  // systemd's own restarts belong to the run
  const next = after.filter((e) => !(e.kind === 'started' && e.source === 'systemd'));
  const first = next[0];
  const by = (e: After) =>
    e.source === 'healthcheck'
      ? `${e.kind} in Healthcheck${e.actor ? ` by ${e.actor}` : ''}`
      : e.source === 'terminal'
        ? `${e.kind} by ${e.actor} in a terminal`
        : e.source === 'reboot' || e.source === 'boot'
          ? 'the server restarted'
          : `${e.kind} outside Healthcheck`;
  if (first?.kind === 'start_failed' && first.source === 'systemd') {
    const then = next[1];
    return then ? { state: 'over', endedAt: then.at, endedHow: by(then) } : { state: 'gave_up', endedAt: null, endedHow: null };
  }
  if (first && (first.kind === 'crashed' || first.kind === 'crash_loop')) return { state: 'over', endedAt: first.at, endedHow: 'crashed again later (a new run)' };
  if (first) return { state: 'over', endedAt: first.at, endedHow: by(first) };
  // nothing since: running again for a while (it's up now), or still crashing
  const live = sqlite.prepare('SELECT active FROM service_snapshots WHERE server_id = ? AND software_id = ?').get(serverId, run.software_id) as
    | { active: string }
    | undefined;
  if (live?.active === 'active' && nowMs - lastMs >= env.crashRunningFineMinutes * 60_000) {
    return { state: 'over', endedAt: iso(lastMs + env.crashRunningFineMinutes * 60_000), endedHow: 'running fine again' };
  }
  return { state: 'crashing', endedAt: null, endedHow: null };
}

// Which runs of crashes deserve an alert, and how each stands now (database only). Returns the alerts still open.
export function evaluateCrashes(serverId: number, nowMs = Date.now()): number[] {
  const fineS = env.crashRunningFineMinutes * 60;
  const runs = sqlite
    .prepare(
      `SELECT id, software_id, at, kind, count, until_at, ran_for_s, detail FROM service_events
       WHERE server_id = ? AND origin = 'journal' AND (kind = 'crash_loop' OR (kind = 'crashed' AND source = 'itself')) AND COALESCE(until_at, at) >= ?
       ORDER BY at`,
    )
    .all(serverId, iso(nowMs - env.serviceHistoryDays * 86_400_000)) as unknown as RunRow[];
  const find = sqlite.prepare('SELECT id, state FROM crash_alerts WHERE server_id = ? AND software_id = ? AND first_crash_at = ?');
  const insert = sqlite.prepare(
    `INSERT INTO crash_alerts (server_id, software_id, first_crash_at, last_crash_at, count, ran_for_s, state, detail, ended_at, ended_how, opened_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = sqlite.prepare(
    'UPDATE crash_alerts SET last_crash_at = ?, count = ?, ran_for_s = ?, state = ?, detail = ?, ended_at = ?, ended_how = ?, updated_at = ? WHERE id = ?',
  );
  const open: number[] = [];
  for (const run of runs) {
    const count = run.kind === 'crash_loop' ? (run.count ?? 2) : 1;
    // too few, or right after a start (the server starting up, a start from a terminal or Healthcheck): not this alert
    if (count < env.crashAlertCount) continue;
    if (run.ran_for_s !== null && run.ran_for_s < fineS) continue;
    const lastMs = new Date(run.until_at ?? run.at).getTime();
    const { state, endedAt, endedHow } = stateOf(serverId, run, lastMs, nowMs);
    const row = find.get(serverId, run.software_id, run.at) as { id: number; state: string } | undefined;
    let id: number;
    if (row) {
      update.run(iso(lastMs), count, run.ran_for_s, state, run.detail, endedAt, endedHow, iso(nowMs), row.id);
      id = row.id;
    } else {
      if (state === 'over') continue; // over before it was ever seen: the history says it all
      id = Number(insert.run(serverId, run.software_id, run.at, iso(lastMs), count, run.ran_for_s, state, run.detail, endedAt, endedHow, iso(nowMs), iso(nowMs)).lastInsertRowid);
    }
    if (state !== 'over') open.push(id);
  }
  sqlite.prepare('DELETE FROM crash_alerts WHERE last_crash_at < ?').run(iso(nowMs - env.serviceHistoryDays * 86_400_000));
  return open;
}

// ---- why: the service's last error, and how the server looks ----------------------------------------------

const shQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

export function lookCommand(logPath: string | null, unit: string, sinceHours: number): string {
  const dirs = ['/', '/Data', '/var', '/tmp', ...(logPath ? [path.posix.dirname(logPath)] : [])];
  return [
    'echo @@LOG',
    logPath ? `tail -n 400 ${shQuote(logPath)} 2>/dev/null | cut -c1-500` : 'true',
    'echo @@OUT',
    // what the service itself printed, for one that writes to the journal instead of a file
    `journalctl -q --no-pager _SYSTEMD_UNIT=${shQuote(unit)} -n 200 -o cat 2>/dev/null | cut -c1-500`,
    'echo @@DF',
    `df -P -k ${[...new Set(dirs)].map(shQuote).join(' ')} 2>/dev/null`,
    'echo @@MEM',
    "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo",
    'echo @@OOM',
    `journalctl -q --no-pager -k --since '-${Math.max(1, Math.min(72, Math.ceil(sinceHours)))}h' 2>/dev/null | grep -iE 'out of memory|oom-kill|killed process' | tail -n 5 | cut -c1-300`,
    'echo @@END',
  ].join('; ');
}

function sections(out: string): Record<string, string> {
  const parts: Record<string, string> = {};
  let name = '';
  for (const line of out.split('\n')) {
    const m = /^@@([A-Z]+)$/.exec(line.trim());
    if (m) name = m[1];
    else if (name) parts[name] = parts[name] === undefined ? line : `${parts[name]}\n${line}`;
  }
  return parts;
}

export function parseFacts(out: string): CrashFacts {
  const s = sections(out);
  const disks: CrashFacts['disks'] = [];
  for (const line of (s.DF ?? '').split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6 || !/^\d+$/.test(f[1])) continue;
    const mount = f.slice(5).join(' ');
    if (disks.some((d) => d.mount === mount)) continue;
    disks.push({ mount, sizeKb: Number(f[1]), availKb: Number(f[3]), usedPct: Number(f[4].replace('%', '')) });
  }
  const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(s.MEM ?? '')?.[1] ?? NaN);
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  return {
    disks,
    memory: Number.isFinite(total) && Number.isFinite(available) ? { totalKb: total, availableKb: available } : null,
    oom: (s.OOM ?? '').split('\n').map((l) => l.trim()).filter(Boolean),
  };
}

// The service's last error in its log: from the last line that starts an error (ERROR / FATAL / SEVERE, Spring
// Boot's "APPLICATION FAILED TO START", an uncaught exception) to the end, the stack trace cut down to what says
// why (its first frames and every "Caused by"). Null when the log has no error at all.
export function lastErrorBlock(text: string): string | null {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const HEAD = /\b(ERROR|FATAL|SEVERE|CRITICAL)\b|APPLICATION FAILED TO START|Exception in thread/;
  const EXC = /^\S*(Exception|Error)\b:?/;
  let i = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (HEAD.test(lines[k])) {
    i = k;
    break;
  }
  if (i < 0) for (let k = lines.length - 1; k >= 0; k--) if (EXC.test(lines[k])) {
    i = k;
    break;
  }
  if (i < 0) return null;
  // Spring Boot puts the process id on every line ("... ERROR 2585301 --- [main] ..."): the crash's first ERROR
  // of that process starts the block (often the real reason, e.g. the database pool failing before the rest)
  const pid = /\s(?:ERROR|FATAL)\s+(\d+)\s+---\s/.exec(lines[i])?.[1];
  if (pid) {
    const sameRun = new RegExp(`\\s(?:ERROR|FATAL)\\s+${pid}\\s+---\\s`);
    for (let k = i - 1; k >= Math.max(0, i - 400); k--) if (sameRun.test(lines[k])) i = k;
  }
  const out: string[] = [];
  let frames = 0;
  for (const line of lines.slice(i)) {
    if (/^\s+at /.test(line)) {
      frames++;
      if (frames <= 2) out.push(line);
      else if (frames === 3) out.push('\t...');
      continue;
    }
    if (/^\s+\.\.\. \d+ (more|common frames omitted)/.test(line)) continue;
    frames = 0;
    out.push(line);
  }
  // the end matters most: the last "Caused by" is usually the real reason
  const kept = out.length > 60 ? [...out.slice(0, 20), '\t...', ...out.slice(-38)] : out;
  return kept.join('\n').slice(0, 8000);
}

// Why it keeps crashing, in plain words, from its error, how it ended and how the server looks.
export function plainReason(error: string | null, detail: string | null, facts: CrashFacts): string {
  const text = error ?? '';
  if (/ran out of memory and killed it/.test(detail ?? '') || facts.oom.length > 0) return 'It runs out of memory, and the server kills it.';
  if (/OutOfMemoryError/.test(text)) return 'Java runs out of memory (OutOfMemoryError).';
  const full = facts.disks.find((d) => d.usedPct >= 98);
  if (/No space left on device/i.test(text) || full) return `The disk is full${full ? ` (${full.mount})` : ''}.`;
  if (CREDENTIAL_EXPIRED_RE.test(text)) return 'The database password has expired.';
  if (/password authentication failed|Access denied for user|ORA-01017|invalid username\/password|Login failed for user/i.test(text))
    return 'The database refuses its user name or password.';
  if (PORT_CONFLICT_RE.test(text)) {
    const port = /\bport\s*:?\s*(\d{2,5})\b/i.exec(text)?.[1];
    return `Its port${port ? ` ${port}` : ''} is already used by another program.`;
  }
  if (
    /ORA-12541|ORA-12514|ORA-12170|Communications link failure|Connection refused|UnknownHostException|No route to host|connect timed out|Connection timed out|Could not open JDBC Connection|Unable to acquire JDBC Connection|AMQ219007|Cannot connect to server/i.test(
      text,
    )
  )
    return "It can't connect to something it needs: the database, Artemis or another service.";
  if (/ClassNotFoundException|NoClassDefFoundError|UnsupportedClassVersionError|Unable to access jarfile|Invalid or corrupt jarfile|Could not find or load main class/i.test(text))
    return 'Its program files are missing or broken, or it needs a different Java version.';
  if (/Permission denied|AccessDeniedException/i.test(text)) return "It isn't allowed to read or write a file it needs.";
  if (/FileNotFoundException|NoSuchFileException|No such file or directory/i.test(text)) return 'A file it needs is missing.';
  const ends = detail ? `It ends with ${detail}.` : 'It ends with an error.';
  return error ? `${ends} The error from its log is below.` : `${ends} Its log shows no error lines.`;
}

// Read the open alerts' service logs, disk and memory, and write down why.
export async function checkCrashes(server: ServerRow, client: Client, nowMs = Date.now()): Promise<void> {
  const mode = (sqlite.prepare('SELECT mode FROM history_state WHERE server_id = ?').get(server.id) as { mode: string } | undefined)?.mode;
  if (mode !== 'journal') return;
  const open = evaluateCrashes(server.id, nowMs);
  for (const id of open) {
    const a = sqlite.prepare('SELECT * FROM crash_alerts WHERE id = ?').get(id) as any;
    if (a.looked_at && nowMs - new Date(a.looked_at).getTime() < LOOK_EVERY_MS) continue;
    const def = sqlite.prepare('SELECT * FROM software_definitions WHERE id = ?').get(a.software_id) as unknown as SoftwareDefinition | undefined;
    if (!def) continue;
    const snapUnit = (sqlite.prepare('SELECT unit FROM service_snapshots WHERE server_id = ? AND software_id = ?').get(server.id, def.id) as { unit: string } | undefined)?.unit;
    const unit = snapUnit ?? unitNames(def)[0];
    const sinceHours = (nowMs - new Date(a.first_crash_at).getTime()) / 3_600_000 + 1;
    const res = await runCommand(client, lookCommand(def.log_path || null, unit, sinceHours), 30000);
    const s = sections(res.stdout);
    const error = lastErrorBlock(s.LOG ?? '') ?? lastErrorBlock(s.OUT ?? '');
    const facts = parseFacts(res.stdout);
    let reason = plainReason(error, a.detail, facts);
    // nothing known in the error block: the rest of the log's last lines may still say it (an earlier line of the
    // same crash, cut off from the block)
    if (reason.startsWith('It ends with')) {
      const wider = plainReason(`${s.LOG ?? ''}\n${s.OUT ?? ''}`, a.detail, facts);
      if (!wider.startsWith('It ends with')) reason = wider;
    }
    sqlite.prepare('UPDATE crash_alerts SET reason = ?, excerpt = ?, facts = ?, looked_at = ? WHERE id = ?').run(reason, error, JSON.stringify(facts), iso(nowMs), id);
  }
}
