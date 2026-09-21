import type { Client } from 'ssh2';
import { acquireChannel } from './channels.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export async function runCommand(client: Client, command: string, timeoutMs = 15000): Promise<ExecResult> {
  const release = await acquireChannel(client);
  try {
    return await execOnce(client, command, timeoutMs);
  } finally {
    release();
  }
}

function execOnce(client: Client, command: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        return reject(err);
      }
      stream.on('data', (data: Buffer) => {
        stdout += data.toString('utf8');
      });
      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString('utf8');
      });
      stream.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });
    });
  });
}
