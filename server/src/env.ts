import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Settings come from real environment variables, or from a .env file in the project root (or in server/).
// Found relative to this file rather than the current folder, so it works the same however the app is
// started (npm start, a Windows service ...). Real environment variables always win over the file.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env') });
dotenv.config({ path: path.resolve(here, '../.env') });

export const env = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '127.0.0.1',
  password: process.env.HEALTHCHECK_PASSWORD,
  heartbeatCron: process.env.HEARTBEAT_INTERVAL_CRON ?? '*/30 * * * *',
  // Start All / Restart All: how many times to try a component that keeps crashing before asking you
  startAttempts: Math.max(1, Number(process.env.START_ATTEMPTS ?? 3)),
  startRetryDelayS: Math.max(0, Number(process.env.START_RETRY_DELAY_S ?? 5)),
  // Start All / Restart All: how many components with no Start-before condition are started at the same time
  startParallel: Math.max(1, Number(process.env.START_PARALLEL ?? 4)),
  // ... and how many seconds to space out the *launch* of each one, even within that limit, so their JVMs
  // don't all open a DB connection pool in the same instant (a real incident: several Spring Boot apps
  // starting at once saturated the database and every one of them failed HikariPool initialization together)
  startStaggerS: Math.max(0, Number(process.env.START_STAGGER_S ?? 6)),
  // a start that hits a port already in use waits this long for the port to be released before giving up
  portReleaseWaitS: Math.max(0, Number(process.env.PORT_RELEASE_WAIT_S ?? 30)),
  // a unit that is running but has not printed its success line after this long gets the "Mark as started" option
  startHintAfterS: Math.max(1, Number(process.env.START_HINT_AFTER_S ?? 30)),
  // jboss-cli.sh path for WildFly's post-start datasource check - the same across every market/server.
  wildflyCliPath: process.env.WILDFLY_CLI_PATH ?? '/Data/software/bin/wildfly-26.1.3.Final/bin/jboss-cli.sh',
  // after a WildFly start, how long to keep asking whether it's ready to receive traffic before giving up
  wildflyReadyTimeoutS: Math.max(0, Number(process.env.WILDFLY_READY_TIMEOUT_S ?? 60)),
  // Artemis report after each start/restart: its login is the same on every market's broker. The password
  // comes from .env (gitignored) so it never lands in the repository.
  artemisUser: process.env.ARTEMIS_USER ?? 'loyalty_management',
  artemisPassword: process.env.ARTEMIS_PASSWORD ?? '',
  artemisUrl: process.env.ARTEMIS_URL ?? 'tcp://localhost:61616',
  // used when the broker's instance folder can't be read from its running process
  artemisInstance: process.env.ARTEMIS_INSTANCE ?? '/Data/software/bin/loyalty-management-broker',
  // heap use at or above this share of the heap Artemis is given turns the report into a danger warning
  // Artemis's own beat (DLQ / ExpiryQueue / memory): three times a day by default, on the Healthcheck machine's clock
  artemisCheckCron: process.env.ARTEMIS_CHECK_CRON ?? '0 8,14,20 * * *',
  artemisMemoryDangerPercent: Math.min(100, Math.max(1, Number(process.env.ARTEMIS_MEMORY_DANGER_PERCENT ?? 50))),
  nodeEnv: process.env.NODE_ENV ?? 'development',
};
