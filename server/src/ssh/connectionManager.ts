import { Client, type ConnectConfig } from 'ssh2';
import type { Server } from '@healthcheck/shared';
import { decryptSecret } from '../crypto/secretBox.js';
import { privateKeyFor } from './keyManager.js';
import { explainSsh, explainTcp, probeTcp, problemText, type ConnectionProblem } from './explain.js';

type ServerWithSecret = Server & { ssh_passphrase_enc?: string | null };

interface PoolEntry {
  ready: Promise<Client>;
}

const pool = new Map<number, PoolEntry>();

export class SshConnectionError extends Error {
  kind: 'unreachable' | 'auth_failed' | 'timeout' | 'command_failed';
  constructor(kind: SshConnectionError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

function classifyConnectError(err: any): SshConnectionError {
  const msg = String(err?.message ?? err);
  if (/authentication/i.test(msg)) return new SshConnectionError('auth_failed', msg);
  return new SshConnectionError('unreachable', msg);
}

function connect(server: ServerWithSecret): Promise<Client> {
  const client = new Client();
  const config: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.ssh_username,
    privateKey: privateKeyFor(server),
    readyTimeout: 10000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
  };
  if (server.ssh_passphrase_enc) {
    config.passphrase = decryptSecret(server.ssh_passphrase_enc);
  }

  let settleReady: ((client: Client) => void) | null = null;
  let settleError: ((err: unknown) => void) | null = null;

  const ready = new Promise<Client>((resolve, reject) => {
    settleReady = resolve;
    settleError = reject;
  });

  // Both listeners stay attached for the client's whole lifetime (not `.once`) -
  // ssh2 can emit 'error' more than once (e.g. a later keepalive failure on an
  // already-connected client), and an unhandled 'error' event crashes the process.
  client.on('ready', () => {
    settleReady?.(client);
    settleReady = null;
    settleError = null;
  });

  client.on('error', (err) => {
    settleError?.(classifyConnectError(err));
    settleReady = null;
    settleError = null;
    pool.delete(server.id);
  });

  client.on('close', () => pool.delete(server.id));

  client.connect(config);

  return ready;
}

export async function getConnection(server: ServerWithSecret): Promise<Client> {
  const existing = pool.get(server.id);
  if (existing) {
    try {
      return await existing.ready;
    } catch {
      pool.delete(server.id);
    }
  }
  const ready = connect(server);
  pool.set(server.id, { ready });
  return ready;
}

export async function testConnection(
  server: ServerWithSecret
): Promise<{ ok: boolean; kind?: string; message?: string; problem?: ConnectionProblem }> {
  // no open connection to reuse: is the SSH port there at all? (5 s, instead of waiting out SSH's 10)
  if (!pool.has(server.id)) {
    const tcp = await probeTcp(server.host, server.port);
    if (tcp !== 'open') {
      const problem = explainTcp(tcp, server.host, server.port);
      return { ok: false, kind: 'unreachable', message: problemText(problem), problem };
    }
  }
  try {
    const client = await getConnection(server);
    await new Promise<void>((resolve, reject) => {
      client.exec('echo ok', (err, stream) => {
        if (err) return reject(err);
        stream.on('close', () => resolve());
        stream.on('data', () => {});
        stream.stderr.on('data', () => {});
      });
    });
    return { ok: true };
  } catch (err: any) {
    const kind = err instanceof SshConnectionError ? err.kind : 'unreachable';
    const raw = String(err?.message ?? err);
    const problem = await explainFailure(server, kind, raw);
    return { ok: false, kind, message: problemText(problem), problem };
  }
}

// Why connecting with Healthcheck's key failed: a sign-in refusal says so; anything else, a plain connection to
// the SSH port tells a wrong address / switched-off server / firewall from a closed port.
async function explainFailure(server: ServerWithSecret, kind: string, raw: string): Promise<ConnectionProblem> {
  if (kind === 'auth_failed') return explainSsh(raw, server.host, server.port, server.ssh_username, false);
  if (/SSH key is missing/.test(raw))
    return { kind: 'other', title: "Healthcheck's SSH key is missing on this machine", why: raw, fix: 'Copy the data folder (with healthcheck_id_rsa) from the old machine, or add the server again with its password.', technical: raw };
  const tcp = await probeTcp(server.host, server.port);
  return tcp === 'open' ? explainSsh(raw, server.host, server.port, server.ssh_username, false) : explainTcp(tcp, server.host, server.port);
}

export function closeAllConnections() {
  for (const [id, entry] of pool.entries()) {
    entry.ready.then((c) => c.end()).catch(() => {});
    pool.delete(id);
  }
}
