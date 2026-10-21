// npm test: every self-contained suite. Each uses its own throwaway database and settings; nothing on the
// servers is touched, and the real data folder and .env are left alone. (Some start the built app: npm test
// builds first.)
// npm run test:live: the permissions suite against the running Healthcheck (hc-test-* accounts only, removed at
// the end; nothing is really started or stopped).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const SUITES = {
  default: [
    'settings-e2e', // the one settings file (.env)
    'journal-e2e', // service history read from the journal: who did what
    'history-e2e', // service history from systemd's timestamps (servers without journal access)
    'crash-e2e', // crash alerts
    'auth-e2e', // sign-in, temporary passwords, locking
    'totp-e2e', // admins' authenticator app, "Forgot password"
    'reset-e2e', // the one-time reset link from the command line
    'perm-split', // the "Check status" permission split for older databases
    'traffic-parse-test', // reading WildFly's readiness / traffic answers
    'connect-e2e', // why a connection failed (Add server, Test connection, the check before a run on several servers)
    'fresh-install', // a market's first start, in a browser (needs Chrome: CHROME_PATH if it isn't in the usual place)
  ],
  live: ['perm-e2e'],
};

const which = process.argv.includes('--live') ? SUITES.live : SUITES.default;
let failed = 0;
for (const name of which) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [TSX, path.join(ROOT, 'tests', `${name}.mts`)], { cwd: ROOT, encoding: 'utf8', env: process.env });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // "all passed" is the verdict: Node on Windows can end a finished run with a non-zero code while closing handles
  const passed = /^all passed$/m.test(output) && !/^FAIL /m.test(output);
  const checks = (output.match(/^(PASS|FAIL) /gm) ?? []).length;
  console.log(`${passed ? 'ok  ' : 'FAIL'}  ${name.padEnd(20)} ${String(checks).padStart(3)} checks  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (!passed) {
    failed++;
    const lines = output.split('\n').filter((l) => /^FAIL |Error|error/.test(l));
    console.log((lines.length ? lines : output.split('\n').slice(-15)).map((l) => `      ${l}`).join('\n'));
  }
}
console.log(failed ? `\n${failed} of ${which.length} suites failed` : `\nall ${which.length} suites passed`);
process.exit(failed ? 1 : 0);
