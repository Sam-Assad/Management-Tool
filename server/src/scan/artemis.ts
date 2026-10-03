import type { Client } from 'ssh2';
import type { SoftwareDefinition } from '@healthcheck/shared';
import { runCommand } from '../ssh/exec.js';
import { sqlite, insertRow } from '../db/client.js';
import { env } from '../env.js';

// ---- Artemis report, after each start/restart ---------------------------------------------------------
// Once Artemis is up (its log said "Server is now live"), one SSH command gathers what the operator is shown:
//  - how many messages sit in DLQ and ExpiryQueue (`artemis queue stat`, the broker's own CLI);
//  - the heap it uses out of the heap it's given (`jcmd <pid> GC.heap_info`, and -Xmx from its command line);
//  - warnings/errors it logged since this start - matched on Artemis's AMQ message codes, which appear the
//    same whatever the log layout (plain text or JSON).
// The broker's instance folder is read from its running process (-Dartemis.instance=...), so nothing here is
// per market; env.artemisInstance is only the fallback.

export interface ArtemisReport {
  // false = couldn't gather anything useful: `note` says why
  checked: boolean;
  dlq: number | null;
  expiry: number | null;
  heapUsedBytes: number | null;
  heapMaxBytes: number | null;
  heapPercent: number | null;
  // logged since this start: AMQ222xxx are warnings, AMQ224xxx errors
  logWarnings: number;
  logErrors: number;
  lastLogProblem?: string;
  tone: 'info' | 'warning' | 'danger';
  // what didn't work, in plain words (each part is optional - the rest is still reported)
  notes: string[];
}

export function isArtemis(def: SoftwareDefinition): boolean {
  return /artemis/i.test(def.name) || (def.detect_method === 'systemd' && /artemis/i.test(def.detect_value));
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const MARK = '@@HCA@@';

export function splitSections(output: string): Map<string, string> {
  const sections = new Map<string, string>();
  let key: string | null = null;
  let buf: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(new RegExp(`^${MARK} (\\S+)\\s*$`));
    if (m) {
      if (key) sections.set(key, buf.join('\n'));
      key = m[1];
      buf = [];
    } else if (key) buf.push(line);
  }
  return sections;
}

// `artemis queue stat` table:  |NAME |ADDRESS |CONSUMER_COUNT|MESSAGE_COUNT|... -> name -> message count.
// Names longer than the column are cut ("activemq.management.20..."); DLQ and ExpiryQueue are short.
export function parseQueueStat(output: string): Map<string, number> {
  const counts = new Map<string, number>();
  let nameCol = -1;
  let countCol = -1;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.includes('NAME') && cells.includes('MESSAGE_COUNT')) {
      nameCol = cells.indexOf('NAME');
      countCol = cells.indexOf('MESSAGE_COUNT');
      continue;
    }
    if (nameCol < 0) continue;
    const count = Number(cells[countCol]);
    if (cells[nameCol] && Number.isFinite(count)) counts.set(cells[nameCol], count);
  }
  return counts;
}

// `jcmd <pid> GC.heap_info`: every heap generation's "total NK, used NK" (G1 has one line, Parallel/Serial
// several); Metaspace and class space are not heap.
export function parseHeapInfo(output: string): { usedBytes: number; totalBytes: number } | null {
  let used = 0;
  let total = 0;
  let found = false;
  for (const line of output.split(/\r?\n/)) {
    if (/metaspace|class space/i.test(line)) continue;
    const m = line.match(/total\s+(\d+)K,\s*used\s+(\d+)K/);
    if (m) {
      total += Number(m[1]) * 1024;
      used += Number(m[2]) * 1024;
      found = true;
    }
  }
  return found ? { usedBytes: used, totalBytes: total } : null;
}

// "-Xmx4G" / "-Xmx3072m" / "-Xmx2147483648" -> bytes (the JVM uses the last one given)
export function parseXmx(args: string): number | null {
  const all = [...args.matchAll(/-Xmx(\d+)([kKmMgGtT]?)\b/g)];
  if (!all.length) return null;
  const [, n, unit] = all[all.length - 1];
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[unit.toLowerCase() as '' | 'k' | 'm' | 'g' | 't'];
  return Number(n) * mult;
}

// "uintx MaxHeapSize = 4294967296" (jcmd VM.flags -all / -XX:MaxHeapSize=...) when there's no -Xmx
function parseMaxHeapFlag(output: string): number | null {
  const m = output.match(/MaxHeapSize\s*(?:=|:=)\s*(\d+)/) ?? output.match(/-XX:MaxHeapSize=(\d+)/);
  return m ? Number(m[1]) : null;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes % 1024 ** 3 === 0 ? 0 : 1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

// `unit`: its systemd unit, whose main PID is the broker. Without one, the broker is the process running
// "...boot.Artemis run" - matched as [b]oot so the search can't find its own shell, whose command line holds
// the pattern too (a CLI `artemis queue stat` also carries -Dartemis.instance=, so that's no help either).
export async function checkArtemis(client: Client, logPath?: string | null, unit?: string): Promise<ArtemisReport> {
  const report: ArtemisReport = {
    checked: false,
    dlq: null,
    expiry: null,
    heapUsedBytes: null,
    heapMaxBytes: null,
    heapPercent: null,
    logWarnings: 0,
    logErrors: 0,
    tone: 'warning',
    notes: [],
  };
  const password = env.artemisPassword;
  const hide = (text: string) => (password ? text.split(password).join('****') : text);

  const logScan = logPath
    ? // from the end of the log back to this start's first line ("...is starting" / "waiting ... live lock")
      `if [ -r ${shQuote(logPath)} ]; then SINCE=$(tac ${shQuote(logPath)} | awk '{print} /AMQ221000|AMQ221034/{exit}' | tac); ` +
      `echo "warnings=$(printf '%s\\n' "$SINCE" | grep -cE 'AMQ222[0-9]{3}') errors=$(printf '%s\\n' "$SINCE" | grep -cE 'AMQ224[0-9]{3}')"; ` +
      `printf '%s\\n' "$SINCE" | grep -E 'AMQ22[24][0-9]{3}' | tail -1 | cut -c1-300; else echo "unreadable"; fi`
    : 'echo "no log path"';

  const script = [
    unit ? `PID=$(systemctl show -p MainPID --value ${shQuote(unit)} 2>/dev/null); [ "$PID" = "0" ] && PID=""` : 'PID=""',
    // a unit whose main process is a wrapper shell: the broker is its java child
    `if [ -n "$PID" ] && [ "$(ps -o comm= -p "$PID" 2>/dev/null)" != "java" ]; then C=$(pgrep -P "$PID" java | head -1); [ -n "$C" ] && PID=$C; fi`,
    `[ -n "$PID" ] || PID=$(pgrep -f '[b]oot[.]Artemis run' | head -1)`,
    `INST=$(ps -o args= -p "$PID" 2>/dev/null | grep -oE 'artemis.instance=[^ ]+' | head -1 | cut -d= -f2)`,
    `[ -n "$INST" ] || INST=${shQuote(env.artemisInstance)}`,
    `echo ${MARK} pid; echo "$PID"; echo "$INST"`,
    `echo ${MARK} args; ps -o args= -p "$PID" 2>/dev/null | tr ' ' '\\n' | grep -E '^-Xmx|^-XX:MaxHeapSize='`,
    `JCMD=$(command -v jcmd || echo "$(dirname "$(readlink -f /proc/$PID/exe 2>/dev/null)")/jcmd")`,
    `echo ${MARK} heap; [ -n "$PID" ] && timeout 30 "$JCMD" "$PID" GC.heap_info 2>&1 | head -12`,
    `echo ${MARK} flags; if [ -n "$PID" ] && ! ps -o args= -p "$PID" | grep -qE -- '-Xmx|MaxHeapSize'; then timeout 30 "$JCMD" "$PID" VM.flags 2>&1 | tr ' ' '\\n' | grep MaxHeapSize; fi`,
    `echo ${MARK} queues; timeout 60 "$INST/bin/artemis" queue stat --user ${shQuote(env.artemisUser)} --password ${shQuote(password)} --url ${shQuote(env.artemisUrl)} --maxRows 1000 2>&1; echo "exit=$?"`,
    `echo ${MARK} log; ${logScan}`,
    `echo ${MARK} END`,
  ].join('\n');

  let sections: Map<string, string>;
  try {
    const res = await runCommand(client, `bash -c ${shQuote(script)} 2>&1`, 150_000);
    sections = splitSections(hide(`${res.stdout}\n${res.stderr}`));
  } catch (err: any) {
    report.notes.push(`Couldn't read Artemis's details: ${hide(String(err?.message ?? err)).slice(0, 200)}`);
    return report;
  }

  const [pid] = (sections.get('pid') ?? '').trim().split('\n');
  if (!pid?.trim()) report.notes.push("Couldn't find the running Artemis process, so its memory wasn't read.");

  // ---- memory
  const heap = parseHeapInfo(sections.get('heap') ?? '');
  const max = parseXmx(sections.get('args') ?? '') ?? parseMaxHeapFlag(sections.get('args') ?? '') ?? parseMaxHeapFlag(sections.get('flags') ?? '') ?? heap?.totalBytes ?? null;
  if (heap && max) {
    report.heapUsedBytes = heap.usedBytes;
    report.heapMaxBytes = max;
    report.heapPercent = Math.round((heap.usedBytes / max) * 1000) / 10;
  } else if (pid?.trim()) {
    report.notes.push(`Couldn't read Artemis's memory (jcmd): ${(sections.get('heap') ?? '').trim().split('\n')[0]?.slice(0, 160) || 'no answer'}`);
  }

  // ---- queues
  const queueText = sections.get('queues') ?? '';
  const counts = parseQueueStat(queueText);
  if (counts.size > 0) {
    report.dlq = counts.get('DLQ') ?? 0;
    report.expiry = counts.get('ExpiryQueue') ?? 0;
  } else {
    const exit = queueText.match(/exit=(\d+)/)?.[1];
    const why =
      exit === '124'
        ? 'the broker did not answer within 60 s'
        : /AMQ229031|Unable to validate user|security/i.test(queueText)
          ? `the login was refused${password ? '' : ' (ARTEMIS_PASSWORD is not set in .env)'}`
          : queueText.replace(/exit=\d+/, '').trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 160) || 'no answer';
    report.notes.push(`Couldn't read the queues: ${why}.`);
  }

  // ---- log since this start
  const logText = (sections.get('log') ?? '').trim();
  const lc = logText.match(/warnings=(\d+) errors=(\d+)/);
  if (lc) {
    report.logWarnings = Number(lc[1]);
    report.logErrors = Number(lc[2]);
    const last = logText.split('\n').slice(1).join(' ').trim();
    if (last && (report.logWarnings || report.logErrors)) report.lastLogProblem = last;
  }

  report.checked = report.dlq !== null || report.heapPercent !== null;
  report.tone =
    report.heapPercent !== null && report.heapPercent >= env.artemisMemoryDangerPercent
      ? 'danger'
      : !report.checked || report.notes.length > 0 || report.logErrors > 0
        ? 'warning'
        : 'info';
  return report;
}

// ---- kept readings ------------------------------------------------------------------------------------
// 'beat' = the scheduled check, 'start' = right after Healthcheck started it, 'manual' = Check now.
export type ArtemisSource = 'beat' | 'start' | 'manual';

export interface ArtemisCheck {
  server_id: number;
  software_id: number;
  source: ArtemisSource;
  checked_at: string;
  report: ArtemisReport;
}

const KEEP_DAYS = 30;

export function saveArtemisCheck(serverId: number, softwareId: number, source: ArtemisSource, report: ArtemisReport): ArtemisCheck {
  const checked_at = new Date().toISOString();
  insertRow('artemis_checks', { server_id: serverId, software_id: softwareId, source, tone: report.tone, report: JSON.stringify(report), checked_at });
  const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 3600 * 1000).toISOString();
  sqlite.prepare('DELETE FROM artemis_checks WHERE checked_at < ?').run(cutoff);
  return { server_id: serverId, software_id: softwareId, source, checked_at, report };
}

export function latestArtemisCheck(serverId: number, softwareId?: number): ArtemisCheck | null {
  const row = (
    softwareId === undefined
      ? sqlite.prepare('SELECT * FROM artemis_checks WHERE server_id = ? ORDER BY id DESC LIMIT 1').get(serverId)
      : sqlite.prepare('SELECT * FROM artemis_checks WHERE server_id = ? AND software_id = ? ORDER BY id DESC LIMIT 1').get(serverId, softwareId)
  ) as { server_id: number; software_id: number; source: ArtemisSource; checked_at: string; report: string } | undefined;
  return row ? { ...row, report: JSON.parse(row.report) } : null;
}

// A reading for a broker that isn't running: nothing to read, said plainly.
export function notRunningReport(): ArtemisReport {
  return {
    checked: false,
    dlq: null,
    expiry: null,
    heapUsedBytes: null,
    heapMaxBytes: null,
    heapPercent: null,
    logWarnings: 0,
    logErrors: 0,
    tone: 'warning',
    notes: ["Artemis wasn't running, so its queues and memory couldn't be read."],
  };
}

// "0 8,14,20 * * *" -> "08:00, 14:00 and 20:00"; anything else is shown as is.
export function describeArtemisSchedule(cronExpr = env.artemisCheckCron): string {
  const m = /^(\d{1,2})\s+([\d,]+)\s+\*\s+\*\s+\*$/.exec(cronExpr.trim());
  if (!m) return `on the schedule "${cronExpr}"`;
  const times = m[2].split(',').map((h) => `${h.padStart(2, '0')}:${m[1].padStart(2, '0')}`);
  const list = times.length > 1 ? `${times.slice(0, -1).join(', ')} and ${times[times.length - 1]}` : times[0];
  return `every day at ${list}`;
}

// One plain line for the step's log, e.g. "DLQ 32 messages, ExpiryQueue 0. Memory 70 MB of 4 GB (1.7%)."
export function artemisSummary(r: ArtemisReport): string {
  const parts: string[] = [];
  if (r.dlq !== null) parts.push(`DLQ ${r.dlq} message${r.dlq === 1 ? '' : 's'}, ExpiryQueue ${r.expiry ?? 0}.`);
  if (r.heapPercent !== null) parts.push(`Memory ${formatBytes(r.heapUsedBytes!)} of ${formatBytes(r.heapMaxBytes!)} (${r.heapPercent}%).`);
  if (r.logWarnings || r.logErrors) parts.push(`Logged since this start: ${r.logErrors} error(s), ${r.logWarnings} warning(s).`);
  parts.push(...r.notes);
  return parts.join(' ');
}
