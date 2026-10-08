import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDirPath, sqlite } from '../db/client.js';

const PRIVATE_KEY_PATH = path.join(dataDirPath, 'healthcheck_id_rsa');
const PUBLIC_KEY_PATH = path.join(dataDirPath, 'healthcheck_id_rsa.pub');

function base64UrlToBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function mpint(buf: Buffer): Buffer {
  let start = 0;
  while (start < buf.length - 1 && buf[start] === 0) start++;
  let b = buf.subarray(start);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
  return b;
}

function encodeSshRsaPublicKey(e: Buffer, n: Buffer): string {
  const type = Buffer.from('ssh-rsa');
  const blob = Buffer.concat([sshString(type), sshString(mpint(e)), sshString(mpint(n))]);
  return `ssh-rsa ${blob.toString('base64')} healthcheck-generated-key`;
}

function generateKeypair(): string {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const jwk = crypto.createPublicKey(publicKey).export({ format: 'jwk' }) as { n: string; e: string };
  const line = encodeSshRsaPublicKey(base64UrlToBuffer(jwk.e), base64UrlToBuffer(jwk.n));
  fs.writeFileSync(PRIVATE_KEY_PATH, privateKey, { mode: 0o600 });
  fs.writeFileSync(PUBLIC_KEY_PATH, `${line}\n`, { mode: 0o644 });
  return line;
}

export function ensureAppKeypair(): { privateKeyPath: string; publicKeyLine: string } {
  if (!fs.existsSync(PRIVATE_KEY_PATH) || !fs.existsSync(PUBLIC_KEY_PATH)) {
    return { privateKeyPath: PRIVATE_KEY_PATH, publicKeyLine: generateKeypair() };
  }
  return { privateKeyPath: PRIVATE_KEY_PATH, publicKeyLine: fs.readFileSync(PUBLIC_KEY_PATH, 'utf8').trim() };
}

// Each server row keeps the key's full path, which belongs to the machine that added it (C:\...\server\data\...
// on Windows, /opt/healthcheck/server/data/... on Ubuntu). After Healthcheck moves to another machine or folder
// with its data folder copied across, that path no longer exists: the same file is then found by name in this
// machine's data folder, and the row is corrected so it only happens once.
export function privateKeyFor(server: { id: number; ssh_key_path: string }): Buffer {
  if (fs.existsSync(server.ssh_key_path)) return fs.readFileSync(server.ssh_key_path);
  const name = server.ssh_key_path.split(/[\\/]/).pop() ?? '';
  const here = path.join(dataDirPath, name);
  if (!name || !fs.existsSync(here)) {
    throw new Error(
      `Healthcheck's SSH key is missing: neither ${server.ssh_key_path} nor ${here} exists. Copy the data folder (with healthcheck_id_rsa) from the old machine to ${dataDirPath}.`,
    );
  }
  sqlite.prepare('UPDATE servers SET ssh_key_path = ? WHERE ssh_key_path = ?').run(here, server.ssh_key_path);
  return fs.readFileSync(here);
}
