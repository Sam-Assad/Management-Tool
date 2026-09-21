import { sqlite, insertRow } from './client.js';

interface SeedDefinition {
  name: string;
  kind: 'service' | 'jar';
  // systemd unit name - detect, start and stop all go through it. Alternative names that
  // different markets use for the same component are listed with "|".
  unit: string;
  rank: number;
  log_path: string | null;
  // regex matched against NEW log lines after a start; null = "unit is active" is enough
  success_pattern: string | null;
  health_timeout_s: number;
  // insert on boot if missing even though it has no log path
  addIfMissing?: boolean;
}

// Log-level based, not "the word Exception anywhere": normal startup lines mention class names like
// ExceptionTranslationFilter, and treating those as failures aborts healthy starts.
export const DEFAULT_ERROR_PATTERN = String.raw`\b(ERROR|FATAL|SEVERE)\b|APPLICATION FAILED TO START`;
const OLD_DEFAULT_ERROR_PATTERN = 'ERROR|Exception|FATAL';

// Spring Boot's standard "Started <App> in N seconds" line, used for every jar.
const SPRING_STARTED = 'Started .+ in [0-9.]+ seconds';

// mq-wrapper logs through its own log4j2 layout and never prints Spring's "Started ... in N seconds" line; its
// start-up ends with the connection manager being configured ("a=configureConnectionManager, s=success").
const MQ_WRAPPER_STARTED = 'configureConnectionManager, s=success';

// Rank encodes the ordering rules already given: software tier before jar tier
// (0-9 vs 10+), Keycloak before WSO2AM, Artemis before WildFly, and the
// conversion-rules-selector -> earning-rules-selector -> rules-interpreter chain.
// Anything without a stated rule just gets a slot in its tier.
//
// log_path is the fixed, per-market convention under /Data/logs - given once,
// applied to every matching catalog entry, and still editable per item from
// the Software Catalog page if a particular deployment differs.
//
// Every component is expected to run as a systemd unit in every market (the unit
// files are a deployment prerequisite); unit names come from those files.
const SEED_SOFTWARE: SeedDefinition[] = [
  { name: 'Keycloak', kind: 'service', unit: 'keycloak.service', rank: 0, log_path: '/Data/logs/keycloak/keycloak.log', success_pattern: 'Listening on:', health_timeout_s: 300 },
  { name: 'WSO2 API Manager', kind: 'service', unit: 'wso2am.service|wso2apim.service', rank: 1, log_path: '/Data/logs/api-manager/wso2carbon.log', success_pattern: 'WSO2 Carbon started in', health_timeout_s: 300 },
  { name: 'Artemis', kind: 'service', unit: 'artemis.service', rank: 2, log_path: '/Data/logs/message-broker/log/artemis.log', success_pattern: 'Server is now live|Message Broker is now live', health_timeout_s: 180 },
  { name: 'WildFly (JBoss)', kind: 'service', unit: 'wildfly.service', rank: 3, log_path: '/Data/logs/application-server/server.log', success_pattern: 'WFLYSRV0025', health_timeout_s: 300 },
  { name: 'WSO2 Streaming Integrator', kind: 'service', unit: 'wso2si.service', rank: 4, log_path: '/Data/logs/streaming-integrator/carbon.log', success_pattern: null, health_timeout_s: 300 },
  { name: 'Nginx', kind: 'service', unit: 'nginx.service', rank: 5, log_path: null, success_pattern: null, health_timeout_s: 60 },
  { name: 'Filebeat', kind: 'service', unit: 'filebeat.service', rank: 6, log_path: null, success_pattern: null, health_timeout_s: 60 },
  { name: 'conversion-rules-selector', kind: 'jar', unit: 'conversion-rule-selector.service', rank: 10, log_path: '/Data/logs/conversion-rules-selector/rules-selector.log', success_pattern: SPRING_STARTED, health_timeout_s: 180 },
  { name: 'earning-rules-selector', kind: 'jar', unit: 'earning-rule-selector.service', rank: 11, log_path: '/Data/logs/earning-rules-selector/rules-selector.log', success_pattern: SPRING_STARTED, health_timeout_s: 180 },
  { name: 'rules-interpreter', kind: 'jar', unit: 'rule-interpreter.service', rank: 12, log_path: '/Data/logs/rules-interpreter/rulesInterpreter.log', success_pattern: SPRING_STARTED, health_timeout_s: 180 },
  { name: 'mq-wrapper', kind: 'jar', unit: 'mq-wrapper.service', rank: 13, log_path: '/Data/logs/mq-wrapper/mq-wrapper.log', success_pattern: MQ_WRAPPER_STARTED, health_timeout_s: 180 },
  { name: 'voucher-backend', kind: 'jar', unit: 'voucher-backend.service', rank: 14, log_path: '/Data/logs/admin/backend/voucher/spring.log', success_pattern: SPRING_STARTED, health_timeout_s: 180 },
  { name: 'loyalty-backend', kind: 'jar', unit: 'loyalty-backend.service', rank: 15, log_path: '/Data/logs/admin/backend/loyalty/spring.log', success_pattern: SPRING_STARTED, health_timeout_s: 180 },
  { name: 'portal-backend', kind: 'jar', unit: 'portal-backend.service', rank: 16, log_path: '/Data/logs/admin/backend/portal/spring.log', success_pattern: SPRING_STARTED, health_timeout_s: 180 },
  { name: 'voucher-management', kind: 'jar', unit: 'voucher-management.service', rank: 17, log_path: '/Data/logs/voucher-management/voucher-trx.log', success_pattern: SPRING_STARTED, health_timeout_s: 180 },
  // Runs from /Data/system-modules/admin/backend/product-catalog (matches the log path below)
  { name: 'product-catalog', kind: 'jar', unit: 'product-catalog-backend.service', rank: 18, log_path: '/Data/logs/admin/backend/product-catalog/spring.log', success_pattern: SPRING_STARTED, health_timeout_s: 180 },
  { name: 'balance-management', kind: 'jar', unit: 'balance-management.service', rank: 19, log_path: '/Data/logs/balance-management/balance-trx.log', success_pattern: SPRING_STARTED, health_timeout_s: 180 },
  // The unit for this jar is called balance-util
  { name: 'balance-notification', kind: 'jar', unit: 'balance-util.service', rank: 20, log_path: '/Data/logs/balance-notification/balance-notification.log', success_pattern: SPRING_STARTED, health_timeout_s: 180 },
  { name: 'conversion-backend', kind: 'jar', unit: 'conversion-backend.service', rank: 21, log_path: '/Data/logs/admin/backend/conversion/spring.log', success_pattern: SPRING_STARTED, health_timeout_s: 180 },
  { name: 'goal-backend', kind: 'jar', unit: 'goal-backend.service', rank: 22, log_path: '/Data/logs/admin/backend/goal/spring.log', success_pattern: SPRING_STARTED, health_timeout_s: 180 },
  { name: 'prize-draw-backend', kind: 'jar', unit: 'prize-draw-backend.service', rank: 23, log_path: '/Data/logs/admin/backend/prize-draw/spring.log', success_pattern: SPRING_STARTED, health_timeout_s: 180 },
  { name: 'sales-backend', kind: 'jar', unit: 'sales-backend.service', rank: 24, log_path: '/Data/logs/admin/backend/sales/spring.log', success_pattern: SPRING_STARTED, health_timeout_s: 180 },
  { name: 'usage-backend', kind: 'jar', unit: 'usage-backend.service', rank: 25, log_path: '/Data/logs/admin/backend/usage/spring.log', success_pattern: SPRING_STARTED, health_timeout_s: 180 },
  // Second unit file (/Data/system-modules/product-catalog); no log path was provided for it yet.
  { name: 'product-catalog-service', kind: 'jar', unit: 'product-catalog.service', rank: 26, log_path: null, success_pattern: null, health_timeout_s: 180, addIfMissing: true },
];

function insertSeedRow(item: SeedDefinition) {
  insertRow('software_definitions', {
    name: item.name,
    kind: item.kind,
    detect_method: 'systemd',
    detect_value: item.unit,
    start_cmd: '',
    stop_cmd: '',
    restart_method: 'systemd',
    log_path: item.log_path,
    success_pattern: item.log_path ? item.success_pattern : null,
    error_pattern: DEFAULT_ERROR_PATTERN,
    health_timeout_s: item.health_timeout_s,
    default_rank: item.rank,
    created_at: new Date().toISOString(),
  });
}

export function seedSoftwareCatalog() {
  const { count } = sqlite.prepare('SELECT COUNT(*) as count FROM software_definitions').get() as {
    count: number;
  };
  if (count > 0) return;

  for (const item of SEED_SOFTWARE) {
    insertSeedRow(item);
  }
}

// Fills in default_rank for rows that already existed before this field was
// added (matched by name), without touching anything the operator has since
// customized. Safe to call on every boot.
export function backfillDefaultRanks() {
  const update = sqlite.prepare(
    'UPDATE software_definitions SET default_rank = ? WHERE name = ? AND default_rank IS NULL'
  );
  for (const item of SEED_SOFTWARE) {
    update.run(item.rank, item.name);
  }
}

// One-time upgrade of catalog rows created before systemd was the standard: a row that
// is still exactly as originally seeded (process-fragment detection, captured restart,
// no start/stop command) is switched to its systemd unit. Once switched it no longer
// matches, so later edits made in the Software Catalog page are never overwritten.
export function applySystemdDefaults() {
  const upgrade = sqlite.prepare(
    `UPDATE software_definitions
        SET detect_method = 'systemd',
            detect_value = ?,
            restart_method = 'systemd',
            success_pattern = COALESCE(success_pattern, ?),
            health_timeout_s = ?
      WHERE name = ?
        AND detect_method = 'process_fragment'
        AND restart_method = 'captured'
        AND start_cmd = ''
        AND stop_cmd = ''`
  );
  for (const item of SEED_SOFTWARE) {
    const pattern = item.log_path ? item.success_pattern : null;
    upgrade.run(item.unit, pattern, item.health_timeout_s, item.name);
  }
}

// Catalog rows already switched to systemd before an entry gained alternative unit names still
// hold just the first name. Widen them - but only if they still hold exactly that default, so
// anything edited in the Software Catalog page is left alone.
export function applyUnitAliases() {
  const widen = sqlite.prepare(
    "UPDATE software_definitions SET detect_value = ? WHERE name = ? AND detect_method = 'systemd' AND detect_value = ?"
  );
  for (const item of SEED_SOFTWARE) {
    const names = item.unit.split('|');
    if (names.length > 1) widen.run(item.unit, item.name, names[0]);
  }
}

// Rows still holding the original over-broad default get the level-based one. Only that exact
// old default is replaced - a pattern edited in the Software Catalog page is never touched.
// Entries that were seeded with the generic Spring pattern but whose log never prints it. Only rows still on
// that seeded value are changed - a pattern you edited yourself is left alone.
export function applySuccessPatternFixes() {
  sqlite
    .prepare('UPDATE software_definitions SET success_pattern = ? WHERE name = ? AND success_pattern = ?')
    .run(MQ_WRAPPER_STARTED, 'mq-wrapper', SPRING_STARTED);
}

export function applyErrorPatternDefault() {
  sqlite
    .prepare('UPDATE software_definitions SET error_pattern = ? WHERE error_pattern = ?')
    .run(DEFAULT_ERROR_PATTERN, OLD_DEFAULT_ERROR_PATTERN);
}

// Applies the fixed /Data/logs convention given for the catalog: sets log_path
// on every matching existing entry (by name), and adds any brand-new catalog
// entries from the list above that don't exist yet. Safe to call on every
// boot - existing rows not in this list, and any other field on rows that
// are, are left untouched.
export function applyKnownLogPaths() {
  const setLogPath = sqlite.prepare('UPDATE software_definitions SET log_path = ? WHERE name = ?');
  const exists = sqlite.prepare('SELECT id FROM software_definitions WHERE name = ?');
  for (const item of SEED_SOFTWARE) {
    if (item.log_path === null && !item.addIfMissing) continue;
    const row = exists.get(item.name);
    if (row) {
      if (item.log_path !== null) setLogPath.run(item.log_path, item.name);
    } else {
      insertSeedRow(item);
    }
  }
}
