import 'dotenv/config';

export const env = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '127.0.0.1',
  password: process.env.HEALTHCHECK_PASSWORD,
  heartbeatCron: process.env.HEARTBEAT_INTERVAL_CRON ?? '*/5 * * * *',
  // Start All / Restart All: how many times to try a component that keeps crashing before asking you
  startAttempts: Math.max(1, Number(process.env.START_ATTEMPTS ?? 3)),
  startRetryDelayS: Math.max(0, Number(process.env.START_RETRY_DELAY_S ?? 5)),
  // Start All / Restart All: how many components with no Start-before condition are started at the same time
  startParallel: Math.max(1, Number(process.env.START_PARALLEL ?? 4)),
  // a start that hits a port already in use waits this long for the port to be released before giving up
  portReleaseWaitS: Math.max(0, Number(process.env.PORT_RELEASE_WAIT_S ?? 30)),
  // a unit that is running but has not printed its success line after this long gets the "Mark as started" option
  startHintAfterS: Math.max(1, Number(process.env.START_HINT_AFTER_S ?? 30)),
  nodeEnv: process.env.NODE_ENV ?? 'development',
};
