import { Client } from 'ssh2';
import { runCommand } from './exec.js';
import { ensureAppKeypair } from './keyManager.js';

export interface BootstrapParams {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface BootstrapResult {
  ok: boolean;
  message?: string;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function bootstrapServerWithPassword(params: BootstrapParams): Promise<BootstrapResult> {
  const { publicKeyLine } = ensureAppKeypair();
  const client = new Client();
  let settled = false;

  return new Promise<BootstrapResult>((resolve) => {
    const finish = (result: BootstrapResult) => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        // ignore
      }
      resolve(result);
    };

    // A persistent listener, not `.once` - ssh2 can emit multiple 'error' events
    // over a connection's lifetime, and an unhandled 'error' event crashes the
    // Node process. This must stay attached for the client's whole lifetime.
    client.on('error', (err: any) => {
      finish({ ok: false, message: String(err?.message ?? err) });
    });

    client.on('ready', () => {
      void (async () => {
        try {
          const quotedKey = shellSingleQuote(publicKeyLine);
          const script = [
            'mkdir -p ~/.ssh',
            'chmod 700 ~/.ssh',
            'touch ~/.ssh/authorized_keys',
            `grep -qxF ${quotedKey} ~/.ssh/authorized_keys || echo ${quotedKey} >> ~/.ssh/authorized_keys`,
            'chmod 600 ~/.ssh/authorized_keys',
          ].join(' && ');

          const result = await runCommand(client, script, 15000);
          if (result.code !== 0) {
            finish({ ok: false, message: result.stderr || 'Failed to install the generated key on the server' });
            return;
          }
          finish({ ok: true });
        } catch (err: any) {
          finish({ ok: false, message: String(err?.message ?? err) });
        }
      })();
    });

    client.connect({
      host: params.host,
      port: params.port,
      username: params.username,
      password: params.password,
      readyTimeout: 10000,
    });
  });
}
