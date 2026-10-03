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

export async function checkWildFlyDatasources(client: Client): Promise<DatasourceCheck> {
  try {
    const [regular, xa] = await Promise.all([list(client, 'data-source'), list(client, 'xa-data-source')]);
    if (regular.error && xa.error) {
      return { checked: false, tested: [], failures: [], note: `Could not list WildFly's datasources: ${regular.error.slice(0, 300)}` };
    }
    const targets = [...regular.names.map((name) => ({ kind: 'data-source' as Kind, name })), ...xa.names.map((name) => ({ kind: 'xa-data-source' as Kind, name }))];
    const failures: DatasourceFailure[] = [];
    for (const t of targets) {
      const r = await testOne(client, t.kind, t.name);
      if (r.outcome !== 'success') failures.push({ name: t.name, reason: r.detail || 'test-connection-in-pool failed' });
    }
    return { checked: true, tested: targets.map((t) => t.name), failures };
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
