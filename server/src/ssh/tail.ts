import type { Client, ClientChannel } from 'ssh2';
import { runCommand } from './exec.js';
import { acquireChannel } from './channels.js';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\''`)}'`;
}

export async function tailLines(client: Client, filePath: string, lines: number): Promise<string> {
  const result = await runCommand(client, `tail -n ${Math.max(1, Math.floor(lines))} ${shellQuote(filePath)} 2>&1`);
  return result.stdout;
}

export async function streamTail(
  client: Client,
  filePath: string,
  onLine: (line: string) => void
): Promise<() => void> {
  const release = await acquireChannel(client); // held for as long as the tail is open
  return new Promise((resolve, reject) => {
    client.exec(`tail -n 0 -F ${shellQuote(filePath)}`, (err, stream: ClientChannel) => {
      if (err) {
        release();
        return reject(err);
      }
      let buffer = '';
      const handleChunk = (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';
        for (const line of parts) onLine(line);
      };
      stream.on('data', handleChunk);
      stream.stderr.on('data', handleChunk);
      stream.on('close', release);
      resolve(() => stream.close());
    });
  });
}
