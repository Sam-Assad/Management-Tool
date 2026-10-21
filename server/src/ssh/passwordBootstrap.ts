import { Client } from 'ssh2';
import { runCommand } from './exec.js';
import { ensureAppKeypair } from './keyManager.js';
import { explainSsh, explainTcp, hostProblem, keyInstallProblem, probeTcp, problemText, usernameProblem, type ConnectionProblem } from './explain.js';

export interface BootstrapParams {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface BootstrapResult {
  ok: boolean;
  message?: string;
  // why it failed, in plain words (see explain.ts)
  problem?: ConnectionProblem;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const failed = (problem: ConnectionProblem): BootstrapResult => ({ ok: false, message: problemText(problem), problem });

// Signs in once with the account's password and installs Healthcheck's own key. Before that: the user name and
// address are looked at (a stray character is a typo, not a server problem), and the SSH port is tried with a
// plain connection, which tells "wrong address / switched off / firewall" from "port closed" from a sign-in
// problem in a few seconds.
export async function bootstrapServerWithPassword(params: BootstrapParams): Promise<BootstrapResult> {
  const bad = usernameProblem(params.username) ?? hostProblem(params.host);
  if (bad) return failed(bad);
  const tcp = await probeTcp(params.host, params.port);
  if (tcp !== 'open') return failed(explainTcp(tcp, params.host, params.port));

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
      finish(failed(explainSsh(String(err?.message ?? err), params.host, params.port, params.username, true)));
    });

    // servers that ask for the password as a prompt ("keyboard-interactive") instead of plain password sign-in
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, answer) => {
      answer(prompts.map(() => params.password));
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
            finish(failed(keyInstallProblem(result.stderr.trim(), params.username)));
            return;
          }
          finish({ ok: true });
        } catch (err: any) {
          finish(failed(keyInstallProblem(String(err?.message ?? err), params.username)));
        }
      })();
    });

    client.connect({
      host: params.host,
      port: params.port,
      username: params.username,
      password: params.password,
      tryKeyboard: true,
      readyTimeout: 10000,
    });
  });
}
