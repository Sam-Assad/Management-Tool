import type { Client } from 'ssh2';
import { runCommand } from '../ssh/exec.js';
import { systemctlCommand } from './detectors.js';

// "Port(s) already bound: 9663, 7443", "Address already in use", "Port 8080 was already in use",
// java.net.BindException, EADDRINUSE ...
export const PORT_CONFLICT_RE = /already bound|already in use|address in use|bindexception|eaddrinuse|failed to bind|unable to bind/i;

const KEYWORD_RE = /\bports?\b|already bound|already in use|bindexception|eaddrinuse|failed to bind|unable to bind/i;

// Port numbers mentioned in a log line that reports a port conflict. Only what comes after the first
// keyword counts, so the timestamp and thread ids in front of it are never mistaken for ports.
export function extractPorts(line: string): number[] {
  const at = line.search(KEYWORD_RE);
  if (at < 0) return [];
  const text = line
    .slice(at)
    .replace(/\d{1,3}(?:\.\d{1,3}){3}/g, 'IP') // 0.0.0.0:8080 -> IP:8080 (the octets are not ports)
    .replace(/\(\s*bind failed\s*\)/gi, '');
  const ports: number[] = [];
  for (const m of text.matchAll(/(?<![\w.])(\d{2,5})(?![\w.])/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 65535 && !ports.includes(n)) ports.push(n);
  }
  return ports.slice(0, 8);
}

export interface PortHolder {
  port: number;
  // unknown when the listener belongs to a user this SSH user cannot inspect
  pid?: number;
  process?: string;
  user?: string;
  runningFor?: string;
  // what started it: a systemd unit ("keycloak.service") or a login/session scope (started by hand)
  unit?: string;
  startedByHand: boolean;
  command?: string;
  // can the operator's "free the port" action deal with it without more privileges than the tool has?
  freeable: boolean;
}

// Never show secrets that are passed on a command line (Keycloak's --https-key-store-password=..., -Dx.password=...).
export function maskSecrets(text: string): string {
  return text.replace(/((?:pass(?:word|wd)?|secret|token|credential)[\w.-]*=)\S+/gi, '$1***');
}

function parseListeners(output: string): Array<{ port: number; pid?: number; process?: string }> {
  const found: Array<{ port: number; pid?: number; process?: string }> = [];
  for (const line of output.split('\n')) {
    // ss -ltnp :  LISTEN 0 50 *:9663 *:* users:(("java",pid=1234,fd=12))
    // netstat -ltnp: tcp 0 0 0.0.0.0:9663 0.0.0.0:* LISTEN 1234/java
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[3];
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    if (!Number.isInteger(port)) continue;
    const ss = /\("([^"]+)",pid=(\d+)/.exec(line);
    const ns = /\s(\d+)\/(\S+)\s*$/.exec(line);
    if (ss) found.push({ port, pid: Number(ss[2]), process: ss[1] });
    else if (ns) found.push({ port, pid: Number(ns[1]), process: ns[2] });
    else found.push({ port });
  }
  return found;
}

// (the header line of either tool has no numeric port in that column, so the parser skips it)
const LISTEN_CMD = '(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null)';

async function listeners(client: Client) {
  const res = await runCommand(client, LISTEN_CMD);
  return parseListeners(res.stdout);
}

// Are all of these ports free right now?
export async function portsFree(client: Client, ports: number[]): Promise<boolean> {
  const busy = new Set((await listeners(client)).map((l) => l.port));
  return ports.every((p) => !busy.has(p));
}

// A previous instance can take a while to let go of its ports while it shuts down: give it a chance.
export async function waitForPortsFree(client: Client, ports: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await portsFree(client, ports)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Who is listening on these ports, and how did it get there.
export async function findPortHolders(client: Client, ports: number[]): Promise<PortHolder[]> {
  const all = await listeners(client);
  const me = (await runCommand(client, 'id -un; id -u')).stdout.trim().split('\n');
  const myName = me[0];
  const isRoot = me[1] === '0';
  const holders: PortHolder[] = [];
  for (const port of ports) {
    const hit = all.find((l) => l.port === port);
    if (!hit) continue;
    const holder: PortHolder = { port, pid: hit.pid, process: hit.process, startedByHand: false, freeable: false };
    if (hit.pid) {
      const info = await runCommand(
        client,
        `ps -o user=,etime=,args= -p ${hit.pid} 2>/dev/null; echo '---'; cat /proc/${hit.pid}/cgroup 2>/dev/null`
      );
      const [psPart, cgroupPart = ''] = info.stdout.split('---');
      const ps = /^\s*(\S+)\s+(\S+)\s+(.*)$/m.exec(psPart);
      if (ps) {
        holder.user = ps[1];
        holder.runningFor = ps[2];
        holder.command = maskSecrets(ps[3].trim()).slice(0, 200);
      }
      let unit = /([^/\s]+\.(?:service|scope))\s*$/m.exec(cgroupPart)?.[1];
      // a login session's processes live under user@UID.service: that is somebody's terminal, not a service to stop
      if (unit && /^user@\d+\.service$/.test(unit)) unit = undefined;
      holder.unit = unit;
      holder.startedByHand = !unit || unit.endsWith('.scope');
      // a service is stopped through systemd (needs the same sudo rule as everything else); anything
      // else is signalled, which only works for our own processes (or as root)
      holder.freeable = Boolean(unit?.endsWith('.service')) || isRoot || holder.user === myName;
    }
    holders.push(holder);
  }
  return holders;
}

// The first lines are what the operator sees in the question box: keep them short and plain.
export function describePortConflict(component: string, ports: number[], holders: PortHolder[]): string {
  const which = ports.length === 1 ? `Port ${ports[0]} is` : `Ports ${ports.join(', ')} are`;
  const lines = [`${which} already in use, so ${component} could not start.`];
  if (holders.length === 0) {
    lines.push('Nothing is listening on them any more - it was probably a previous instance that was still shutting down. Try again.');
    return lines.join('\n');
  }
  const seen = new Set<string>();
  for (const h of holders) {
    const key = `${h.pid ?? h.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ports2 = holders.filter((x) => (x.pid ?? x.port) === (h.pid ?? h.port)).map((x) => x.port).join(', ');
    if (!h.pid) {
      lines.push(`Port ${ports2} is held by a process this SSH user cannot see (run "sudo ss -ltnp" on the server to find it).`);
      continue;
    }
    const origin = h.startedByHand
      ? 'started by hand, not by systemd'
      : `run by ${h.unit}`;
    lines.push(`Port ${ports2}: ${h.process ?? 'process'} (pid ${h.pid}, user ${h.user ?? '?'}, up ${h.runningFor ?? '?'}) - ${origin}.`);
    if (h.command) lines.push(`  ${h.command}`);
  }
  return lines.join('\n');
}

// What the "free the port" button will do, in words.
export function describeFix(holders: PortHolder[]): { label: string; detail: string } | null {
  const fixable = holders.filter((h) => h.pid && h.freeable);
  if (fixable.length === 0) return null;
  const byPid = new Map<number, PortHolder>();
  for (const h of fixable) if (!byPid.has(h.pid!)) byPid.set(h.pid!, h);
  const parts = [...byPid.values()].map((h) =>
    h.unit?.endsWith('.service') ? `stop ${h.unit} (systemctl)` : `stop ${h.process ?? 'process'} (pid ${h.pid}) with kill`
  );
  const ports = [...new Set(fixable.map((h) => h.port))];
  return {
    label: `Free port${ports.length > 1 ? 's' : ''} ${ports.join(', ')} and retry`,
    detail: `Will ${parts.join(' and ')}, wait for the port${ports.length > 1 ? 's' : ''} to be released, then try again.`,
  };
}

// Frees the ports: stops the systemd service that owns the listener, or signals a stray process
// (TERM, then KILL if it is still there after 10 s). Returns what was done, for the job panel.
export async function freePorts(client: Client, ports: number[]): Promise<{ done: string[]; failed: string[] }> {
  const holders = (await findPortHolders(client, ports)).filter((h) => h.pid);
  const done: string[] = [];
  const failed: string[] = [];
  const handled = new Set<number>();
  for (const h of holders) {
    if (handled.has(h.pid!)) continue;
    handled.add(h.pid!);
    const what = `${h.process ?? 'process'} (pid ${h.pid}${h.unit ? `, ${h.unit}` : ''})`;
    if (!h.freeable) {
      failed.push(`${what}: this SSH user is not allowed to stop it`);
      continue;
    }
    if (h.unit?.endsWith('.service')) {
      const res = await runCommand(client, systemctlCommand('stop', h.unit), 120_000);
      (res.code === 0 ? done : failed).push(res.code === 0 ? `Stopped ${h.unit} (${what})` : `${what}: ${(res.stderr || res.stdout).trim()}`);
    } else {
      const res = await runCommand(
        client,
        `kill -TERM ${h.pid} 2>&1; for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 ${h.pid} 2>/dev/null || break; sleep 1; done; ` +
          `if kill -0 ${h.pid} 2>/dev/null; then kill -KILL ${h.pid} 2>&1; sleep 1; fi; kill -0 ${h.pid} 2>/dev/null && echo STILL_RUNNING || echo GONE`,
        30_000
      );
      if (res.stdout.includes('GONE')) done.push(`Stopped ${what}`);
      else failed.push(`${what}: ${(res.stdout + res.stderr).trim() || 'still running'}`);
    }
  }
  if (done.length > 0 && !(await waitForPortsFree(client, ports, 20_000))) {
    failed.push(`port${ports.length > 1 ? 's' : ''} ${ports.join(', ')} still in use after stopping`);
  }
  return { done, failed };
}
