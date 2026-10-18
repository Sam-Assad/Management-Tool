import cron from 'node-cron';
import pLimit from 'p-limit';
import type { Server as ServerRow } from '@healthcheck/shared';
import { sqlite } from '../db/client.js';
import { env } from '../env.js';
import { readServiceHistory } from '../scan/history.js';

// The crash check (CRASH_CHECK_CRON, every hour): read each server's service history, which looks for services
// that had been running fine and keep crashing (scan/crashAlerts.ts). The background check, Check status and the
// end of each run read it too; this makes sure it happens at least this often. One short command per server,
// over the connection Healthcheck already keeps open.
const limit = pLimit(5);
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const servers = sqlite.prepare('SELECT * FROM servers').all() as unknown as ServerRow[];
    await Promise.all(
      servers.map((s) =>
        limit(() => readServiceHistory(s).catch((err) => console.error(`Crash check for ${s.name} failed:`, err?.message ?? err))),
      ),
    );
  } finally {
    running = false;
  }
}

export function startCrashScheduler() {
  if (!cron.validate(env.crashCheckCron)) {
    console.error(`CRASH_CHECK_CRON "${env.crashCheckCron}" isn't a valid cron expression: the hourly crash check is off.`);
    return;
  }
  cron.schedule(env.crashCheckCron, () => {
    tick().catch((err) => console.error('Crash check failed', err));
  });
}
