// Which database accounts a service signs in with, and what the logs say about them. Read-only and without
// passwords: the user names come from the service's own settings (WildFly's datasources, a jar's
// application.properties), the errors from the logs.
// Oracle keeps the sessions an app already has when its account is locked or its password expires, and only refuses
// new sign-ins. So its connections and WildFly's "Test connection" still look fine; its log shows it once it tries a
// new connection (WildFly refilling a pool, a jar's request). Such an error is then shown on every service that signs
// in with the same account, on any server: those may not have needed a new connection yet, and will fail when they do.
// The logs show when an account broke, not when it works again (WildFly logged LOYALTY_CONF's lock once, then kept
// using the one connection it had left). So an error stays until someone says it's fixed ("It's fixed" on the server
// page), the service that logged it starts again, or it's a day old. A new error after "It's fixed" counts again.
import { sqlite } from '../db/client.js';

export interface DbAccount {
  user: string; // LOYALTY_CONF
  db: string; // db.lm.example.com:1521/LOYALTY ('' when unknown)
  jndi?: string; // WildFly: java:/LOYALTY_CONF
}

// what a log error says about the account; 'refused' (a wrong password) is about that service's settings, not the
// account, so it isn't shown on the others
export type AccountTrouble = 'locked' | 'expired' | 'refused';
export const ACCOUNT_CODES: Record<string, AccountTrouble> = { 'ORA-28000': 'locked', 'ORA-28001': 'expired', 'ORA-01017': 'refused' };
// as far back as the logs are read (serviceHealth.ts)
export const ACCOUNT_HOURS = 24;

// jdbc:oracle:thin:@//host:1521/SVC, @host:1521/SVC, @host:1521:SID, @(DESCRIPTION=...(HOST=h)(PORT=p)...(SERVICE_NAME=s))
// -> "host:1521/SVC". The same user name on another database is another account.
export function databaseOf(url: string): string {
  const d = /\(HOST\s*=\s*([^)\s]+)\)[\s\S]*?\(PORT\s*=\s*(\d+)\)[\s\S]*?\((?:SERVICE_NAME|SID)\s*=\s*([^)\s]+)\)/i.exec(url);
  if (d) return `${d[1].toLowerCase()}:${d[2]}/${d[3].toUpperCase()}`;
  const m = /@(?:\/\/)?([^:/?;\s()]+)(?::(\d+))?(?:[/:]([^?;\s]+))?/.exec(url);
  return m ? `${m[1].toLowerCase()}:${m[2] ?? '1521'}/${(m[3] ?? '').toUpperCase()}` : '';
}

const account = (user: string, url: string, jndi?: string): DbAccount => ({ user: user.trim().toUpperCase(), db: databaseOf(url), ...(jndi ? { jndi } : {}) });
export const sameAccount = (a: DbAccount, b: DbAccount) => a.user === b.user && (a.db === b.db || !a.db || !b.db);

function unique(accounts: DbAccount[]): DbAccount[] {
  const seen = new Set<string>();
  return accounts.filter((a) => a.user && !seen.has(`${a.user}@${a.db}@${a.jndi ?? ''}`) && seen.add(`${a.user}@${a.db}@${a.jndi ?? ''}`));
}

// ---- a jar: its settings files ------------------------------------------------------------------------------------
// Shell, run after $PID is set: the settings files the jar was started with (--spring.config.location in its start
// command, else its working folder's config/ and itself, else the application.properties inside the jar), and from them
// only the JDBC url and user name lines. Keys with "pass", "secret", "pwd" or "credential" are never printed, and a
// user/password written into a JDBC url is masked. ${NAME} placeholders in those lines are looked up in the process's
// environment (where these services get ${DOMAIN} from), then in the files. Prints "#FILE <path>", the lines, "#VAR N=V".
// Writes nothing on the server.
export function dbConfigCommand(unit: string, quote: (v: string) => string): string {
  const keep =
    `awk '{ k = $0; sub(/[=:].*/, "", k); gsub(/[[:space:]]/, "", k); k = tolower(k); ` +
    `if (k ~ /pass|secret|pwd|credential/) next; ` +
    `if (k ~ /(url|jdbc-url|jdbcurl|user|username|user-name)$/ && tolower($0) ~ /jdbc|user/) print }' | ` +
    `sed -E 's#(jdbc:[a-z]+:[a-z]+:)[^@/]*/[^@]*@#\\1***@#; s#([?&;](password|pwd)=)[^&;]*#\\1***#Ig'`;
  return [
    `EXEC=$(systemctl show -p ExecStart --value ${quote(unit)} 2>/dev/null); WD=$(systemctl show -p WorkingDirectory --value ${quote(unit)} 2>/dev/null)`,
    `ENVF=$([ -n "$PID" ] && tr '\\0' '\\n' < /proc/$PID/environ 2>/dev/null)`,
    `LOCS=$( { printf '%s\\n' "$EXEC" | grep -oE -- '-(-|D)spring\\.config\\.(additional-)?location=[^ ;]+' | sed 's/^[^=]*=//'; ` +
      `printf '%s\\n' "$ENVF" | grep -E '^SPRING_CONFIG_(ADDITIONAL_)?LOCATION=' | cut -d= -f2-; } | tr ',' '\\n' | sed -E 's/^(optional:)?(file:)?//' | grep -v '^classpath:')`,
    `[ -z "$LOCS" ] && [ -n "$WD" ] && LOCS="$WD/config/ $WD/"`,
    `FILES=$(for L in $LOCS; do case "$L" in /*) ;; *) L="$WD/$L";; esac; case "$L" in */) for f in "$L"application.properties "$L"application.yml "$L"application.yaml; do [ -r "$f" ] && echo "$f"; done;; *) [ -r "$L" ] && echo "$L";; esac; done | head -5)`,
    `CONF=$(if [ -n "$FILES" ]; then for f in $FILES; do echo "#FILE $f"; { ${keep}; } < "$f"; done; ` +
      `else JAR=$(printf '%s\\n' "$EXEC" | grep -oE -- '-jar [^ ;]+' | head -1 | cut -c6-); ` +
      `if [ -n "$JAR" ] && command -v unzip >/dev/null 2>&1; then for f in application.properties application.yml; do ` +
      `unzip -p "$JAR" "BOOT-INF/classes/$f" 2>/dev/null | { echo "#FILE $JAR!$f"; ${keep}; }; done; fi; fi 2>/dev/null)`,
    `echo @@DBCONF; printf '%s\\n' "$CONF" | grep -v '^$'`,
    `for n in $(printf '%s\\n' "$CONF" | grep -v '^#' | grep -oE '\\$\\{[A-Za-z0-9_.]+' | cut -c3- | sort -u | grep -viE 'pass|secret|pwd|credential|token|key'); do ` +
      `v=$(printf '%s\\n' "$ENVF" | grep -m1 "^$n=" | cut -d= -f2-); ` +
      `[ -z "$v" ] && [ -n "$FILES" ] && v=$(cat $FILES 2>/dev/null | awk -v n="$n" '{ k = $0; sub(/[=:].*/, "", k); gsub(/[[:space:]]/, "", k) } k == n { sub(/^[^=:]*[=:][[:space:]]*/, ""); print; exit }'); ` +
      `[ -n "$v" ] && echo "#VAR $n=$v"; done`,
  ].join('\n');
}

// What dbConfigCommand printed -> the accounts. A url is paired with the user name next to it: same prefix in a
// .properties file (spring.datasource.url / spring.datasource.username, loyalty.conf.datasource.*, ...jdbc-url, a
// Hikari block), the nearest one in a .yml file.
export function accountsFromConfig(lines: string[]): DbAccount[] {
  const vars = new Map<string, string>();
  for (const l of lines) {
    const m = /^#VAR ([A-Za-z0-9_.]+)=(.*)$/.exec(l);
    if (m) vars.set(m[1], m[2].trim());
  }
  const resolve = (v: string) => v.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (all, name: string, dflt?: string) => vars.get(name) ?? dflt ?? all);
  const props = new Map<string, string>(); // lower-case key -> value; a later file wins, as in Spring
  const yaml: { key: string; value: string }[] = [];
  let isYaml = false;
  for (const l of lines) {
    if (l.startsWith('#FILE ')) {
      isYaml = /\.ya?ml$/i.test(l.trim());
      continue;
    }
    if (l.startsWith('#')) continue;
    const m = /^\s*([A-Za-z0-9_.\-[\]]+)\s*[=:]\s*(.*?)\s*$/.exec(l);
    if (!m || /pass|secret|pwd|credential/i.test(m[1])) continue;
    const value = resolve(m[2].replace(/^["']|["']$/g, ''));
    if (isYaml) yaml.push({ key: m[1].toLowerCase(), value });
    else props.set(m[1].toLowerCase(), value);
  }
  const isUrlKey = (k: string) => /(^|[.-])(url|jdbc-url|jdbcurl)$/.test(k);
  const isUserKey = (k: string) => /(^|[.-])(username|user|user-name)$/.test(k);
  const out: DbAccount[] = [];
  for (const [k, url] of props) {
    if (!isUrlKey(k) || !/^jdbc:/i.test(url)) continue;
    const prefix = k.slice(0, k.lastIndexOf('.') + 1);
    const parent = prefix.replace(/hikari\.$/, '');
    const user = ['username', 'user', 'user-name'].flatMap((u) => [prefix + u, `${prefix}hikari.${u}`, parent + u]).map((key) => props.get(key)).find(Boolean);
    if (user && !user.includes('${')) out.push(account(user, url));
  }
  const used = new Set<number>();
  yaml.forEach((e, i) => {
    if (!isUrlKey(e.key) || !/^jdbc:/i.test(e.value)) return;
    let best = -1;
    yaml.forEach((u, j) => {
      if (isUserKey(u.key) && !used.has(j) && (best < 0 || Math.abs(j - i) < Math.abs(best - i))) best = j;
    });
    if (best >= 0 && !yaml[best].value.includes('${')) {
      used.add(best);
      out.push(account(yaml[best].value, e.value));
    }
  });
  return unique(out);
}

// ---- WildFly: its datasources, from jboss-cli --------------------------------------------------------------------
// `/subsystem=datasources/data-source=*:read-attribute(name=...)` -> datasource name -> value
export function parseAttributeList(reply: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const chunk of reply.split(/"address"\s*=>/).slice(1)) {
    const name = /\("(?:xa-)?data-source"\s*=>\s*"([^"]+)"\)/.exec(chunk)?.[1];
    const value = /"result"\s*=>\s*"((?:[^"\\]|\\.)*)"/.exec(chunk)?.[1];
    if (name && value !== undefined && !values.has(name)) values.set(name, value);
  }
  return values;
}

export function wildflyAccounts(users: Map<string, string>, jndis: Map<string, string>, urls: Map<string, string>): DbAccount[] {
  return unique([...users].map(([ds, user]) => account(user, urls.get(ds) ?? '', jndis.get(ds))));
}

// ---- "It's fixed" ---------------------------------------------------------------------------------------------------
// Someone said it works again (the account unlocked, its password renewed or corrected): the errors logged before then
// are left out, for that account on every service, and for that service's own log. Times in ms, 0 = never.
export interface Fixes {
  account: (a: DbAccount) => number;
  service: (serverId: number, softwareId: number) => number;
}

const accountScope = (a: DbAccount) => `account|${a.user}|${a.db}`;
const serviceScope = (serverId: number, softwareId: number) => `service|${serverId}|${softwareId}`;

export function loadFixes(): Fixes {
  const rows = sqlite.prepare('SELECT scope, fixed_at FROM db_account_fixes').all() as { scope: string; fixed_at: string }[];
  const accounts = rows
    .filter((r) => r.scope.startsWith('account|'))
    .map((r) => {
      const [, user, db] = r.scope.split('|');
      return { a: { user, db }, at: Date.parse(r.fixed_at) };
    });
  const services = new Map(rows.filter((r) => r.scope.startsWith('service|')).map((r) => [r.scope, Date.parse(r.fixed_at)]));
  return {
    account: (a) => Math.max(0, ...accounts.filter((f) => sameAccount(f.a, a)).map((f) => f.at)),
    service: (serverId, softwareId) => services.get(serviceScope(serverId, softwareId)) ?? 0,
  };
}

// ---- shared between services ---------------------------------------------------------------------------------------
export interface SeenAccountError {
  server_id: number;
  software_id: number;
  server: string;
  software: string;
  user: string;
  db: string;
  code: string; // ORA-28000
  text: string; // "ORA-28000: The account is locked."
  logged_at: string; // ISO, on Healthcheck's clock
}

// The account errors in one service's log right now (since it last started) replace what it had before: once it's
// restarted fine, or they're marked fixed, nothing of it is left to show on the others. One the log doesn't pin to an
// account (a jar with several) is kept with an empty user name: only for that service.
export function saveAccountErrors(serverId: number, softwareId: number, errors: { account: DbAccount; code: string; text: string; loggedAt: string }[]) {
  sqlite.prepare('DELETE FROM db_account_errors WHERE server_id = ? AND software_id = ?').run(serverId, softwareId);
  const put = sqlite.prepare(
    'INSERT OR REPLACE INTO db_account_errors (server_id, software_id, user_name, db, code, text, logged_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const now = new Date().toISOString();
  for (const e of errors) put.run(serverId, softwareId, e.account.user, e.account.db, e.code, e.text, e.loggedAt, now);
}

// The accounts a service signs in with, as its last check read them: who else to check again after "It's fixed".
export function saveServiceAccounts(serverId: number, softwareId: number, accounts: DbAccount[]) {
  sqlite.prepare('DELETE FROM service_db_accounts WHERE server_id = ? AND software_id = ?').run(serverId, softwareId);
  const put = sqlite.prepare('INSERT OR REPLACE INTO service_db_accounts (server_id, software_id, user_name, db, seen_at) VALUES (?, ?, ?, ?, ?)');
  const now = new Date().toISOString();
  for (const a of accounts) put.run(serverId, softwareId, a.user, a.db, now);
}

const accountsSaved = (serverId: number, softwareId: number) =>
  sqlite.prepare('SELECT user_name AS user, db FROM service_db_accounts WHERE server_id = ? AND software_id = ?').all(serverId, softwareId) as unknown as DbAccount[];

// Locked / expired errors for these accounts in OTHER services' logs (on any server), not marked fixed since.
export function accountErrorsSeenElsewhere(serverId: number, softwareId: number, accounts: DbAccount[], fixes: Fixes = loadFixes()): SeenAccountError[] {
  if (accounts.length === 0) return [];
  const since = new Date(Date.now() - ACCOUNT_HOURS * 3_600_000).toISOString();
  const rows = sqlite
    .prepare(
      `SELECT e.server_id, e.software_id, s.name AS server, d.name AS software, e.user_name AS user, e.db, e.code, e.text, e.logged_at
       FROM db_account_errors e JOIN servers s ON s.id = e.server_id JOIN software_definitions d ON d.id = e.software_id
       WHERE e.logged_at >= ? AND e.code IN ('ORA-28000', 'ORA-28001') AND NOT (e.server_id = ? AND e.software_id = ?)
       ORDER BY e.logged_at DESC`,
    )
    .all(since, serverId, softwareId) as unknown as SeenAccountError[];
  return rows.filter(
    (r) => r.user && accounts.some((a) => sameAccount(a, { user: r.user, db: r.db })) && Date.parse(r.logged_at) > fixes.account({ user: r.user, db: r.db }),
  );
}

interface Trouble {
  software_id: number;
  // the accounts the errors are about (for "It's fixed"); `users`: their names as shown, or the service's own when its
  // log didn't say which
  accounts: DbAccount[];
  users: string[];
}

// The services on a server whose database account trouble isn't marked fixed: where "It's fixed" is offered.
export function accountTroubles(serverId: number, fixes: Fixes = loadFixes()): Trouble[] {
  const since = Date.now() - ACCOUNT_HOURS * 3_600_000;
  const softwareIds = (
    sqlite
      .prepare('SELECT software_id FROM db_account_errors WHERE server_id = ? UNION SELECT software_id FROM service_db_accounts WHERE server_id = ?')
      .all(serverId, serverId) as { software_id: number }[]
  ).map((r) => r.software_id);
  const out: Trouble[] = [];
  for (const softwareId of softwareIds) {
    const mine = accountsSaved(serverId, softwareId);
    const accounts: DbAccount[] = [];
    const users = new Set<string>();
    let any = false;
    const own = sqlite
      .prepare('SELECT user_name AS user, db, logged_at FROM db_account_errors WHERE server_id = ? AND software_id = ?')
      .all(serverId, softwareId) as { user: string; db: string; logged_at: string }[];
    for (const e of own) {
      const at = Date.parse(e.logged_at);
      const fixedAt = Math.max(fixes.service(serverId, softwareId), ...(e.user ? [fixes.account(e)] : mine.map((a) => fixes.account(a))));
      if (at < since || at <= fixedAt) continue;
      any = true;
      if (e.user) {
        accounts.push({ user: e.user, db: e.db });
        users.add(e.user);
      } else for (const a of mine) users.add(a.user);
    }
    for (const e of accountErrorsSeenElsewhere(serverId, softwareId, mine, fixes)) {
      any = true;
      accounts.push({ user: e.user, db: e.db });
      users.add(e.user);
    }
    if (any) out.push({ software_id: softwareId, accounts: unique(accounts), users: [...users] });
  }
  return out;
}

// "It's fixed" on one service: its accounts' errors (and its own log's) up to now are left out everywhere. -> the
// services, on any server, that sign in with those accounts or logged them: to check again.
export function markAccountsFixed(serverId: number, softwareId: number, by: string | null): { users: string[]; recheck: { server_id: number; software_id: number }[] } {
  const trouble = accountTroubles(serverId).find((t) => t.software_id === softwareId);
  const now = new Date().toISOString();
  const put = sqlite.prepare('INSERT OR REPLACE INTO db_account_fixes (scope, fixed_at, fixed_by) VALUES (?, ?, ?)');
  put.run(serviceScope(serverId, softwareId), now, by);
  for (const a of trouble?.accounts ?? []) put.run(accountScope(a), now, by);
  const recheck = new Map<string, { server_id: number; software_id: number }>([[`${serverId}|${softwareId}`, { server_id: serverId, software_id: softwareId }]]);
  const rows = sqlite
    .prepare('SELECT server_id, software_id, user_name AS user, db FROM service_db_accounts UNION SELECT server_id, software_id, user_name AS user, db FROM db_account_errors')
    .all() as { server_id: number; software_id: number; user: string; db: string }[];
  for (const r of rows) {
    if (r.user && (trouble?.accounts ?? []).some((a) => sameAccount(a, r))) recheck.set(`${r.server_id}|${r.software_id}`, { server_id: r.server_id, software_id: r.software_id });
  }
  return { users: trouble?.users ?? [], recheck: [...recheck.values()] };
}
