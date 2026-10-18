// The one settings file (.env), isolated: a copy of server/src/env.ts (and the settings command) in a throwaway
// "Healthcheck folder", so the real .env is never touched. Each case starts a fresh process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
// the Healthcheck folder (this file is in tests/)
const ROOT = fileURLToPath(new URL('..', import.meta.url));


const REPO = ROOT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-settings-'));
fs.mkdirSync(path.join(root, 'server/src/cli'), { recursive: true });
fs.copyFileSync(`${REPO}/server/src/env.ts`, path.join(root, 'server/src/env.ts'));
fs.copyFileSync(`${REPO}/server/src/cli/settings.ts`, path.join(root, 'server/src/cli/settings.ts'));
// packages (dotenv) from the real install
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), 'junction');
const file = path.join(root, '.env');
const probe = path.join(root, 'probe.mts');
fs.writeFileSync(
  probe,
  `import { env, settingsStatus } from ${JSON.stringify(new URL(`file:///${path.join(root, 'server/src/env.ts').replace(/\\/g, '/')}`).href)};\nconsole.log(JSON.stringify({ env, status: settingsStatus }));\n`,
);
const tsx = path.join(REPO, 'node_modules/tsx/dist/cli.mjs');
const run = (extraEnv: Record<string, string> = {}) => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PORT|HOST|ARTEMIS_|HEALTHCHECK_|SERVICE_HISTORY|HEARTBEAT|START_|SESSION_|LOGIN_)/.test(k)));
  const r = spawnSync(process.execPath, [tsx, probe], { env: { ...clean, ...extraEnv }, encoding: 'utf8', cwd: os.tmpdir() });
  const line = r.stdout.trim().split('\n').at(-1) ?? '';
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`probe failed: ${r.stdout}\n${r.stderr}`);
  }
};

let fails = 0;
const check = (label: string, ok: boolean, info?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && info !== undefined ? `   got: ${JSON.stringify(info)}` : ''}`);
};

try {
  // ---- 1. no file: written with every setting at its default
  let r = run();
  let text = fs.readFileSync(file, 'utf8');
  let parsed = dotenv.parse(text);
  check('no file: Healthcheck writes it', r.status.created === true && fs.existsSync(file), r.status);
  check('...with all 32 settings, each with a comment and a "# Default:" line', Object.keys(parsed).length === 32 && (text.match(/^# Default: /gm) ?? []).length === 32, Object.keys(parsed).length);
  check('...the recommended defaults are marked', /# Default: 127\.0\.0\.1 \(recommended\)\nHOST=127\.0\.0\.1/.test(text) && /# Default: 30 \(recommended\)\nSERVICE_HISTORY_DAYS=30/.test(text));
  check('...and the values in use are the defaults', r.env.port === 4000 && r.env.host === '127.0.0.1' && r.env.heartbeatCron === '0 */2 * * *' && r.env.serviceHistoryDays === 30 && r.env.publicUrl === 'http://localhost:4000', r.env);
  check('...data and catalog default to the Healthcheck folder', r.env.dataDir === path.join(root, 'server/data') && r.env.defaultsFile === path.join(root, 'server/defaults/defaults.json'), [r.env.dataDir, r.env.defaultsFile]);
  check('...no double blank lines', !/\n\n\n/.test(text));

  // ---- 2. a complete file is read, not rewritten
  fs.writeFileSync(file, text.replace('SERVICE_HISTORY_DAYS=30', 'SERVICE_HISTORY_DAYS=45').replace('PORT=4000', 'PORT=4100').replace('PUBLIC_URL=', 'PUBLIC_URL=http://hc.local:4100/'));
  const before = fs.readFileSync(file, 'utf8');
  r = run();
  check('a complete file: its values are used', r.env.serviceHistoryDays === 45 && r.env.port === 4100 && r.env.publicUrl === 'http://hc.local:4100', r.env);
  check('...and it is left exactly as it was', fs.readFileSync(file, 'utf8') === before && !r.status.created && r.status.added.length === 0);

  // ---- 3. an old file with a few settings (like the old .env): rewritten in order, values kept
  fs.writeFileSync(
    file,
    '# my old notes\nARTEMIS_PASSWORD="pa#ss \'w\'"\nPORT=4200\nHEALTHCHECK_DATA_DIR=D:\\HealthcheckData\nHEALTHCHECK_PASSWORD=old\nSTART_PARALLEL=\n',
  );
  r = run();
  text = fs.readFileSync(file, 'utf8');
  parsed = dotenv.parse(text);
  check('an incomplete file: the missing settings are added', r.status.added.length === 28 && r.status.added.includes('HOST') && !r.status.added.includes('PORT'), r.status);
  check('...the values it had are kept (a password with #, quotes and a space; a Windows path)', parsed.ARTEMIS_PASSWORD === "pa#ss 'w'" && parsed.PORT === '4200' && parsed.HEALTHCHECK_DATA_DIR === 'D:\\HealthcheckData', parsed);
  check('...a setting this version doesn\'t know is kept, at the end, marked as unused', /# ==== Not used by this version of Healthcheck[^\n]*\n\nHEALTHCHECK_PASSWORD=old\n$/.test(text), text.slice(-120));
  check('...in the defined order (PORT before HOST before ARTEMIS_PASSWORD)', text.indexOf('PORT=4200') < text.indexOf('HOST=') && text.indexOf('HOST=') < text.indexOf('ARTEMIS_PASSWORD='));
  check('...the values are used: the password exactly, an empty number = its default', r.env.artemisPassword === "pa#ss 'w'" && r.env.port === 4200 && r.env.startParallel === 4, r.env);

  // ---- 4. a real environment variable wins; nonsense falls back to the default; a relative data folder
  fs.writeFileSync(file, text.replace('START_ATTEMPTS=3', 'START_ATTEMPTS=lots').replace('HEALTHCHECK_DATA_DIR=D:\\HealthcheckData', 'HEALTHCHECK_DATA_DIR=hcdata'));
  r = run({ PORT: '4300' });
  check('an environment variable wins over the file', r.env.port === 4300, r.env.port);
  check('a value that isn\'t a number: the default', r.env.startAttempts === 3, r.env.startAttempts);
  check('a relative data folder counts from the Healthcheck folder, wherever it is started from', r.env.dataDir === path.join(root, 'hcdata'), r.env.dataDir);

  // ---- 5. a file Healthcheck may not write (Ubuntu: it belongs to root): it still starts, with defaults
  fs.writeFileSync(file, 'ARTEMIS_PASSWORD=x\n');
  fs.chmodSync(file, 0o444);
  r = run();
  check('cannot write the file: it says so and still starts, missing settings at their defaults', !!r.status.error && r.env.port === 4000 && r.env.artemisPassword === 'x' && fs.readFileSync(file, 'utf8') === 'ARTEMIS_PASSWORD=x\n', r.status);
  fs.chmodSync(file, 0o644);

  // ---- 6. npm run settings: writes it again in order, values kept, says what to do
  fs.writeFileSync(file, 'ARTEMIS_PASSWORD=\nPORT=4500\n');
  const cli = spawnSync(process.execPath, [tsx, path.join(root, 'server/src/cli/settings.ts')], { encoding: 'utf8', cwd: os.tmpdir() });
  parsed = dotenv.parse(fs.readFileSync(file, 'utf8'));
  check('`npm run settings`: the file gets every setting, values kept', Object.keys(parsed).length === 32 && parsed.PORT === '4500', Object.keys(parsed).length);
  check('...and says where the file is and that the Artemis password is empty', cli.stdout.includes(file) && /ARTEMIS_PASSWORD is empty/.test(cli.stdout), cli.stdout);
} finally {
  try {
    fs.chmodSync(file, 0o644);
  } catch {}
  fs.rmSync(path.join(root, 'node_modules')); // the link only
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
