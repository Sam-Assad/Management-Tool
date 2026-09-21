import { Client, type ConnectConfig } from 'ssh2';
import fs from 'node:fs';
import type { Server } from '@healthcheck/shared';
import { decryptSecret } from '../crypto/secretBox.js';

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
    privateKey: fs.readFileSync(server.ssh_key_path),
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
): Promise<{ ok: boolean; kind?: string; message?: string }> {
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
    return { ok: false, kind, message: String(err?.message ?? err) };
  }
}

export function closeAllConnections() {
  for (const [id, entry] of pool.entries()) {
    entry.ready.then((c) => c.end()).catch(() => {});
    pool.delete(id);
  }
}
