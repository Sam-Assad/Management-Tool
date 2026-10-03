import pLimit from 'p-limit';
import { sqlite, insertRow } from '../db/client.js';
import { getConnection } from '../ssh/connectionManager.js';
import { runCommand } from '../ssh/exec.js';
import { streamTail } from '../ssh/tail.js';
import { detectPresence, checkComponent, probeComponentUnit, systemctlCommand } from '../scan/detectors.js';
import { sseHub } from '../sse/sseHub.js';
import { env } from '../env.js';
import {
  PORT_CONFLICT_RE,
  extractPorts,
  findPortHolders,
  waitForPortsFree,
  describePortConflict,
  describeFix,
  freePorts,
  type PortHolder,
} from '../scan/ports.js';
import { stopOrderIds, startDependents, stopDependents, startPredecessors, stopPredecessors } from './ordering.js';
import {
  CREDENTIAL_EXPIRED_RE,
  isWildFly,
  checkWildFlyDatasources,
  friendlyDsReason,
  datasourceDownDetail,
} from '../scan/datasources.js';
import type { SoftwareDefinition, Server as ServerRow } from '@healthcheck/shared';

function nowIso() {
  return new Date().toISOString();
}

function loadGroupServers(groupId: number): ServerRow[] {
  return sqlite.prepare('SELECT * FROM servers WHERE group_id = ?').all(groupId) as unknown as ServerRow[];
}

function loadOrderedSoftware(groupId: number, direction: 'asc' | 'desc'): SoftwareDefinition[] {
  const rows = sqlite
    .prepare(
      `SELECT sd.* FROM group_software gs
       JOIN software_definitions sd ON sd.id = gs.software_id
       WHERE gs.group_id = ?
       ORDER BY gs.sequence_order ${direction === 'asc' ? 'ASC' : 'DESC'}`
    )
    .all(groupId) as unknown as SoftwareDefinition[];
  return rows;
}

// Stop All order: the reverse of the start order, adjusted by any "stop before" conditions.
function loadStopOrderedSoftware(groupId: number): SoftwareDefinition[] {
  const byId = new Map(loadOrderedSoftware(groupId, 'asc').map((d) => [d.id, d]));
  return stopOrderIds(groupId)
    .map((id) => byId.get(id))
    .filter((d): d is SoftwareDefinition => Boolean(d));
}

function createJob(kind: string, groupId: number | null) {
  return insertRow<{ id: number }>('job_runs', { group_id: groupId, kind, status: 'running', started_at: nowIso() });
}

function finishJob(jobId: number, status: 'succeeded' | 'failed', errorMessage?: string) {
  startedInJob.delete(jobId);
  controls.delete(jobId);
  portConflicts.forEach((_v, key) => {
    if (key.startsWith(`${jobId}:`)) portConflicts.delete(key);
  });
  credentialFailures.forEach((key) => {
    if (key.startsWith(`${jobId}:`)) credentialFailures.delete(key);
  });
  datasourceFailures.forEach((_v, key) => {
    if (key.startsWith(`${jobId}:`)) datasourceFailures.delete(key);
  });
  pendingSteps.forEach((_id, key) => {
    if (key.startsWith(`${jobId}:`)) pendingSteps.delete(key);
  });
  sqlite
    .prepare('UPDATE job_runs SET status = ?, finished_at = ?, error_message = ?, awaiting = NULL WHERE id = ?')
    .run(status, nowIso(), errorMessage ?? null, jobId);
  sseHub.publish(jobId, { type: 'job', status });
  sseHub.close(jobId);
}

function createStep(jobId: number, serverId: number, softwareId: number, action: string) {
  return insertRow<{ id: number }>('job_steps', {
    job_run_id: jobId,
    server_id: serverId,
    software_id: softwareId,
    action,
    status: 'pending',
  });
}

// Steps that were created up front ("waiting") so the whole plan is visible; the step function that
// later runs the component picks its row up instead of creating a second one.
const pendingSteps = new Map<string, number>();
const pendingKey = (jobId: number, serverId: number, softwareId: number) => `${jobId}:${serverId}:${softwareId}`;

function planStep(jobId: number, serverId: number, softwareId: number, action: string) {
  const step = createStep(jobId, serverId, softwareId, action);
  pendingSteps.set(pendingKey(jobId, serverId, softwareId), step.id);
}

function claimStep(jobId: number, serverId: number, softwareId: number, action: string) {
  const key = pendingKey(jobId, serverId, softwareId);
  const id = pendingSteps.get(key);
  if (id !== undefined) {
    pendingSteps.delete(key);
    return { id };
  }
  return createStep(jobId, serverId, softwareId, action);
}

// What a run has started so far - what "Roll back" stops again.
const startedInJob = new Map<number, Array<{ serverId: number; softwareId: number }>>();
function forgetStarted(jobId: number, serverId: number, softwareId: number) {
  const list = startedInJob.get(jobId);
  if (list) {
    startedInJob.set(
      jobId,
      list.filter((e) => !(e.serverId === serverId && e.softwareId === softwareId))
    );
  }
}

// A component whose port is taken by something else: which ports, and who holds them (for the question).
const portConflicts = new Map<string, { ports: number[]; holders: PortHolder[] }>();

// A component that failed because of an expired password/credential: retrying is pointless, so the
// question offers only Continue / Roll back (see runGroupSequence's ask() call).
const credentialFailures = new Set<string>();

// A component whose post-start datasource check failed: which datasource(s) and a plain-English reason,
// so the question the operator is asked can name them directly instead of just saying "did not start".
const datasourceFailures = new Map<string, { names: string[]; reason: string }>();

// Live control of a running job. Ending a run (stop / roll back) has to reach starts that are already
// under way: cancel every health wait at once, and make anything about to start check first.
interface Control {
  ending: 'halt' | 'rollback' | null;
  watches: Map<number, HealthWatch>; // by step id
}
const controls = new Map<number, Control>();
function controlOf(jobId: number): Control {
  let c = controls.get(jobId);
  if (!c) {
    c = { ending: null, watches: new Map() };
    controls.set(jobId, c);
  }
  return c;
}
const runEnding = (jobId: number) => controls.get(jobId)?.ending ?? null;
function beginWatch(jobId: number, stepId: number, watch: HealthWatch) {
  const c = controlOf(jobId);
  c.watches.set(stepId, watch);
  if (c.ending) watch.cancel();
}
function endWatch(jobId: number, stepId: number) {
  controls.get(jobId)?.watches.delete(stepId);
}
function endRun(jobId: number, how: 'halt' | 'rollback') {
  const c = controlOf(jobId);
  c.ending = how;
  for (const watch of c.watches.values()) watch.cancel();
}

// "Mark as started": the operator vouches for a component whose unit is running but whose log never
// printed the success line. Only offered while such a wait is going on.
export function isAcceptable(jobId: number, stepId: number): boolean {
  return controls.get(jobId)?.watches.get(stepId)?.acceptable() ?? false;
}
export function acceptStep(jobId: number, stepId: number): boolean {
  const watch = controls.get(jobId)?.watches.get(stepId);
  if (!watch || !watch.acceptable()) return false;
  watch.accept();
  return true;
}

function noteStarted(jobId: number, serverId: number, softwareId: number) {
  const list = startedInJob.get(jobId) ?? [];
  if (!list.some((e) => e.serverId === serverId && e.softwareId === softwareId)) list.push({ serverId, softwareId });
  startedInJob.set(jobId, list);
}

function updateStep(
  jobId: number,
  stepId: number,
  patch: Partial<{ status: string; log_excerpt: string | null; started_at: string; finished_at: string }>
) {
  const keys = Object.keys(patch);
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => (patch as any)[k]);
  sqlite.prepare(`UPDATE job_steps SET ${setClause} WHERE id = ?`).run(...values, stepId);
  const row = sqlite
    .prepare(
      `SELECT js.*, sv.name AS server_name, sd.name AS software_name FROM job_steps js
       LEFT JOIN servers sv ON sv.id = js.server_id
       LEFT JOIN software_definitions sd ON sd.id = js.software_id
       WHERE js.id = ?`
    )
    .get(stepId);
  sseHub.publish(jobId, { type: 'step', step: row });
}

function recordStatus(
  serverId: number,
  softwareId: number,
  source: 'scan' | 'heartbeat',
  status: 'up' | 'down',
  detail?: string
) {
  insertRow('heartbeat_log', {
    server_id: serverId,
    software_id: softwareId,
    source,
    status,
    detail: detail ?? null,
    checked_at: nowIso(),
  });
}

// After a start that didn't pass its health check: record what systemd really says (a unit can be
// "active" while our log check failed), so the Status column doesn't claim something that isn't true.
//
// `knownReason` skips that live re-check for a failure we're already certain of (credential_expired):
// many of these units are set to restart on their own (systemd Restart=), so a snapshot taken right
// after the crash can catch it mid-restart looking "active" again - even though it is only about to
// fail the exact same way, seconds later, once it hits the database again. The Status column showing
// "Running" right after the job just gave up on it is confusing and, for a unit stuck in that loop, wrong
// often enough of the time to not be worth the live check.
async function recordActualState(client: any, serverId: number, def: SoftwareDefinition, knownReason?: HealthResult['reason']) {
  if (knownReason === 'credential_expired') {
    recordStatus(serverId, def.id, 'scan', 'down', 'credential_expired');
    return;
  }
  try {
    const { up, detail } = await checkComponent(client, def);
    recordStatus(serverId, def.id, 'scan', up ? 'up' : 'down', detail);
  } catch {
    recordStatus(serverId, def.id, 'scan', 'down', 'failed');
  }
}

function isGroupBusy(groupId: number): boolean {
  const row = sqlite
    .prepare("SELECT COUNT(*) as count FROM job_runs WHERE group_id = ? AND status = 'running'")
    .get(groupId) as { count: number };
  return row.count > 0;
}

interface HealthResult {
  healthy: boolean;
  excerpt: string;
  // crash = the service exited/restarted (worth retrying); timeout = never became healthy in time;
  // credential_expired = a password/credential expiry was seen in the log - never worth retrying;
  // datasource_down = the log said it started fine, but a configured datasource's pool failed
  // test-connection-in-pool - WildFly can log "started (with errors)" while a JCA pool is unusable.
  reason?: 'crash' | 'timeout' | 'cancelled' | 'other' | 'credential_expired' | 'datasource_down';
  // ports the log said were already taken
  ports?: number[];
}

interface HealthWatch {
  result: Promise<HealthResult>;
  cancel: () => void;
  // the unit runs but the success line hasn't shown up for a while: the operator may vouch for it
  acceptable: () => boolean;
  accept: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Starts watching for "healthy" and returns immediately. Call it BEFORE issuing the
// start command: the log tail only sees new lines, so opening it afterwards could
// miss a fast success line.
//
// With a log_path + success_pattern: healthy = the pattern shows up in new log lines. An error-pattern
// line does not fail the wait by itself (plenty of healthy starts log an ERROR now and then): for a
// systemd unit we then check whether the service really died - not active any more, or a different
// main process (= it exited and systemd restarted it). Only then is it a crash. If it just keeps
// running we keep waiting for the success line, and the timeout still applies.
// Without a pattern: healthy = the component is detected running.
// `live` (optional) receives the latest log lines while waiting, at most about once a second, so the
// operator can watch the start-up instead of staring at "running".
// How many recent log lines are kept for the failure excerpt and the expired-credential check. A
// Hibernate/Spring stack trace routinely runs past 40 lines (several "Caused by" chains, one frame per
// line) - too small a window here silently evicts the one line that says WHY (`ORA-28001: the password
// has expired`) before crashed() ever gets a chance to look at it, but keeps it for a shorter trace from
// a different jar. That's why the same expired password showed up correctly for some components and as
// a bare "Failed"/"Stopped" for others: pure luck of how long that particular jar's trace happened to be.
const LOG_BUFFER_LINES = 300;

function watchHealth(client: any, def: SoftwareDefinition, live?: (tail: string) => void): HealthWatch {
  const timeoutMs = def.health_timeout_s * 1000;
  const buffer: string[] = [];
  const cleanups: Array<() => void> = [];
  const logMode = Boolean(def.log_path && def.success_pattern);
  const isSystemd = def.detect_method === 'systemd';
  let settled = false;
  let errorLine: string | null = null;
  let confirming = false;
  const startedAt = Date.now();
  const conflictPorts = new Set<number>();
  let hint = '';
  let canAccept = false;
  let resolveResult!: (r: HealthResult) => void;
  const result = new Promise<HealthResult>((resolve) => {
    resolveResult = resolve;
  });

  const finish = (r: HealthResult) => {
    if (settled) return;
    settled = true;
    cleanups.forEach((fn) => fn());
    resolveResult(r.healthy || conflictPorts.size === 0 ? r : { ...r, ports: [...conflictPorts] });
  };

  let lastLive = 0;
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  const emitLive = () => {
    liveTimer = undefined;
    lastLive = Date.now();
    if (settled || !live) return;
    const tail = buffer.slice(-8).map((l) => l.slice(0, 300)).join('\n');
    const text = [hint, tail].filter(Boolean).join('\n\n');
    if (text) live(text);
  };
  const scheduleLive = () => {
    if (!live || liveTimer) return;
    const wait = Math.max(0, 1000 - (Date.now() - lastLive));
    liveTimer = setTimeout(emitLive, wait);
  };
  cleanups.push(() => {
    if (liveTimer) clearTimeout(liveTimer);
  });
  const recentLog = () => buffer.join('\n') || '(no new log output)';

  const timer = setTimeout(
    () =>
      finish({
        healthy: false,
        reason: 'timeout',
        excerpt: logMode
          ? `Did not see the success pattern /${def.success_pattern}/ in ${def.log_path} within ${def.health_timeout_s}s.\n` +
            (errorLine
              ? `An error-pattern line was logged but the service kept running:\n${errorLine}\n`
              : `If the component is actually up, its log may not print that line - edit the Success pattern in the Software Catalog.\n`) +
            `\nRecent log:\n${recentLog()}`
          : '(no log pattern configured - never detected running)',
      }),
    timeoutMs
  );
  cleanups.push(() => clearTimeout(timer));

  // Re-checked against the whole recent buffer, not just the one line that triggered this, because
  // confirmCrash's SSH round-trip can settle before a follow-up log line (the actual "ORA-28001: the
  // password has expired", printed right after a generic "ERROR ... Application run failed") arrives.
  const crashed = (line: string): HealthResult => {
    const recent = recentLog();
    if (CREDENTIAL_EXPIRED_RE.test(recent)) {
      return {
        healthy: false,
        reason: 'credential_expired',
        excerpt:
          `${def.name}'s password or credentials look expired - retrying will not help until this is fixed on the server:\n\n` +
          `Recent log:\n${recent}`,
      };
    }
    return {
      healthy: false,
      reason: 'crash',
      excerpt:
        `The service crashed or was restarted after this log line (it matched the Error pattern /${def.error_pattern}/):\n${line}\n\n` +
        `Recent log:\n${recent}`,
    };
  };

  async function confirmCrash(line: string) {
    if (confirming) return;
    confirming = true;
    try {
      const first = await probeComponentUnit(client, def);
      for (let i = 0; i < 10 && !settled; i++) {
        const now = await probeComponentUnit(client, def);
        // died = not up any more (failed/stopped), waiting to be restarted by systemd, or a new process
        // took over. NOT merely 'activating': that is normal while a Type=notify/forking service starts.
        const restarted = Boolean(first.pid && now.pid && now.pid !== first.pid);
        const down = ['failed', 'inactive', 'deactivating'].includes(now.active) || now.sub === 'auto-restart';
        if (down || restarted) {
          finish(crashed(line));
          return;
        }
        await sleep(1000);
      }
    } catch {
      // can't tell - treat as still running and let the timeout decide
    }
    confirming = false;
  }

  if (logMode) {
    const successRe = new RegExp(def.success_pattern!);
    const errorRe = def.error_pattern ? new RegExp(def.error_pattern) : null;
    streamTail(client, def.log_path!, (line) => {
      buffer.push(line);
      if (buffer.length > LOG_BUFFER_LINES) buffer.shift();
      if (PORT_CONFLICT_RE.test(line)) for (const p of extractPorts(line)) conflictPorts.add(p);
      if (settled) return;
      // Only fail fast, without waiting to see if the unit stays up, when this line is ALSO flagged at
      // ERROR/FATAL/SEVERE level by the component's own pattern (or there's no such pattern to check
      // against). A JCA pool logging a WARN that merely *mentions* ORA-28001 somewhere in a wrapped
      // exception - WildFly's real shape for this - does not mean WildFly itself failed to start: it
      // often still finishes booting "with errors" a moment later, and that success line should still
      // win. A line severe enough to match the error pattern, though, is worth trusting immediately.
      if (!successRe.test(line) && CREDENTIAL_EXPIRED_RE.test(line) && (!errorRe || errorRe.test(line))) {
        // No confirmCrash polling here - unlike a plain crash, this doesn't need 10s of "is it really
        // down?" checking to be sure trying again won't help. Fail fast.
        finish({
          healthy: false,
          reason: 'credential_expired',
          excerpt:
            `${def.name}'s password or credentials look expired - retrying will not help until this is fixed on the server:\n${line}\n\n` +
            `Recent log:\n${recentLog()}`,
        });
        return;
      }
      scheduleLive();
      // Success wins when a line matches both patterns: WildFly logs its own "started (with errors)"
      // summary line - the exact success pattern for that case - AT its own ERROR level, since it
      // considers any failed deployment an error worth flagging. Checking errorRe first would treat that
      // line as a possible crash instead of the success it actually is, and the real success line would
      // never come, since it only prints once - the health check would just hang until the full timeout.
      if (successRe.test(line)) {
        finish({ healthy: true, excerpt: line });
      } else if (errorRe && errorRe.test(line)) {
        errorLine = line;
        if (isSystemd) void confirmCrash(line);
        else finish(crashed(line));
      }
    })
      .then((stopFn) => {
        if (settled) stopFn();
        else cleanups.push(stopFn);
      })
      .catch(() => finish({ healthy: false, reason: 'other', excerpt: 'Failed to open log for tailing' }));
  }

  void (async () => {
    while (!settled) {
      await sleep(2000);
      if (settled) return;
      try {
        if (isSystemd) {
          const state = await probeComponentUnit(client, def);
          if (state.active === 'failed') {
            const recent = recentLog();
            finish(
              CREDENTIAL_EXPIRED_RE.test(recent)
                ? {
                    healthy: false,
                    reason: 'credential_expired',
                    excerpt:
                      `${def.name}'s password or credentials look expired - retrying will not help until this is fixed on the server:\n\n` +
                      `Recent log:\n${recent}`,
                  }
                : { healthy: false, reason: 'crash', excerpt: `systemd reports ${state.unit} as failed.\n\nRecent log:\n${recent}` }
            );
          } else if (!logMode && state.installed && state.active === 'active') {
            finish({ healthy: true, excerpt: '(no log pattern configured - unit is active)' });
          } else if (logMode) {
            // Running for a while without the success line: the pattern may simply not be what this
            // component prints. Say so, and let the operator vouch for it instead of waiting out the timeout.
            const stuck = state.active === 'active' && Date.now() - startedAt > env.startHintAfterS * 1000;
            if (stuck && !canAccept) {
              canAccept = true;
              hint =
                `systemd reports ${state.unit} as running, but its log has not printed the success line yet (/${def.success_pattern}/). ` +
                `If it is up, use "Mark as started". To stop this waiting, fix the Success pattern in the Software Catalog.`;
              emitLive();
            } else if (!stuck && canAccept) {
              canAccept = false;
              hint = '';
            }
          }
        } else if (!logMode && (await detectPresence(client, def))) {
          finish({ healthy: true, excerpt: '(no log pattern configured - process detected running)' });
        }
      } catch {
        // transient SSH hiccup - the next poll (or the timeout) decides
      }
    }
  })();

  return {
    result,
    cancel: () => finish({ healthy: false, reason: 'cancelled', excerpt: 'cancelled' }),
    acceptable: () => canAccept && !settled,
    accept: () => finish({ healthy: true, excerpt: 'Marked as started by the operator (the success line was not seen in the log).' }),
  };
}

async function waitForStopped(client: any, def: SoftwareDefinition, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const present = await detectPresence(client, def);
    if (!present) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface CapturedProcess {
  pid: string;
  cmd: string;
  cwd: string;
}

async function captureRunningCommand(client: any, def: SoftwareDefinition): Promise<CapturedProcess | null> {
  if (def.detect_method !== 'process_fragment') return null;
  const fragment = def.detect_value.replace(/'/g, `'\\''`);
  const res = await runCommand(client, `ps -eo pid,args | grep -v grep | grep '${fragment}' | head -n1`);
  const line = res.stdout.trim();
  if (!line) return null;
  const match = line.match(/^\s*(\d+)\s+(.*)$/);
  if (!match) return null;
  const pid = match[1];
  const cmd = match[2].trim();
  const cwdRes = await runCommand(client, `readlink -f /proc/${pid}/cwd 2>/dev/null || echo /`);
  const cwd = cwdRes.stdout.trim() || '/';
  return { pid, cmd, cwd };
}

async function killPid(client: any, pid: string) {
  await runCommand(client, `kill ${pid} 2>/dev/null; sleep 1; kill -9 ${pid} 2>/dev/null; true`);
}

function describeCommandFailure(action: string, unit: string, out: string): string {
  const text = out.trim() || '(no output)';
  if (/not[- ]found|could not be found|not loaded/i.test(text)) {
    return `${unit} is not installed on this server (systemctl ${action} failed): ${text}`;
  }
  if (/must have a tty|no tty present/i.test(text)) {
    return `sudo refuses to run without a terminal on this server ("requiretty"). Add "Defaults:<user> !requiretty" to sudoers (see README). Details: ${text}`;
  }
  if (/a password is required|is not in the sudoers|may not run sudo|not allowed to execute|not allowed to run/i.test(text)) {
    return `sudo would not run systemctl ${action} without a password for this SSH user. It needs a NOPASSWD sudoers entry for systemctl (see README). Details: ${text}`;
  }
  if (/authentication required|access denied|permission denied/i.test(text)) {
    return `The SSH user is not permitted to run systemctl ${action}. It needs a NOPASSWD sudoers entry for systemctl (see README). Details: ${text}`;
  }
  return `systemctl ${action} ${unit} failed: ${text}`;
}

// systemd-managed component: start/stop through systemctl on the unit name (detect_value),
// unless the catalog entry carries its own explicit command. Unlike the script/captured
// paths, a non-zero exit is a real failure here and is surfaced to the operator.
async function runSystemd(client: any, def: SoftwareDefinition, action: 'start' | 'stop') {
  const custom = (action === 'start' ? def.start_cmd : def.stop_cmd).trim();
  let cmd = custom;
  let unit = def.detect_value;
  if (!cmd) {
    if (def.detect_method !== 'systemd') {
      throw new Error(`No ${action} command configured for ${def.name}, and it is not detected as a systemd unit.`);
    }
    // The entry may list alternative unit names; use the one this server actually has.
    const found = await probeComponentUnit(client, def);
    if (!found.installed) {
      throw new Error(`${def.name} is not installed on this server (no systemd unit named ${def.detect_value.replace(/[|,]/g, ' or ')}).`);
    }
    unit = found.unit;
    cmd = systemctlCommand(action, unit);
  }
  const res = await runCommand(client, cmd, action === 'start' ? 120_000 : 300_000);
  if (res.code !== 0) throw new Error(describeCommandFailure(action, unit, res.stderr || res.stdout));
}

async function stopForRestart(client: any, def: SoftwareDefinition): Promise<CapturedProcess | null> {
  if (def.restart_method === 'systemd') {
    await runSystemd(client, def, 'stop');
    return null;
  }
  if (def.restart_method === 'captured') {
    const capture = await captureRunningCommand(client, def);
    if (capture) {
      await killPid(client, capture.pid);
    } else if (def.stop_cmd) {
      await runCommand(client, def.stop_cmd).catch(() => {});
    }
    return capture;
  }
  await runCommand(client, def.stop_cmd).catch(() => {});
  return null;
}

async function startForRestart(client: any, def: SoftwareDefinition, capture: CapturedProcess | null) {
  if (def.restart_method === 'systemd') {
    await runSystemd(client, def, 'start');
    return;
  }
  if (def.restart_method === 'captured') {
    if (capture) {
      await runCommand(client, `cd ${shQuote(capture.cwd)} && nohup ${capture.cmd} > /dev/null 2>&1 < /dev/null & disown`);
      return;
    }
    if (def.start_cmd) {
      await runCommand(client, def.start_cmd);
      return;
    }
    throw new Error('No running instance to capture, and no start command configured for this software.');
  }
  await runCommand(client, def.start_cmd);
}

// In whole-group jobs a component this server simply doesn't have is skipped, not a failure.
async function notInstalledHere(client: any, def: SoftwareDefinition): Promise<boolean> {
  if (def.detect_method !== 'systemd') return false;
  return !(await probeComponentUnit(client, def)).installed;
}

// Clears a failed attempt so the next one starts from a clean state (and a crash-looping unit stops looping).
async function stopQuietly(client: any, def: SoftwareDefinition) {
  try {
    await stopForRestart(client, def);
  } catch {
    // best effort
  }
}

function attemptsHeader(attempt: number, attempts: number, last: HealthResult): string {
  const firstLine = (last.excerpt.split('\n').find((l) => l.trim()) ?? '').slice(0, 160);
  return `Attempt ${attempt} of ${attempts} failed - trying again in ${env.startRetryDelayS}s.\n${firstLine}`;
}

async function stopStep(
  jobId: number,
  server: ServerRow,
  def: SoftwareDefinition,
  skipMissing = false,
  _attempts = 1,
  action: 'stop' | 'rollback' = 'stop'
): Promise<boolean> {
  const step = createStep(jobId, server.id, def.id, action);
  updateStep(jobId, step.id, { status: 'running', started_at: nowIso() });
  try {
    const client = await getConnection(server as any);
    if (skipMissing && (await notInstalledHere(client, def))) {
      updateStep(jobId, step.id, {
        status: 'skipped',
        log_excerpt: 'not installed on this server - skipped',
        finished_at: nowIso(),
      });
      return true;
    }
    if (def.restart_method === 'systemd') {
      await runSystemd(client, def, 'stop');
    } else if (def.restart_method === 'captured') {
      const capture = await captureRunningCommand(client, def);
      if (capture) await killPid(client, capture.pid);
    } else {
      await runCommand(client, def.stop_cmd);
    }
    const stopped = await waitForStopped(client, def);
    if (!stopped) {
      updateStep(jobId, step.id, {
        status: 'failed',
        log_excerpt: 'Process still detected after stop command',
        finished_at: nowIso(),
      });
      return false;
    }
    updateStep(jobId, step.id, { status: 'healthy', finished_at: nowIso() });
    recordStatus(server.id, def.id, 'scan', 'down', 'stopped');
    return true;
  } catch (err: any) {
    updateStep(jobId, step.id, { status: 'failed', log_excerpt: String(err?.message ?? err), finished_at: nowIso() });
    return false;
  }
}

// What a component's step says when the operator ended the run while it was still going.
function endedText(jobId: number): string {
  return runEnding(jobId) === 'rollback'
    ? 'Cancelled - the run was rolled back.'
    : 'Not waited for - the run was stopped here. The component was left as it is.';
}

// Waits, but gives up early when the run is ended (so a stopped run does not sit out a retry delay).
async function sleepUnlessEnded(jobId: number, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until && !runEnding(jobId)) await sleep(Math.min(500, until - Date.now()));
}

// Start (only what is down) and Restart (stop, then start) share everything else: the health wait with
// live log, retries after a crash, port conflicts, and giving up at once when the run is ended.
async function startAttempts(
  mode: 'start' | 'restart',
  jobId: number,
  server: ServerRow,
  def: SoftwareDefinition,
  skipMissing = false,
  attempts = 1
): Promise<boolean> {
  const step = claimStep(jobId, server.id, def.id, 'start');
  updateStep(jobId, step.id, { status: 'running', started_at: nowIso() });
  const conflictKey = pendingKey(jobId, server.id, def.id);
  const skipStep = (why: string) => {
    updateStep(jobId, step.id, { status: 'skipped', log_excerpt: why, finished_at: nowIso() });
    return true;
  };
  // WildFly only: test every datasource it has. Any failure = not healthy, whatever systemd and the log
  // say - stop it right away (before systemd's Restart= brings it back against the same broken database),
  // record which datasources, and fail the step so the run asks the operator.
  const datasourceGate = async (client: any, startedNow: boolean): Promise<{ ok: boolean; note: string }> => {
    if (!isWildFly(def)) return { ok: true, note: '' };
    updateStep(jobId, step.id, { log_excerpt: `${def.name} is up - testing its database connections (datasources)...` });
    const ds = await checkWildFlyDatasources(client);
    if (!ds.checked) return { ok: true, note: `\n\nDatasource check skipped: ${ds.note}` };
    if (ds.failures.length === 0) return { ok: true, note: `\n\nAll ${ds.tested.length} datasources passed a connection test.` };
    await stopQuietly(client, def);
    const names = ds.failures.map((f) => f.name);
    const failureText = ds.failures.map((f) => `${f.name}: ${f.reason}`).join('\n');
    const cause = friendlyDsReason(failureText);
    if (CREDENTIAL_EXPIRED_RE.test(failureText)) credentialFailures.add(conflictKey);
    datasourceFailures.set(conflictKey, { names, reason: cause });
    updateStep(jobId, step.id, {
      status: 'failed',
      log_excerpt:
        `${def.name} ${startedNow ? 'started' : 'was running'}, but ${names.length} of ${ds.tested.length} datasources failed a connection test, ` +
        `so ${def.name} was stopped: ${names.join(', ')}.\n\nLikely cause: ${cause}.\n\nTechnical detail:\n${failureText}`,
      finished_at: nowIso(),
    });
    recordStatus(server.id, def.id, 'scan', 'down', datasourceDownDetail(ds.failures));
    return { ok: false, note: '' };
  };
  // a Retry starts from a clean slate: a new failure says for itself what kind it is
  credentialFailures.delete(conflictKey);
  datasourceFailures.delete(conflictKey);
  try {
    const client = await getConnection(server as any);
    if (skipMissing && (await notInstalledHere(client, def))) return skipStep('not installed on this server - skipped');
    if (mode === 'start' && (await detectPresence(client, def))) {
      // "Running" in systemd isn't enough for WildFly: a running WildFly with a broken datasource is
      // exactly what this check exists to catch.
      const gate = await datasourceGate(client, false);
      if (!gate.ok) return false;
      updateStep(jobId, step.id, { status: 'healthy', log_excerpt: `already running - left untouched${gate.note}`, finished_at: nowIso() });
      recordStatus(server.id, def.id, 'scan', 'up', 'running');
      return true;
    }
    let last: HealthResult = { healthy: false, excerpt: '' };
    let tried = 0;
    let note = '';
    let maxAttempts = attempts;
    let extraGiven = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (runEnding(jobId)) return skipStep(endedText(jobId));
      tried = attempt;
      if (attempt > 1) {
        note = attemptsHeader(attempt - 1, maxAttempts, last);
        updateStep(jobId, step.id, { log_excerpt: note });
        if (mode === 'start') await stopQuietly(client, def);
        await sleepUnlessEnded(jobId, env.startRetryDelayS * 1000);
        if (runEnding(jobId)) return skipStep(endedText(jobId));
      }
      const capture = mode === 'restart' ? await stopForRestart(client, def) : null;
      if (runEnding(jobId)) return skipStep(endedText(jobId));
      const watch = watchHealth(client, def, (tail) =>
        updateStep(jobId, step.id, { log_excerpt: note ? `${note}\n\n${tail}` : tail })
      );
      beginWatch(jobId, step.id, watch);
      // registered before the command runs: a rollback must stop it even if it is still coming up
      noteStarted(jobId, server.id, def.id);
      try {
        await startForRestart(client, def, capture);
      } catch (err) {
        forgetStarted(jobId, server.id, def.id);
        watch.cancel();
        endWatch(jobId, step.id);
        throw err;
      }
      last = await watch.result;
      endWatch(jobId, step.id);
      if (last.healthy) {
        const gate = await datasourceGate(client, true);
        if (!gate.ok) return false;
        portConflicts.delete(conflictKey);
        credentialFailures.delete(conflictKey);
        datasourceFailures.delete(conflictKey);
        updateStep(jobId, step.id, { status: 'healthy', log_excerpt: `${last.excerpt}${gate.note}`, finished_at: nowIso() });
        recordStatus(server.id, def.id, 'scan', 'up', 'running');
        return true;
      }
      if (last.reason === 'cancelled') return skipStep(endedText(jobId));
      if (last.reason === 'credential_expired') credentialFailures.add(conflictKey);
      if (last.ports?.length) {
        // Something else is listening on the port(s) it needs. Stop it restarting itself, then give a
        // previous instance that is still shutting down time to let go. If the port stays taken,
        // trying again cannot help: say who holds it instead.
        await stopQuietly(client, def);
        if (!(await waitForPortsFree(client, last.ports, env.portReleaseWaitS * 1000))) {
          const holders = await findPortHolders(client, last.ports);
          portConflicts.set(conflictKey, { ports: last.ports, holders });
          last = { ...last, excerpt: `${describePortConflict(def.name, last.ports, holders)}\n\n${last.excerpt}` };
          break;
        }
        // it was only slow to release the port: try again, even if this was the last attempt (once)
        if (attempt >= maxAttempts && !extraGiven) {
          extraGiven = true;
          maxAttempts = attempt + 1;
        }
        continue;
      }
      if (last.reason !== 'crash') break; // slow starts aren't retried - waiting again wouldn't be quicker
    }
    // End the crash loop (systemd's Restart= would otherwise just keep bouncing it - and hitting the
    // database with the same bad password - every few seconds, on and on, until someone fixes it).
    // Done as soon as we give up, not only once the operator answers: there's nothing to wait for.
    if (last.reason === 'crash' || last.reason === 'credential_expired') await stopQuietly(client, def);
    updateStep(jobId, step.id, {
      status: 'failed',
      log_excerpt: (tried > 1 ? `Failed after ${tried} attempts.\n\n` : '') + last.excerpt,
      finished_at: nowIso(),
    });
    await recordActualState(client, server.id, def, last.reason);
    return false;
  } catch (err: any) {
    updateStep(jobId, step.id, { status: 'failed', log_excerpt: String(err?.message ?? err), finished_at: nowIso() });
    return false;
  }
}

const startStep: StepFn = (jobId, server, def, skipMissing = false, attempts = 1) =>
  startAttempts('start', jobId, server, def, skipMissing, attempts);
const restartStep: StepFn = (jobId, server, def, skipMissing = false, attempts = 1) =>
  startAttempts('restart', jobId, server, def, skipMissing, attempts);

// The operator chose "Free the port and retry": stop whatever holds the port(s) the component needs.
async function freePortsStep(jobId: number, server: ServerRow, def: SoftwareDefinition) {
  const conflict = portConflicts.get(pendingKey(jobId, server.id, def.id));
  if (!conflict) return;
  const step = createStep(jobId, server.id, def.id, 'free_port');
  updateStep(jobId, step.id, { status: 'running', started_at: nowIso() });
  try {
    const client = await getConnection(server as any);
    const result = await freePorts(client, conflict.ports);
    updateStep(jobId, step.id, {
      status: result.failed.length > 0 ? 'failed' : 'healthy',
      log_excerpt: [...result.done, ...result.failed].join('\n') || 'nothing was holding the port any more',
      finished_at: nowIso(),
    });
  } catch (err: any) {
    updateStep(jobId, step.id, { status: 'failed', log_excerpt: String(err?.message ?? err), finished_at: nowIso() });
  }
}

type Verb = 'start' | 'restart' | 'stop';
const VERB_TEXT: Record<Verb, { past: string; didNot: string }> = {
  start: { past: 'started', didNot: 'did not start' },
  restart: { past: 'restarted', didNot: 'did not restart' },
  stop: { past: 'stopped', didNot: 'did not stop' },
};

// ---- Asking the operator --------------------------------------------------------------------
// When a component in a whole-server run still won't come up (after its retries), the run PAUSES and
// asks: retry it, skip it and carry on, stop the run, or roll back (stop what this run has started).
// The question is stored on the job (job_runs.awaiting) so the UI can show it; the answer arrives
// through submitDecision().
export type Decision = 'retry' | 'skip' | 'halt' | 'rollback' | 'free_port';
const DECISION_TIMEOUT_MS = 30 * 60 * 1000;
const waiters = new Map<number, (choice: Decision) => void>();

interface Question {
  component: string;
  server: string;
  verb: Verb;
  summary: string;
  detail: string;
  holdsBack: string[];
  // what "Roll back" would stop again (start/restart runs only)
  rollback?: string[];
  // set when the component could not start because something else holds its port: what "Free the port" would do
  portFix?: { label: string; detail: string };
  // set when the failure was an expired password/credential: retrying can't help, so only Continue /
  // Roll back are offered (no Retry, no Stop the run)
  limited?: boolean;
  // set when WildFly failed its datasource check: which datasources, and the cause in plain words
  datasources?: string[];
  cause?: string;
}

function askOperator(jobId: number, question: Question): Promise<Decision> {
  return new Promise((resolve) => {
    const expiresAt = new Date(Date.now() + DECISION_TIMEOUT_MS).toISOString();
    const answer = (choice: Decision) => {
      clearTimeout(timer);
      waiters.delete(jobId);
      sqlite.prepare('UPDATE job_runs SET awaiting = NULL WHERE id = ?').run(jobId);
      resolve(choice);
    };
    // Nobody answered: don't leave the server locked forever - stop the run.
    const timer = setTimeout(() => answer('halt'), DECISION_TIMEOUT_MS);
    waiters.set(jobId, answer);
    sqlite
      .prepare('UPDATE job_runs SET awaiting = ? WHERE id = ?')
      .run(JSON.stringify({ ...question, expires_at: expiresAt }), jobId);
  });
}

// Returns false if the job isn't waiting for an answer (already answered, finished, or never asked).
export function submitDecision(jobId: number, choice: Decision): boolean {
  const answer = waiters.get(jobId);
  if (!answer) return false;
  answer(choice);
  return true;
}

// A request that was turned down because of the conditions (or because a job is already running).
// The message is written for the operator and is shown to them as is.
export class RefusedError extends Error {}

function transitiveDependents(from: number, dependents: Map<number, number[]>, within: Set<number>): number[] {
  const seen = new Set<number>();
  const stack = [...(dependents.get(from) ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur) || !within.has(cur)) continue;
    seen.add(cur);
    stack.push(...(dependents.get(cur) ?? []));
  }
  return [...seen];
}

// Final message of a single-component Start/Restart that failed (no question is asked for those).
function singleFailureMessage(jobId: number, server: ServerRow, def: SoftwareDefinition): string {
  const ds = datasourceFailures.get(pendingKey(jobId, server.id, def.id));
  if (!ds) return `${def.name} failed to become healthy`;
  return `${def.name} has been stopped: ${ds.names.length === 1 ? 'one of its datasources' : `${ds.names.length} of its datasources`} can't connect - ${ds.reason}. Failed: ${ds.names.join(', ')}.`;
}

function lastStepExcerpt(jobId: number, serverId: number, softwareId: number): string {
  const row = sqlite
    .prepare('SELECT log_excerpt FROM job_steps WHERE job_run_id = ? AND server_id = ? AND software_id = ? ORDER BY id DESC LIMIT 1')
    .get(jobId, serverId, softwareId) as { log_excerpt: string | null } | undefined;
  return (row?.log_excerpt ?? '').slice(0, 6000);
}

function lastStepReason(jobId: number, serverId: number, softwareId: number): string {
  return lastStepExcerpt(jobId, serverId, softwareId).split('\n').filter((l) => l.trim()).slice(0, 3).join('\n').slice(0, 400);
}

interface RunResult {
  failed: string[];
  blocked: string[];
  haltedAt: string | null;
  remaining: string[];
  // set when the operator chose "Roll back": what was stopped again, and what would not stop
  rolledBack: string[] | null;
  rollbackFailed: string[];
}

type StepFn = (
  jobId: number,
  server: ServerRow,
  def: SoftwareDefinition,
  skipMissing?: boolean,
  attempts?: number
) => Promise<boolean>;

// Stops (in the stop order) everything a run started, plus the component that failed - "Stop All" for
// just what this run touched. Best effort: one that won't stop doesn't prevent the rest from stopping.
async function rollbackRun(
  jobId: number,
  groupId: number,
  servers: ServerRow[],
  candidates: Array<{ serverId: number; softwareId: number }>
) {
  const position = new Map(stopOrderIds(groupId).map((id, index) => [id, index]));
  const defs = new Map(loadOrderedSoftware(groupId, 'asc').map((d) => [d.id, d]));
  const list = candidates
    .filter((c) => defs.has(c.softwareId))
    .sort((a, b) => (position.get(a.softwareId) ?? 0) - (position.get(b.softwareId) ?? 0));
  const done: string[] = [];
  const failed: string[] = [];
  for (const c of list) {
    const server = servers.find((s) => s.id === c.serverId);
    const def = defs.get(c.softwareId);
    if (!server || !def) continue;
    const ok = await stopStep(jobId, server, def, true, 1, 'rollback');
    (ok ? done : failed).push(servers.length > 1 ? `${def.name} on ${server.name}` : def.name);
  }
  return { done, failed };
}

// Steps that were queued ("waiting") but will not run because the run was ended.
function sweepPending(jobId: number) {
  if (!runEnding(jobId)) return;
  sqlite
    .prepare("UPDATE job_steps SET status = 'skipped', log_excerpt = 'Not reached - the run was stopped.', finished_at = ? WHERE job_run_id = ? AND status = 'pending'")
    .run(nowIso(), jobId);
}

function describeFixFor(jobId: number, serverId: number, softwareId: number) {
  const conflict = portConflicts.get(pendingKey(jobId, serverId, softwareId));
  return (conflict && describeFix(conflict.holders)) || undefined;
}

// Runs a step for every (component, server).
//  - Components tied to others by a condition (a "Start before" rule) run one after the other, in order.
//    Components that no condition mentions ("free") run at the same time as each other, and alongside
//    that chain, up to START_PARALLEL at once - only when `parallelFree` is set (start/restart).
//  - A component that fails is retried (crashes only), then the run pauses and asks the operator:
//    Retry / Skip it and continue / Stop the run / Roll back. Questions are asked one at a time.
//  - Skipping does not abort anything: it only blocks the components that depend on the skipped one
//    through a condition (and whatever depends on those). Unrelated components carry on.
//  - Dependencies are per server: a failure on one server doesn't block another server's components.
async function runGroupSequence(
  jobId: number,
  groupId: number,
  servers: ServerRow[],
  defs: SoftwareDefinition[],
  dependents: Map<number, number[]>,
  verb: Verb,
  stepFn: StepFn,
  parallelFree = false
): Promise<RunResult> {
  const blockedBy = new Map<string, string>();
  const failed: string[] = [];
  const failedPairs: Array<{ serverId: number; softwareId: number }> = [];
  const blocked: string[] = [];
  const remaining = new Set<string>();
  const ending = () => runEnding(jobId);
  let haltedAt = null as string | null;
  let endedAt = 0;
  const inRun = new Set(defs.map((d) => d.id));
  const nameOf = new Map(defs.map((d) => [d.id, d.name]));
  const label = (server: ServerRow, def: SoftwareDefinition) => (servers.length > 1 ? `${def.name} on ${server.name}` : def.name);

  // "Free" = no condition ties it to another component in this run.
  const linked = new Set<number>();
  if (parallelFree) {
    for (const [from, tos] of dependents) {
      for (const to of tos) {
        if (inRun.has(from) && inRun.has(to)) {
          linked.add(from);
          linked.add(to);
        }
      }
    }
  }
  const chain = defs.filter((d) => !parallelFree || linked.has(d.id));
  const free = defs.filter((d) => parallelFree && !linked.has(d.id));

  const blockDependents = (serverId: number, defId: number, rootName: string) => {
    for (const dep of dependents.get(defId) ?? []) {
      const key = `${serverId}:${dep}`;
      if (!blockedBy.has(key)) blockedBy.set(key, rootName);
    }
  };

  // One question at a time, even when several components fail together - including two that hit the
  // very same expired password: each is a different component and gets its own answer, so every one
  // still asks. Once the run is being ended (stop / roll back) nobody is asked again - everyone gets the
  // same answer.
  let queue: Promise<unknown> = Promise.resolve();
  const ask = (q: Question): Promise<Decision> => {
    const turn = queue.then(async (): Promise<Decision> => {
      const already = ending();
      if (already) return already;
      const choice = await askOperator(jobId, q);
      if (choice === 'halt' || choice === 'rollback') {
        haltedAt = q.component;
        endedAt = Date.now();
        // takes effect now, not when the running starts finish: cancel their waits, drop what is queued
        endRun(jobId, choice);
        sweepPending(jobId);
      }
      return choice;
    });
    queue = turn.catch(() => undefined);
    return turn;
  };

  const rollbackNames = (failing: SoftwareDefinition): string[] | undefined => {
    if (verb === 'stop') return undefined;
    const names = (startedInJob.get(jobId) ?? []).map((e) => nameOf.get(e.softwareId)).filter((n): n is string => Boolean(n));
    return [...new Set([...names, failing.name])];
  };

  async function processOne(server: ServerRow, def: SoftwareDefinition, inChain: boolean) {
    if (ending()) {
      remaining.add(def.name);
      return;
    }
    const root = inChain ? blockedBy.get(`${server.id}:${def.id}`) : undefined;
    if (root) {
      const step = createStep(jobId, server.id, def.id, verb === 'stop' ? 'stop' : 'start');
      updateStep(jobId, step.id, {
        status: 'blocked',
        log_excerpt: `Not ${VERB_TEXT[verb].past}: ${root} ${VERB_TEXT[verb].didNot}, and ${def.name} depends on it (see Conditions).`,
        finished_at: nowIso(),
      });
      const text = verb === 'stop' ? `${def.name} (must stop after ${root})` : `${def.name} (needs ${root})`;
      if (!blocked.includes(text)) blocked.push(text);
      blockDependents(server.id, def.id, root); // anything that depends on THIS one is blocked too
      return;
    }

    let ok = await stepFn(jobId, server, def, true, env.startAttempts);
    while (!ok) {
      const limited = credentialFailures.has(pendingKey(jobId, server.id, def.id));
      const dsFailure = datasourceFailures.get(pendingKey(jobId, server.id, def.id));
      const holdsBack = transitiveDependents(def.id, dependents, inRun)
        .map((id) => nameOf.get(id))
        .filter((n): n is string => Boolean(n));
      const onServer = servers.length > 1 ? ` on ${server.name}` : '';
      const failedCount = dsFailure ? (dsFailure.names.length === 1 ? 'one of its datasources' : `${dsFailure.names.length} of its datasources`) : '';
      let summary: string;
      if (limited && dsFailure) {
        summary = `${def.name}${onServer} has been stopped: ${failedCount} can't connect because ${dsFailure.reason}. Retrying won't help until the password is renewed.`;
      } else if (limited) {
        summary = `${def.name}${onServer}'s password or credentials look expired - retrying was skipped, it would fail the same way.`;
      } else if (dsFailure) {
        summary = `${def.name}${onServer} has been stopped: ${failedCount} can't connect - ${dsFailure.reason}. The applications using them won't work until this is fixed.`;
      } else {
        summary = `${def.name}${onServer} ${VERB_TEXT[verb].didNot}${verb !== 'stop' && env.startAttempts > 1 ? ` (after up to ${env.startAttempts} attempts)` : ''}.`;
      }
      const choice = await ask({
        component: def.name,
        server: server.name,
        verb,
        summary,
        detail: dsFailure ? lastStepExcerpt(jobId, server.id, def.id) : lastStepReason(jobId, server.id, def.id),
        holdsBack,
        rollback: rollbackNames(def),
        portFix: describeFixFor(jobId, server.id, def.id),
        limited,
        datasources: dsFailure?.names,
        cause: dsFailure?.reason,
      });
      if (choice === 'retry') {
        ok = await stepFn(jobId, server, def, true, env.startAttempts);
        continue;
      }
      if (choice === 'free_port') {
        await freePortsStep(jobId, server, def);
        ok = await stepFn(jobId, server, def, true, env.startAttempts);
        continue;
      }
      failed.push(label(server, def));
      failedPairs.push({ serverId: server.id, softwareId: def.id });
      // skip: leave it, hold back only what depends on it, carry on with the rest
      if (choice === 'skip') blockDependents(server.id, def.id, def.name);
      return;
    }
  }

  const runChain = async () => {
    for (const def of chain) for (const server of servers) await processOne(server, def, true);
  };
  const runFree = async () => {
    if (free.length === 0) return;
    const limit = pLimit(env.startParallel);
    const pairs = free.flatMap((def) => servers.map((server) => ({ server, def })));
    // show the whole queue right away: what is running now and what is waiting for a free slot
    for (const { server, def } of pairs) planStep(jobId, server.id, def.id, 'start');
    // Stagger the actual launch of each free component, even within the concurrency limit: several JVMs
    // opening a DB connection pool in the same instant can saturate the database and fail together (seen
    // in production - a run where 7 Spring Boot apps all failed HikariPool init within the same second).
    // A shared "next slot" clock spaces launches env.startStaggerS apart; a slot that is already in the
    // past (the previous launch took longer than the stagger, which is normal) is used immediately.
    const staggerMs = env.startStaggerS * 1000;
    let nextSlotAt = 0;
    const launch = async (server: ServerRow, def: SoftwareDefinition) => {
      const at = Math.max(Date.now(), nextSlotAt);
      nextSlotAt = at + staggerMs;
      const wait = at - Date.now();
      if (wait > 0) await sleepUnlessEnded(jobId, wait);
      return processOne(server, def, false);
    };
    await Promise.all(pairs.map(({ server, def }) => limit(() => launch(server, def))));
  };
  const all = Promise.all([runChain(), runFree()]);
  // Once the run is ended, do not wait long for a start command that is stuck: the rollback stops it anyway.
  await new Promise<void>((resolve) => {
    const watchdog = setInterval(() => {
      if (endedAt && Date.now() - endedAt > 20_000) resolve();
    }, 1000);
    all.then(() => resolve(), () => resolve()).finally(() => clearInterval(watchdog));
  });
  sweepPending(jobId);

  let rolledBack: string[] | null = null;
  let rollbackFailed: string[] = [];
  if (ending() === 'rollback') {
    const seen = new Set<string>();
    const candidates = [...(startedInJob.get(jobId) ?? []), ...failedPairs].filter((c) => {
      const key = `${c.serverId}:${c.softwareId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const result = await rollbackRun(jobId, groupId, servers, candidates);
    rolledBack = result.done;
    rollbackFailed = result.failed;
  }
  return { failed, blocked, haltedAt, remaining: [...remaining], rolledBack, rollbackFailed };
}

function finishSequenceJob(jobId: number, verb: Verb, result: RunResult) {
  if (result.failed.length === 0) {
    finishJob(jobId, 'succeeded');
    return;
  }
  const t = VERB_TEXT[verb];
  const failWord = verb === 'stop' ? 'did not stop' : verb === 'restart' ? 'did not restart healthy' : 'did not become healthy';
  let message = `${result.failed.join(', ')} ${failWord}.`;
  if (result.rolledBack) {
    message += ` Rolled back: stopped ${result.rolledBack.length > 0 ? result.rolledBack.join(', ') : 'nothing'}.`;
    if (result.rollbackFailed.length > 0) message += ` Could not stop: ${result.rollbackFailed.join(', ')}.`;
  } else if (result.haltedAt) {
    message += ` You stopped the run at ${result.haltedAt}.`;
    if (result.remaining.length > 0) message += ` Not reached (left as they were): ${result.remaining.join(', ')}.`;
  } else {
    if (result.blocked.length > 0) message += ` Not ${t.past} because a prerequisite ${verb === 'stop' ? 'did not stop' : 'failed'}: ${result.blocked.join(', ')}.`;
    message += ` Everything else was ${t.past}.`;
  }
  finishJob(jobId, 'failed', message);
}

function assertNotBusy(groupId: number) {
  if (isGroupBusy(groupId)) {
    throw new RefusedError('A job is already running on this server. Let it finish (or answer its question) first.');
  }
}

function pluralIs(names: string[]) {
  return names.length > 1 ? 'are' : 'is';
}

// Components that a "Start before" condition says must be running before `def` may start, but aren't.
// Only components that are on this server's list and installed there count.
async function unmetPredecessors(client: any, server: ServerRow, def: SoftwareDefinition): Promise<string[]> {
  const members = new Map(loadOrderedSoftware(server.group_id, 'asc').map((d) => [d.id, d]));
  const unmet: string[] = [];
  for (const id of startPredecessors(def.id)) {
    const predecessor = members.get(id);
    if (!predecessor) continue;
    if (await notInstalledHere(client, predecessor)) continue;
    if (!(await detectPresence(client, predecessor))) unmet.push(predecessor.name);
  }
  return unmet;
}

// Components that must be stopped BEFORE `def` may stop (the ones that sit on top of it) but still run.
async function runningDependents(client: any, server: ServerRow, def: SoftwareDefinition): Promise<string[]> {
  const members = new Map(loadOrderedSoftware(server.group_id, 'asc').map((d) => [d.id, d]));
  const running: string[] = [];
  for (const id of stopPredecessors(def.id)) {
    const dependent = members.get(id);
    if (!dependent) continue;
    if (await notInstalledHere(client, dependent)) continue;
    if (await detectPresence(client, dependent)) running.push(dependent.name);
  }
  return running;
}

// The conditions applied to a single Start / Restart / Stop: refuse, with the reason, instead of
// taking a component down while what sits on top of it still runs (or starting one whose
// prerequisite is down). Whole-server runs already follow the conditions, so they don't need this.
async function guardSingle(server: ServerRow, def: SoftwareDefinition, mode: 'start' | 'restart' | 'stop') {
  let problem: string | null = null;
  try {
    const client = await getConnection(server as any);
    // A component that isn't running has nothing to protect (Stop / Restart) or nothing to wait for (Start).
    const isUp = await detectPresence(client, def);
    if (mode !== 'start' && isUp) {
      const still = await runningDependents(client, server, def);
      if (still.length > 0) {
        problem =
          `Can't ${mode} ${def.name}: ${still.join(' and ')} ${pluralIs(still)} still running and must be stopped first ` +
          `(see Conditions). Stop ${still.join(' and ')} first, or use ${mode === 'stop' ? 'Stop All' : 'Restart All'}.`;
      }
    }
    if (!problem && mode !== 'stop' && (mode === 'restart' || !isUp)) {
      const unmet = await unmetPredecessors(client, server, def);
      if (unmet.length > 0) {
        problem =
          `Can't ${mode} ${def.name}: ${unmet.join(' and ')} must be running first (see Conditions). ` +
          `Start ${unmet.join(' and ')} first, or use Start All.`;
      }
    }
  } catch {
    // can't tell (for example the server is unreachable) - the job itself will report that
  }
  if (problem) throw new RefusedError(problem);
}

function loadPair(serverId: number, softwareId: number) {
  const server = sqlite.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as ServerRow | undefined;
  const def = sqlite.prepare('SELECT * FROM software_definitions WHERE id = ?').get(softwareId) as
    | SoftwareDefinition
    | undefined;
  if (!server || !def) throw new Error('Server or software not found');
  return { server, def };
}

// Checks (busy, conditions) and creates the job for a single-component action. The busy check runs
// again after the conditions were read from the server, because that takes a moment.
async function beginSingle(serverId: number, softwareId: number, kind: string, mode: 'start' | 'restart' | 'stop') {
  const { server, def } = loadPair(serverId, softwareId);
  assertNotBusy(server.group_id);
  await guardSingle(server, def, mode);
  assertNotBusy(server.group_id);
  return { server, def, job: createJob(kind, server.group_id) };
}

export async function runStartAll(groupId: number) {
  if (isGroupBusy(groupId)) throw new RefusedError('A job is already running on this server.');
  const job = createJob('start_all', groupId);
  void (async () => {
    try {
      const result = await runGroupSequence(
        job.id,
        groupId,
        loadGroupServers(groupId),
        loadOrderedSoftware(groupId, 'asc'),
        startDependents(),
        'start',
        startStep,
        true
      );
      finishSequenceJob(job.id, 'start', result);
    } catch (err: any) {
      finishJob(job.id, 'failed', String(err?.message ?? err));
    }
  })();
  return job;
}

export async function runStartOne(serverId: number, softwareId: number) {
  const { server, def, job } = await beginSingle(serverId, softwareId, 'start_one', 'start');
  void (async () => {
    try {
      const ok = await startStep(job.id, server, def);
      finishJob(job.id, ok ? 'succeeded' : 'failed', ok ? undefined : singleFailureMessage(job.id, server, def));
    } catch (err: any) {
      finishJob(job.id, 'failed', String(err?.message ?? err));
    }
  })();
  return job;
}

export async function runRestartAll(groupId: number) {
  if (isGroupBusy(groupId)) throw new RefusedError('A job is already running on this server.');
  const job = createJob('restart_all', groupId);
  void (async () => {
    try {
      const result = await runGroupSequence(
        job.id,
        groupId,
        loadGroupServers(groupId),
        loadOrderedSoftware(groupId, 'asc'),
        startDependents(),
        'restart',
        restartStep,
        true
      );
      finishSequenceJob(job.id, 'restart', result);
    } catch (err: any) {
      finishJob(job.id, 'failed', String(err?.message ?? err));
    }
  })();
  return job;
}

export async function runStopAll(groupId: number) {
  if (isGroupBusy(groupId)) throw new RefusedError('A job is already running on this server.');
  const job = createJob('stop_all', groupId);
  void (async () => {
    try {
      const result = await runGroupSequence(
        job.id,
        groupId,
        loadGroupServers(groupId),
        loadStopOrderedSoftware(groupId),
        stopDependents(),
        'stop',
        stopStep
      );
      finishSequenceJob(job.id, 'stop', result);
    } catch (err: any) {
      finishJob(job.id, 'failed', String(err?.message ?? err));
    }
  })();
  return job;
}

export async function runRestartOne(serverId: number, softwareId: number) {
  const { server, def, job } = await beginSingle(serverId, softwareId, 'restart_one', 'restart');
  void (async () => {
    try {
      // systemd propagates a stop to units that Requires= the one being stopped (e.g.
      // rule-interpreter requires both rule selectors) but does not start them again
      // afterwards. Remember what was running so the restart can put those back.
      const others = def.detect_method === 'systemd' ? loadOrderedSoftware(server.group_id, 'asc').filter((d) => d.id !== def.id) : [];
      const wasUp: SoftwareDefinition[] = [];
      if (others.length > 0) {
        const client = await getConnection(server as any);
        for (const other of others) {
          if (await detectPresence(client, other).catch(() => false)) wasUp.push(other);
        }
      }

      const ok = await restartStep(job.id, server, def);
      if (!ok) {
        finishJob(job.id, 'failed', singleFailureMessage(job.id, server, def));
        return;
      }

      if (wasUp.length > 0) {
        const client = await getConnection(server as any);
        for (const other of wasUp) {
          if (await detectPresence(client, other).catch(() => true)) continue;
          const restored = await startStep(job.id, server, other);
          if (!restored) {
            finishJob(job.id, 'failed', `${other.name} was stopped as a side effect of restarting ${def.name} and did not come back healthy`);
            return;
          }
        }
      }
      finishJob(job.id, 'succeeded');
    } catch (err: any) {
      finishJob(job.id, 'failed', String(err?.message ?? err));
    }
  })();
  return job;
}

export async function runStopOne(serverId: number, softwareId: number) {
  const { server, def, job } = await beginSingle(serverId, softwareId, 'stop_one', 'stop');
  void (async () => {
    const ok = await stopStep(job.id, server, def);
    finishJob(job.id, ok ? 'succeeded' : 'failed', ok ? undefined : `${def.name} failed to stop`);
  })();
  return job;
}

export async function runScan(groupId: number) {
  assertNotBusy(groupId);
  const job = createJob('scan', groupId);
  void (async () => {
    try {
      const links = sqlite
        .prepare(
          `SELECT sd.* FROM group_software gs
           JOIN software_definitions sd ON sd.id = gs.software_id
           WHERE gs.group_id = ?`
        )
        .all(groupId) as unknown as SoftwareDefinition[];
      const groupServers = loadGroupServers(groupId);
      for (const def of links) {
        for (const server of groupServers) {
          const step = createStep(job.id, server.id, def.id, 'health_check');
          updateStep(job.id, step.id, { status: 'running', started_at: nowIso() });
          try {
            const client = await getConnection(server as any);
            const { up: present, state, detail, datasources } = await checkComponent(client, def);
            recordStatus(server.id, def.id, 'scan', present ? 'up' : 'down', detail);
            const failureText = (datasources ?? []).map((f) => `${f.name}: ${f.reason}`).join('\n');
            updateStep(job.id, step.id, {
              status: present ? 'healthy' : 'failed',
              log_excerpt: datasources?.length
                ? `running, but ${datasources.length} datasource${datasources.length > 1 ? 's' : ''} can't connect - ${friendlyDsReason(failureText)}: ` +
                  `${datasources.map((f) => f.name).join(', ')}\n\n${failureText}`
                : state.replace('_', ' '),
              finished_at: nowIso(),
            });
          } catch (err: any) {
            updateStep(job.id, step.id, {
              status: 'failed',
              log_excerpt: String(err?.message ?? err),
              finished_at: nowIso(),
            });
          }
        }
      }
      finishJob(job.id, 'succeeded');
    } catch (err: any) {
      finishJob(job.id, 'failed', String(err?.message ?? err));
    }
  })();
  return job;
}
