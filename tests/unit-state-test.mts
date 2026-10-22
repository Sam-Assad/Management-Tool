// What a service's systemd state means on the server page, isolated: checkComponent on systemctl's real answers
// (taken from loyalty_1), through a stand-in for the SSH connection. Nothing is contacted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-unit-state-test-'));
Object.assign(process.env, { HEALTHCHECK_DATA_DIR: dataDir });
const { checkComponent } = await import('../server/src/scan/detectors.ts');

let fails = 0;
const check = (label: string, ok: boolean, info?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && info !== undefined ? `   got: ${JSON.stringify(info)}` : ''}`);
};

// an SSH connection that answers every command with this text
const answering = (stdout: string) =>
  ({
    exec(_command: string, cb: (err: Error | null, stream: any) => void) {
      const stream: any = new EventEmitter();
      stream.stderr = new EventEmitter();
      cb(null, stream);
      setImmediate(() => {
        stream.emit('data', Buffer.from(stdout));
        stream.emit('close', 0);
      });
    },
  }) as any;
const show = (p: Record<string, string>) => Object.entries({ LoadState: 'loaded', SubState: 'dead', MainPID: '0', ...p }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
const def = { id: 1, name: 'loyalty-backend', kind: 'jar', detect_method: 'systemd', detect_value: 'loyalty-backend.service' } as any;
const stateOf = async (p: Record<string, string>) => (await checkComponent(answering(show(p)), def)).state;

try {
  // loyalty_1, after a stop: "Main process exited, code=exited, status=143/n/a ... Failed with result 'exit-code'"
  check(
    'a Java service stopped normally (exit code 143, which systemd calls "failed"): Stopped',
    (await stateOf({ ActiveState: 'failed', SubState: 'failed', Result: 'exit-code', ExecMainCode: '1', ExecMainStatus: '143' })) === 'stopped',
  );
  check('...130 (stopped with Ctrl+C / SIGINT): Stopped', (await stateOf({ ActiveState: 'failed', Result: 'exit-code', ExecMainCode: '1', ExecMainStatus: '130' })) === 'stopped');
  // WildFly on loyalty_1: killed by the stop signal itself, which systemd already counts as a clean stop
  check('stopped by the signal itself (WildFly): Stopped', (await stateOf({ ActiveState: 'inactive', Result: 'success', ExecMainCode: '2', ExecMainStatus: '15' })) === 'stopped');
  check('a real crash (exit code 1): Stopped with an error', (await stateOf({ ActiveState: 'failed', Result: 'exit-code', ExecMainCode: '1', ExecMainStatus: '1' })) === 'failed');
  check('killed for lack of memory (SIGKILL): Stopped with an error', (await stateOf({ ActiveState: 'failed', Result: 'signal', ExecMainCode: '2', ExecMainStatus: '9' })) === 'failed');
  check('a start that timed out (systemd sent the stop signal): Stopped with an error', (await stateOf({ ActiveState: 'failed', Result: 'timeout', ExecMainCode: '1', ExecMainStatus: '143' })) === 'failed');
  check('systemd gave up restarting it: Stopped with an error', (await stateOf({ ActiveState: 'failed', Result: 'start-limit-hit', ExecMainCode: '1', ExecMainStatus: '143' })) === 'failed');
  check('running: Running', (await stateOf({ ActiveState: 'active', SubState: 'running', Result: 'success', ExecMainCode: '0', ExecMainStatus: '0' })) === 'running');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
