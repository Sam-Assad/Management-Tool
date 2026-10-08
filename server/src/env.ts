import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// All of Healthcheck's settings live in ONE file: .env in the Healthcheck folder (next to package.json). The
// list below is the only place they're defined: each one's default, and what the file says about it. When the
// file is missing, or lacks a setting (a newer version added one), Healthcheck writes it: every setting in
// order, the values already in it kept. It's read once, at start - restart Healthcheck after a change. It
// holds passwords, so it's never committed (.gitignore).
// A real environment variable of the same name wins over the file (how the tests, a service manager or a
// container can set one without touching it).

const here = path.dirname(fileURLToPath(import.meta.url));
// the Healthcheck folder: server/src (or server/dist) is two levels down
export const appRoot = path.resolve(here, '../..');
export const settingsFile = path.join(appRoot, '.env');

interface Setting {
  key: string;
  value: string; // the default ('' = none / worked out, see `def`)
  about: string;
  def?: string; // how the "Default:" line reads, when the value alone doesn't say it
  recommended?: boolean; // keep the default unless there's a reason
}

export const SETTINGS: { title: string; settings: Setting[] }[] = [
  {
    title: 'The web page',
    settings: [
      { key: 'PORT', value: '4000', about: 'The port the web page is served on.' },
      {
        key: 'HOST',
        value: '127.0.0.1',
        about: "Who can open the page: 127.0.0.1 = only this machine. 0.0.0.0 = other PCs too (then let only your team's addresses through the firewall).",
        recommended: true,
      },
      {
        key: 'PUBLIC_URL',
        value: '',
        about: 'The address people open Healthcheck at. The one-time links that `npm run reset-password` prints start with it.',
        def: 'empty = http://localhost:<PORT>',
      },
      {
        key: 'COOKIE_SECURE',
        value: 'false',
        about: 'true only when Healthcheck is served over HTTPS: the sign-in cookie is then never sent unencrypted.',
        def: 'false (recommended, unless the page is served over HTTPS)',
      },
    ],
  },
  {
    title: 'Data',
    settings: [
      {
        key: 'HEALTHCHECK_DATA_DIR',
        value: '',
        about:
          "Where the database, Healthcheck's SSH key and master.key are kept. A folder outside the Healthcheck folder survives a re-install (Windows: D:\\HealthcheckData, Ubuntu: /var/lib/healthcheck). A relative path counts from the Healthcheck folder.",
        def: 'empty = server/data in the Healthcheck folder',
      },
      { key: 'SERVICE_HISTORY_DAYS', value: '30', about: 'Days of service history (starts, stops, errors, and who did them) to keep.', recommended: true },
    ],
  },
  {
    title: 'Background checks',
    settings: [
      {
        key: 'HEARTBEAT_INTERVAL_CRON',
        value: '0 */2 * * *',
        about:
          'When every service on every server is checked, as cron (minute hour day month weekday). Every 2 hours keeps SSH logins on the servers low; "*/30 * * * *" = every 30 minutes.',
        recommended: true,
      },
      {
        key: 'ARTEMIS_CHECK_CRON',
        value: '0 8,14,20 * * *',
        about: "When Artemis's DLQ, ExpiryQueue and memory are read: 08:00, 14:00 and 20:00 on this machine's clock.",
        recommended: true,
      },
    ],
  },
  {
    title: 'Start / Restart All',
    settings: [
      { key: 'START_ATTEMPTS', value: '3', about: 'How many times to try a component that crashes on start before stopping to ask you.', recommended: true },
      { key: 'START_RETRY_DELAY_S', value: '5', about: 'Seconds between those tries.', recommended: true },
      {
        key: 'START_PARALLEL',
        value: '4',
        about:
          "How many components that no condition mentions are started at the same time. Each keeps a log open over SSH, and Healthcheck never uses more than 8 SSH channels per server (sshd's default limit is 10).",
        recommended: true,
      },
      {
        key: 'START_STAGGER_S',
        value: '6',
        about: 'Seconds between the launch of each of those, so their JVMs don\'t all open their database connections in the same instant.',
        recommended: true,
      },
      { key: 'PORT_RELEASE_WAIT_S', value: '30', about: 'A start whose port is still taken waits this many seconds for it to be released before giving up.', recommended: true },
      { key: 'START_HINT_AFTER_S', value: '30', about: 'A service running without its success line in the log after this many seconds gets the "Mark as started" button.', recommended: true },
    ],
  },
  {
    title: 'WildFly',
    settings: [
      {
        key: 'WILDFLY_CLI_PATH',
        value: '/Data/software/bin/wildfly-26.1.3.Final/bin/jboss-cli.sh',
        about: "Where jboss-cli.sh is on the servers (the same on every server), for WildFly's database and traffic checks.",
        recommended: true,
      },
      { key: 'WILDFLY_READY_TIMEOUT_S', value: '60', about: 'After WildFly starts, how many seconds to keep checking that it can receive traffic.', recommended: true },
    ],
  },
  {
    title: 'Artemis',
    settings: [
      { key: 'ARTEMIS_USER', value: 'loyalty_management', about: 'The broker login for the Artemis report (the same on every market).', recommended: true },
      {
        key: 'ARTEMIS_PASSWORD',
        value: '',
        about: "That login's password. Without it the report can't read the queues of a broker that checks passwords, and says so.",
        def: 'empty (fill it in)',
      },
      { key: 'ARTEMIS_URL', value: 'tcp://localhost:61616', about: "Where the broker's command line connects, run on the server itself.", recommended: true },
      {
        key: 'ARTEMIS_INSTANCE',
        value: '/Data/software/bin/loyalty-management-broker',
        about: "The broker's instance folder, used only when it can't be read from the running broker.",
        recommended: true,
      },
      { key: 'ARTEMIS_MEMORY_DANGER_PERCENT', value: '50', about: 'At or above this share of its memory in use, the Artemis report turns into a red warning.', recommended: true },
    ],
  },
  {
    title: 'Sign-in',
    settings: [
      { key: 'SESSION_IDLE_HOURS', value: '8', about: 'A signed-in session ends after this many hours without use...', recommended: true },
      { key: 'SESSION_MAX_HOURS', value: '24', about: '...and after this many hours in any case, so everyone signs in at least once a day.', recommended: true },
      { key: 'LOGIN_MAX_ATTEMPTS', value: '5', about: 'Wrong passwords in a row before an account is locked.', recommended: true },
      { key: 'LOGIN_LOCK_MINUTES', value: '15', about: 'How long the lock lasts (an admin can unlock it sooner).', recommended: true },
      { key: 'TEMP_PASSWORD_HOURS', value: '24', about: 'How many hours a temporary password (new account, admin reset) works.', recommended: true },
      { key: 'RESET_LINK_MINUTES', value: '30', about: 'How many minutes a one-time link from `npm run reset-password` works.', recommended: true },
    ],
  },
  {
    title: 'Advanced',
    settings: [
      {
        key: 'HEALTHCHECK_DEFAULTS_FILE',
        value: '',
        about: 'The catalog and conditions file loaded at every start.',
        def: 'empty = server/defaults/defaults.json shipped with Healthcheck (recommended)',
      },
    ],
  },
];

const ALL = SETTINGS.flatMap((s) => s.settings);
const DEFAULTS: Record<string, string> = Object.fromEntries(ALL.map((s) => [s.key, s.value]));

// A value as the file needs it: dotenv cuts an unquoted value at "#", and trims it.
function fileValue(v: string): string {
  if (!/[#'"`\n]|^\s|\s$/.test(v)) return v;
  if (!v.includes("'") && !v.includes('\n')) return `'${v}'`;
  return v.includes('`') ? `"${v.replace(/"/g, '\\"')}"` : `\`${v}\``;
}

function wrap(text: string, width = 108): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

// The whole file: every setting with what it does, its default and its value; settings it doesn't know at the end.
export function settingsText(values: Record<string, string>, others: Record<string, string> = {}): string {
  const out = [
    '# Healthcheck settings - the only settings file. Healthcheck reads it when it starts: restart Healthcheck after a',
    '# change. Every setting is listed with what it does and its default; "(recommended)" = keep the default unless',
    '# you have a reason. A deleted line or an empty value means the default. Healthcheck adds settings a newer',
    '# version brings, keeping your values. This file holds passwords: keep it private, never commit it.',
  ];
  for (const section of SETTINGS) {
    if (out.at(-1) !== '') out.push('');
    out.push(`# ==== ${section.title}`, '');
    for (const s of section.settings) {
      out.push(...wrap(s.about).map((l) => `# ${l}`));
      out.push(`# Default: ${s.def ?? s.value}${s.recommended ? ' (recommended)' : ''}`);
      out.push(`${s.key}=${fileValue(values[s.key] ?? s.value)}`, '');
    }
  }
  const extra = Object.entries(others);
  if (extra.length) {
    out.push('# ==== Not used by this version of Healthcheck (kept as they were)', '');
    for (const [k, v] of extra) out.push(`${k}=${fileValue(v)}`);
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

// What happened to the file at this start: written (created, or settings added), or couldn't be.
export const settingsStatus: { created: boolean; added: string[]; error: string | null } = { created: false, added: [], error: null };

function loadSettings() {
  let text: string | null = null;
  try {
    text = fs.readFileSync(settingsFile, 'utf8');
  } catch {
    // not there yet
  }
  const fromFile = text === null ? {} : dotenv.parse(text);
  const missing = ALL.filter((s) => !(s.key in fromFile)).map((s) => s.key);
  if (text === null || missing.length) {
    const known = new Set(ALL.map((s) => s.key));
    const others = Object.fromEntries(Object.entries(fromFile).filter(([k]) => !known.has(k)));
    try {
      fs.writeFileSync(settingsFile, settingsText(fromFile, others), { mode: 0o600 });
      settingsStatus.created = text === null;
      settingsStatus.added = text === null ? [] : missing;
    } catch (err: any) {
      // e.g. on Ubuntu the file belongs to root: the defaults apply, `npm run settings` (as root) writes it
      settingsStatus.error = `${err?.code ?? 'error'}: ${err?.message ?? err}`;
    }
  }
  for (const [k, v] of Object.entries(fromFile)) if (process.env[k] === undefined) process.env[k] = v;
}
loadSettings();

// A setting's value: the environment variable, else the file, else the default (an empty value = the default).
const str = (key: string): string => {
  const v = process.env[key]?.trim();
  return v ? v : DEFAULTS[key];
};
// a number, kept within [min, max]; not a number = the default
const num = (key: string, min: number, max = Infinity): number => {
  const n = Number(str(key));
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : Number(DEFAULTS[key])));
};
const inApp = (key: string, fallback: string) => {
  const v = str(key);
  return v ? path.resolve(appRoot, v) : path.join(appRoot, fallback);
};

const port = num('PORT', 1, 65535);

export const env = {
  port,
  host: str('HOST'),
  // the background check of every service: every 2 hours by default (fewer SSH logins on the servers)
  heartbeatCron: str('HEARTBEAT_INTERVAL_CRON'),
  // service history (starts, stops, crashes) is kept this many days
  serviceHistoryDays: num('SERVICE_HISTORY_DAYS', 1),
  // Start All / Restart All: how many times to try a component that keeps crashing before asking you
  startAttempts: num('START_ATTEMPTS', 1),
  startRetryDelayS: num('START_RETRY_DELAY_S', 0),
  // Start All / Restart All: how many components with no Start-before condition are started at the same time
  startParallel: num('START_PARALLEL', 1),
  // ... and how many seconds to space out the *launch* of each one, even within that limit, so their JVMs
  // don't all open a DB connection pool in the same instant (a real incident: several Spring Boot apps
  // starting at once saturated the database and every one of them failed HikariPool initialization together)
  startStaggerS: num('START_STAGGER_S', 0),
  // a start that hits a port already in use waits this long for the port to be released before giving up
  portReleaseWaitS: num('PORT_RELEASE_WAIT_S', 0),
  // a unit that is running but has not printed its success line after this long gets the "Mark as started" option
  startHintAfterS: num('START_HINT_AFTER_S', 1),
  // jboss-cli.sh path for WildFly's post-start datasource check - the same across every market/server.
  wildflyCliPath: str('WILDFLY_CLI_PATH'),
  // after a WildFly start, how long to keep asking whether it's ready to receive traffic before giving up
  wildflyReadyTimeoutS: num('WILDFLY_READY_TIMEOUT_S', 0),
  // Artemis report after each start/restart: its login is the same on every market's broker. The password
  // is only in the settings file (never committed).
  artemisUser: str('ARTEMIS_USER'),
  artemisPassword: str('ARTEMIS_PASSWORD'),
  artemisUrl: str('ARTEMIS_URL'),
  // used when the broker's instance folder can't be read from its running process
  artemisInstance: str('ARTEMIS_INSTANCE'),
  // Artemis's own beat (DLQ / ExpiryQueue / memory): three times a day by default, on the Healthcheck machine's clock
  artemisCheckCron: str('ARTEMIS_CHECK_CRON'),
  // heap use at or above this share of the heap Artemis is given turns the report into a danger warning
  artemisMemoryDangerPercent: num('ARTEMIS_MEMORY_DANGER_PERCENT', 1, 100),
  // sign-in: a session ends after this long without use, and after this long in any case
  sessionIdleHours: num('SESSION_IDLE_HOURS', 0.25),
  sessionMaxHours: num('SESSION_MAX_HOURS', 1),
  // wrong passwords in a row before an account is locked, and for how long
  loginMaxAttempts: num('LOGIN_MAX_ATTEMPTS', 3),
  loginLockMinutes: num('LOGIN_LOCK_MINUTES', 1),
  // a temporary password from an admin reset stops working after this many hours
  tempPasswordHours: num('TEMP_PASSWORD_HOURS', 1),
  // The address people open Healthcheck at: `npm run reset-password` prints its one-time links with it.
  publicUrl: (str('PUBLIC_URL') || `http://localhost:${port}`).replace(/\/+$/, ''),
  // how long such a link works
  resetLinkMinutes: num('RESET_LINK_MINUTES', 5),
  // mark the session cookie Secure (only sent over HTTPS) - turn on when Healthcheck is served over HTTPS
  cookieSecure: str('COOKIE_SECURE').toLowerCase() === 'true',
  // the database, SSH key and master.key
  dataDir: inApp('HEALTHCHECK_DATA_DIR', 'server/data'),
  // the catalog and conditions loaded at every start
  defaultsFile: inApp('HEALTHCHECK_DEFAULTS_FILE', 'server/defaults/defaults.json'),
};
