import { createApp } from './app.js';
import { sqlite } from './db/client.js';
import { normalizeServerGroups } from './db/serverGroups.js';
import { env } from './env.js';
import { startHeartbeatScheduler } from './heartbeat/scheduler.js';
import { seedDefaultConditions, resequenceAll } from './orchestrator/ordering.js';
import { seedSoftwareCatalog, backfillDefaultRanks, applySystemdDefaults, applyUnitAliases, applyErrorPatternDefault, applySuccessPatternFixes, applyKnownLogPaths } from './db/seed.js';

// This process holds many long-lived SSH connections to remote hosts whose
// network conditions we don't control. A dropped connection or unexpected
// remote-side event should never take the whole app down - log and carry on.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (ignored to keep the server running):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (ignored to keep the server running):', err);
});

seedSoftwareCatalog();
backfillDefaultRanks();
applySystemdDefaults();
applyUnitAliases();
applyErrorPatternDefault();
applySuccessPatternFixes();
applyKnownLogPaths();
// Order comes from conditions (see Conditions page); make sure every group reflects them.
normalizeServerGroups(); // one server = one (hidden) group
seedDefaultConditions();
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
