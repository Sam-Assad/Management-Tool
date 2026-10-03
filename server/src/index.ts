import { createApp } from './app.js';
import { sqlite } from './db/client.js';
import { normalizeServerGroups } from './db/serverGroups.js';
import { env } from './env.js';
import { startHeartbeatScheduler } from './heartbeat/scheduler.js';
import { startArtemisScheduler } from './heartbeat/artemisBeat.js';
import { resequenceAll } from './orchestrator/ordering.js';
import { applyBundledDefaults } from './db/defaults.js';

// This process holds many long-lived SSH connections to remote hosts whose
// network conditions we don't control. A dropped connection or unexpected
// remote-side event should never take the whole app down - log and carry on.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (ignored to keep the server running):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (ignored to keep the server running):', err);
});

// The software catalog and conditions that ship with Healthcheck (server/defaults/defaults.json): whatever
// is missing here is added, and fields the vendor changed are updated unless this installation edited them.
try {
  const loaded = applyBundledDefaults();
  const lines = [
    ...loaded.updatedSoftware.map((n) => `catalog: updated ${n}`),
    ...loaded.updatedConditions.map((n) => `condition updated - ${n}`),
    ...loaded.skipped.map((n) => `skipped: ${n}`),
  ];
  // a fresh install adds everything at once: say how many instead of listing them all
  const list = (label: string, names: string[]) =>
    names.length > 4 ? [`${label}: added ${names.length}`] : names.map((n) => `${label}: added ${n}`);
  const news = [...list('catalog', loaded.addedSoftware), ...list('conditions', loaded.addedConditions), ...lines];
  if (news.length > 0) console.log(`Shipped catalog/conditions applied:\n  ${news.join('\n  ')}`);
} catch (err) {
  console.error('Could not apply the shipped catalog and conditions (continuing with what is in the database):', err);
}
// Order comes from conditions (see Conditions page); make sure every group reflects them.
normalizeServerGroups(); // one server = one (hidden) group
resequenceAll();

// A job that was running when the app last stopped can never finish (its worker died with it), and
// would keep its group locked as "busy" forever.
sqlite
  .prepare(
    "UPDATE job_runs SET status = 'failed', error_message = 'Interrupted: the app was restarted while this was running.', finished_at = ?, awaiting = NULL WHERE status = 'running'"
  )
  .run(new Date().toISOString());

const app = createApp();
app.listen(env.port, env.host, () => {
  console.log(`Healthcheck server listening on http://${env.host}:${env.port}`);
});
startHeartbeatScheduler();
startArtemisScheduler();
