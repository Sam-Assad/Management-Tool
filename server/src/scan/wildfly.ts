import type { Client } from 'ssh2';
import type { SoftwareDefinition } from '@healthcheck/shared';
import { runCommand } from '../ssh/exec.js';
import { env } from '../env.js';

// A password/credential that has expired will fail exactly the same way every attempt (DB login,
// LDAP bind, a keystore password, ...) - retrying it is pointless and just wastes the wait. Covers the
// common phrasings plus Oracle's ORA-28001 and Active Directory's "data 773" bind response.
export const CREDENTIAL_EXPIRED_RE = /\bpassword\b[^\n]{0,25}\bexpired\b|\bexpired\b[^\n]{0,25}\bpassword\b|\bORA-28001\b|data 773\b/i;

// ---- WildFly datasource check ------------------------------------------------------------------
// WildFly can be "active" in systemd, and even log its own "started (with errors)" line, while its JCA
// datasource pools can't get a single connection (an expired DB password, a database that's down).
// `jboss-cli.sh ... :test-connection-in-pool` borrows a real connection right now and reports a plain
// success/failure. Every datasource WildFly has configured is discovered with `ls` and tested - nothing
// to set up per market. The jboss-cli.sh path is the same on every server (env.wildflyCliPath).

export function isWildFly(def: SoftwareDefinition): boolean {
  return /wildfly|jboss/i.test(def.name) || (def.detect_method === 'systemd' && /wildfly|jboss/i.test(def.detect_value));
}

type Kind = 'data-source' | 'xa-data-source';

export interface DatasourceFailure {
  name: string;
  reason: string;
}

export interface DatasourceCheck {
  // false = the check itself couldn't run (CLI unusable, management interface not up yet...): `note` says why
  checked: boolean;
  tested: string[];
  failures: DatasourceFailure[];
  note?: string;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cli(address: string): string {
  return `${shQuote(env.wildflyCliPath)} --connect command=${shQuote(address)}`;
}

// Pretty-printed DMR, e.g. { "outcome" => "failed", "failure-description" => "WFLYJCA0040: ... Connection is not valid" }
function parseOutcome(output: string): { outcome: 'success' | 'failed' | 'unknown'; detail: string } {
  const outcome = output.match(/"outcome"\s*=>\s*"(success|failed)"/)?.[1] as 'success' | 'failed' | undefined;
  const failure = output.match(/"failure-description"\s*=>\s*"([\s\S]*?)"\s*,?\s*\r?\n/)?.[1];
  return { outcome: outcome ?? 'unknown', detail: (failure ?? output).replace(/Handler FILE is not defined\s*/g, '').trim().slice(0, 400) };
}

// Without a terminal `ls` prints the names in COLUMNS ("CONVERSIONS      LOYALTY_CONF ..."), several per
// line - split on any whitespace, the way the shell's $(...) does.
async function list(client: Client, kind: Kind): Promise<{ names: string[]; error?: string }> {
  const res = await runCommand(client, cli(`ls /subsystem=datasources/${kind}`), 60_000);
  if (res.code !== 0) {
    const why = `${res.stderr}\n${res.stdout}`.replace(/Handler FILE is not defined\s*/g, '').trim();
    return { names: [], error: why || `jboss-cli.sh exited with code ${res.code}` };
  }
  return { names: res.stdout.split(/\s+/).filter((w) => /^[\w.-]+$/.test(w)) };
}

async function testOne(client: Client, kind: Kind, name: string) {
  const res = await runCommand(client, cli(`/subsystem=datasources/${kind}=${name}:test-connection-in-pool`), 60_000);
  return parseOutcome(`${res.stdout}\n${res.stderr}`);
}

// ---- several CLI commands in ONE jboss-cli.sh -----------------------------------------------------
// Every jboss-cli.sh call starts a JVM (~2 CPU-seconds, ~160 MB for a moment), so a beat that made one call
// per datasource cost ~16 of them. Here the commands are fed to a single jboss-cli.sh on stdin, where it runs
// each line as if typed at its prompt. Unlike `--commands=a,b` or a CLI `for` loop - both stop at the first
// failing command - a failed datasource test doesn't stop the rest, and each command prints exactly the
// reply it prints on its own. `echo $m <key>` before each command marks where its reply starts: the CLI
// echoes the typed line with a literal "$m", so only the real output carries the expanded marker.
const MARK = '@@HC@@';
const MARK_RE = new RegExp(`${MARK} (\\S+)\\s*$`);

// The CLI's output, split by marker: key -> that command's reply. A reply only counts once the next marker
// (or the final END) shows it was printed in full.
export function splitCliSections(output: string): Map<string, string> {
  const sections = new Map<string, string>();
  let key: string | null = null;
  let buf: string[] = [];
  for (const line of output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/)) {
    const m = line.match(MARK_RE);
    if (m) {
      if (key && key !== m[1]) sections.set(key, buf.join('\n'));
      if (key !== m[1]) buf = [];
      key = m[1];
      continue;
    }
    if (key && !line.startsWith('[')) buf.push(line); // skip the CLI's "[standalone@host:9990 /] <command>" echo
  }
  return sections;
}

async function cliScript(client: Client, commands: { key: string; command: string }[], timeoutMs: number): Promise<Map<string, string>> {
  const lines = [`set m=${MARK}`, ...commands.flatMap((c) => [`echo $m ${c.key}`, c.command]), 'echo $m END'];
  const res = await runCommand(client, `printf '%s\\n' ${lines.map(shQuote).join(' ')} | ${shQuote(env.wildflyCliPath)} --connect 2>&1`, timeoutMs);
  return splitCliSections(`${res.stdout}\n${res.stderr}`);
}

// `:read-children-names` reply -> the names, or the failure (deduplicated: some CLI logging setups print a reply twice)
export function parseChildNames(reply: string): { names: string[]; error?: string } {
  const r = parseOutcome(reply);
  if (r.outcome !== 'success') return { names: [], error: r.detail || 'no reply' };
  const block = reply.match(/"result"\s*=>\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  return { names: [...new Set([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]))].filter((n) => /^[\w.-]+$/.test(n)) };
}

const BINDINGS_COMMAND = '/socket-binding-group=*/socket-binding=*:read-resource(include-runtime=true)';

export async function checkWildFlyDatasources(client: Client): Promise<DatasourceCheck & { bindingsOutput?: string }> {
  try {
    // Call 1: what's there - both kinds of datasource, plus WildFly's listening addresses for the traffic check.
    let regular: { names: string[]; error?: string };
    let xa: { names: string[]; error?: string };
    let bindingsOutput: string | undefined;
    let discovered: Map<string, string> | null = null;
    try {
      discovered = await cliScript(
        client,
        [
          { key: 'ds', command: '/subsystem=datasources:read-children-names(child-type=data-source)' },
          { key: 'xa', command: '/subsystem=datasources:read-children-names(child-type=xa-data-source)' },
          { key: 'bindings', command: BINDINGS_COMMAND },
        ],
        90_000,
      );
    } catch {
      discovered = null;
    }
    if (discovered?.has('ds') && discovered.has('xa')) {
      regular = parseChildNames(discovered.get('ds')!);
      xa = parseChildNames(discovered.get('xa')!);
      bindingsOutput = discovered.get('bindings');
    } else {
      // the one-call script didn't run (couldn't connect, an unexpected CLI) - the original one-call-per-list way
      [regular, xa] = await Promise.all([list(client, 'data-source'), list(client, 'xa-data-source')]);
    }
    if (regular.error && xa.error) {
      return { checked: false, tested: [], failures: [], note: `Could not list WildFly's datasources: ${regular.error.slice(0, 300)}` };
    }
    const targets = [...regular.names.map((name) => ({ kind: 'data-source' as Kind, name })), ...xa.names.map((name) => ({ kind: 'xa-data-source' as Kind, name }))];

    // Call 2: test them all. Each keeps the 60 s it had as a separate call.
    let replies = new Map<string, string>();
    if (targets.length > 0) {
      try {
        replies = await cliScript(
          client,
          targets.map((t, i) => ({ key: `t${i}`, command: `/subsystem=datasources/${t.kind}=${t.name}:test-connection-in-pool` })),
          60_000 * (targets.length + 1),
        );
      } catch {
        replies = new Map();
      }
    }
    const failures: DatasourceFailure[] = [];
    for (const [i, t] of targets.entries()) {
      let r = replies.has(`t${i}`) ? parseOutcome(replies.get(`t${i}`)!) : null;
      // no complete reply for this one in the batch: test it on its own, exactly as before
      if (!r || r.outcome === 'unknown') r = await testOne(client, t.kind, t.name);
      if (r.outcome !== 'success') failures.push({ name: t.name, reason: r.detail || 'test-connection-in-pool failed' });
    }
    return { checked: true, tested: targets.map((t) => t.name), failures, bindingsOutput };
  } catch (err: any) {
    return { checked: false, tested: [], failures: [], note: `Could not run the datasource check: ${String(err?.message ?? err)}` };
  }
}

// Plain-English cause for the headline the operator reads first (the raw WFLYJCA/ORA text stays available
// as technical detail).
export function friendlyDsReason(text: string): string {
  if (CREDENTIAL_EXPIRED_RE.test(text)) return 'the database password has expired';
  if (/connection is not valid|WFLYJCA0047/i.test(text)) return 'the database refused the connection (expired password, locked account, or the database is down)';
  if (/time.?out/i.test(text)) return 'the connection to the database timed out';
  if (/unable to connect|connection refused|no route to host|unknown host/i.test(text)) return "the database server couldn't be reached";
  return 'the connection test to the database failed';
}

// What heartbeat_log.detail stores for this state: the failed names ride along, so the status column and
// the warning banner can say which ones without re-running the (slow-ish) check.
export function datasourceDownDetail(failures: DatasourceFailure[]): string {
  return `datasource_down:${failures.map((f) => f.name).join(',')}`;
}

// ---- WildFly "can it receive traffic?" check ------------------------------------------------------
// Runs once the datasources are fine. Nothing here is per market: the addresses come from WildFly's own
// runtime socket bindings (whatever hostname/IP that market's server binds to), and the requests are
// sent with curl on the server itself, over the same SSH connection - nothing has to be reachable from here.
//  1. Readiness: GET http://<management-http address>/health/ready (WildFly's health subsystem).
//     200 = ready. 503 = WildFly itself says it isn't ready (the failing checks are named).
//     401/403/404/no answer = not usable on this install (needs a login, or not enabled): noted, not failed.
//  2. The web listener (the "http" binding, else "https") must answer a request - any HTTP status, even 404,
//     proves it accepts and serves requests; no answer at all means it can't take traffic.

interface Binding {
  address: string;
  port: number;
}

export interface TrafficCheck {
  // false = couldn't tell (couldn't read WildFly's addresses, curl missing...): `note` says why
  checked: boolean;
  ok: boolean;
  // what was confirmed, for the step's log when all is well
  summary: string;
  // why it can't take traffic, in plain words (empty when ok)
  problems: string[];
  note?: string;
  // the root cause WildFly reported, for "Show technical details"
  technical?: string;
}

// `/socket-binding-group=*/socket-binding=*:read-resource(include-runtime=true)` answers with one entry per
// binding: an "address" naming it, then its runtime "bound-address" / "bound-port". Unbound sockets have no
// quoted bound-address and are skipped.
export function parseSocketBindings(output: string): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  for (const chunk of output.split(/"address"\s*=>/).slice(1)) {
    const name = chunk.match(/"socket-binding"\s*=>\s*"([^"]+)"/)?.[1];
    const address = chunk.match(/"bound-address"\s*=>\s*"([^"]+)"/)?.[1];
    const port = chunk.match(/"bound-port"\s*=>\s*(\d+)/)?.[1];
    if (name && address && port && !bindings.has(name)) bindings.set(name, { address, port: Number(port) });
  }
  return bindings;
}

// A listener on "all addresses" is reached on loopback; an IPv6 address needs brackets in a URL.
export function urlHost(address: string): string {
  if (address === '0.0.0.0' || address === '::' || /^0(:0){7}$/.test(address)) return '127.0.0.1';
  return address.includes(':') ? `[${address}]` : address;
}

async function httpGet(client: Client, url: string, timeoutS = 10): Promise<{ code: number; body: string; noCurl: boolean }> {
  const res = await runCommand(client, `curl -sk -m ${timeoutS} -w '\\n__HTTP__%{http_code}' ${shQuote(url)}`, (timeoutS + 10) * 1000);
  if (res.code === 127) return { code: 0, body: '', noCurl: true };
  const m = res.stdout.match(/__HTTP__(\d{3})\s*$/);
  return { code: m ? Number(m[1]) : 0, body: res.stdout.replace(/\n?__HTTP__\d{3}\s*$/, ''), noCurl: false };
}

export interface Readiness {
  // the failing checks' names (boot-errors, deployments-status, ...)
  down: string[];
  // deployments WildFly reports as not OK: "loyalty-management.ear"
  failedDeployments: string[];
  // the parts of them that didn't start: "http-interface.war"
  failedParts: string[];
  // the innermost "Caused by" of each failed part, deduplicated
  causes: string[];
}

// The innermost "Caused by: ..." line of a stack-trace-like message (or its first line if there is none).
function rootCause(message: string): string {
  const causes = [...message.matchAll(/Caused by:\s*([^\n]+)/g)].map((m) => m[1].trim());
  return (causes.length ? causes[causes.length - 1] : message.split('\n')[0]).trim();
}

// WildFly's /health/ready body comes in two shapes:
//  - WildFly's own health subsystem (WildFly 26 without MicroProfile):
//      [{"name":"boot-errors","outcome":false,"data":[...]},{"name":"deployments-status","outcome":false,
//        "data":[{"app.ear":"FAILED"}]},{"outcome":false}]
//  - MicroProfile Health: {"status":"DOWN","checks":[{"name":"...","status":"DOWN","data":{...}}]}
export function readReadiness(body: string): Readiness {
  const out: Readiness = { down: [], failedDeployments: [], failedParts: [], causes: [] };
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    return out;
  }
  const checks: { name: string; up: boolean; data: any }[] = Array.isArray(json)
    ? json.filter((c: any) => c?.name).map((c: any) => ({ name: String(c.name), up: c.outcome !== false, data: c.data }))
    : (Array.isArray(json?.checks) ? json.checks : []).map((c: any) => ({
        name: String(c?.name ?? 'unnamed check'),
        up: String(c?.status).toUpperCase() !== 'DOWN',
        data: c?.data,
      }));
  const entries = (data: any): [string, any][] =>
    (Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : []).flatMap((d: any) =>
      d && typeof d === 'object' ? Object.entries(d) : [],
    );

  for (const check of checks.filter((c) => !c.up)) {
    out.down.push(check.name);
    if (check.name === 'deployments-status') {
      for (const [name, status] of entries(check.data)) if (String(status).toUpperCase() !== 'OK') out.failedDeployments.push(name);
    }
    if (check.name === 'boot-errors') {
      for (const [, value] of entries(check.data)) {
        let errors: any;
        try {
          errors = typeof value === 'string' ? JSON.parse(value) : value;
        } catch {
          continue;
        }
        for (const err of Array.isArray(errors) ? errors : [errors]) {
          for (const [service, message] of Object.entries(err?.['failed-services'] ?? {})) {
            // jboss.deployment.subunit."app.ear"."part.war".undertow-deployment -> part.war
            const quoted = [...service.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
            const part = quoted[quoted.length - 1];
            if (part && !out.failedParts.includes(part) && !out.failedDeployments.includes(part)) out.failedParts.push(part);
            const cause = rootCause(String(message));
            if (cause && !out.causes.includes(cause)) out.causes.push(cause);
          }
        }
      }
    }
  }
  return out;
}

const DB_CAUSE_RE = /DialectResolutionInfo|JDBCConnectionException|Unable to acquire JDBC|ORA-\d+|WFLYJCA|Connection refused|Could not open connection|SQLException/i;

// One plain sentence a manager can read, from what /health/ready said.
export function notReadyReason(r: Readiness): string {
  const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);
  let text: string;
  if (r.failedDeployments.length) {
    const apps = r.failedDeployments;
    text = `The application${apps.length > 1 ? 's' : ''} ${list(apps)} failed to start`;
    if (r.failedParts.length) text += ` (${list(r.failedParts)} didn't come up)`;
    text += ', so WildFly is running but has nothing working to serve.';
  } else {
    text = `WildFly says it isn't ready to receive traffic${r.down.length ? ` (failing: ${r.down.join(', ')})` : ''}.`;
  }
  if (r.causes.some((c) => DB_CAUSE_RE.test(c))) text += ' This usually means the application couldn\'t reach its database while it was starting.';
  return text;
}

// `bindingsOutput`: the addresses as the datasource check already read them (they don't change while WildFly
// runs) - saves starting jboss-cli.sh again. Read here when missing or unreadable.
export async function checkWildFlyTraffic(client: Client, bindingsOutput?: string): Promise<TrafficCheck> {
  const notChecked = (note: string): TrafficCheck => ({ checked: false, ok: true, summary: '', problems: [], note });
  try {
    let bindings = parseSocketBindings(bindingsOutput ?? '');
    if (bindings.size === 0) {
      const res = await runCommand(client, cli(BINDINGS_COMMAND), 60_000);
      bindings = parseSocketBindings(`${res.stdout}\n${res.stderr}`);
    }
    const mgmt = bindings.get('management-http');
    const webName = bindings.has('http') ? 'http' : bindings.has('https') ? 'https' : null;
    const web = webName ? bindings.get(webName)! : undefined;
    if (!mgmt && !web) return notChecked("Couldn't read the addresses WildFly listens on, so whether it takes traffic wasn't checked.");

    const problems: string[] = [];
    const confirmed: string[] = [];
    let note: string | undefined;
    let technical: string | undefined;

    if (mgmt) {
      const where = `${urlHost(mgmt.address)}:${mgmt.port}`;
      const r = await httpGet(client, `http://${where}/health/ready`);
      if (r.noCurl) return notChecked("curl isn't installed on the server, so whether WildFly takes traffic wasn't checked.");
      if (r.code === 200) confirmed.push(`WildFly says it's ready (/health/ready on ${where})`);
      else if (r.code === 503) {
        const readiness = readReadiness(r.body);
        problems.push(notReadyReason(readiness));
        if (readiness.causes.length) technical = `Cause reported by WildFly:\n${readiness.causes.join('\n')}`;
      } else {
        note = `WildFly's readiness check (/health/ready on ${where}) isn't usable here (${r.code ? `HTTP ${r.code}` : 'no answer'}), so only its web listener was checked.`;
      }
    }

    if (web) {
      const where = `${urlHost(web.address)}:${web.port}`;
      const r = await httpGet(client, `${webName}://${where}/`);
      if (r.noCurl) return notChecked("curl isn't installed on the server, so whether WildFly takes traffic wasn't checked.");
      if (r.code === 0) problems.push(`It doesn't answer web requests on ${where}.`);
      else confirmed.push(`it answers web requests on ${where}`);
    }

    if (problems.length === 0 && confirmed.length === 0) return notChecked(note ?? 'Nothing could be checked.');
    return {
      checked: true,
      ok: problems.length === 0,
      summary: problems.length === 0 && confirmed.length ? `Ready to receive traffic: ${confirmed.join('; ')}.` : '',
      problems,
      note,
      technical,
    };
  } catch (err: any) {
    return notChecked(`Could not check whether WildFly takes traffic: ${String(err?.message ?? err)}`);
  }
}

// heartbeat_log.detail for "running, datasources fine, but can't take traffic": the reason rides along.
export function notReadyDetail(problems: string[]): string {
  return `not_ready:${problems.join(' ')}`;
}
