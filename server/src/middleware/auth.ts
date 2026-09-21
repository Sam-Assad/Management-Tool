import basicAuth from 'express-basic-auth';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../env.js';
import { dataDirPath } from '../db/client.js';

function resolvePassword(): string {
  if (env.password) return env.password;
  const filePath = path.join(dataDirPath, 'auth-password.txt');
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8').trim();
  }
  const generated = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(filePath, generated, { mode: 0o600 });
  return generated;
}

export function createAuthMiddleware() {
  const password = resolvePassword();
  const filePath = path.join(dataDirPath, 'auth-password.txt');
  console.log('----------------------------------------------------');
  console.log('Healthcheck login - username: admin');
  if (!env.password) {
    console.log(`No HEALTHCHECK_PASSWORD set. Generated password stored at ${filePath}`);
  }
  console.log(`Password: ${password}`);
  console.log('----------------------------------------------------');
  return basicAuth({
    users: { admin: password },
    challenge: true,
  });
}
