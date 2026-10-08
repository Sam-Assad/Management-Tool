import crypto from 'node:crypto';
import { sqlite } from '../db/client.js';
import { env } from '../env.js';
import { parsePermissions, type Permission } from './permissions.js';

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  is_admin: number;
  disabled: number;
  must_change_password: number;
  temp_password_expires_at: string | null;
  failed_attempts: number;
  locked_until: string | null;
  password_changed_at: string;
  last_login_at: string | null;
  created_at: string;
  permissions: string | null;
  totp_secret_enc: string | null;
  totp_pending_enc: string | null;
  totp_last_step: number | null;
  totp_set_at: string | null;
}

// What the browser is told about a user - never the hash or lockout counters.
export interface PublicUser {
  id: number;
  username: string;
  display_name: string;
  // "admin" = may manage users (kept in step with the manage_users permission)
  is_admin: boolean;
  permissions: Permission[];
  must_change_password: boolean;
  // admins recover a forgotten password with an authenticator app, so they must set one up before going on
  has_authenticator: boolean;
  needs_authenticator: boolean;
}

export const toPublic = (u: UserRow): PublicUser => {
  const permissions = parsePermissions(u.permissions);
  const isAdmin = permissions.includes('manage_users');
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    is_admin: isAdmin,
    permissions,
    must_change_password: Boolean(u.must_change_password),
    has_authenticator: Boolean(u.totp_secret_enc),
    needs_authenticator: isAdmin && !u.totp_secret_enc,
  };
};

// ---- one-time reset links (made by `npm run reset-password` on the Healthcheck machine) ---------------------
// 32 random bytes in the link; the table keeps only their SHA-256. A new link cancels earlier unused ones.
export function createResetToken(userId: number, minutes: number, ip?: string | null): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  sqlite.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(userId);
  sqlite
    .prepare('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), userId, new Date(now).toISOString(), new Date(now + minutes * 60_000).toISOString(), ip ?? null);
  sqlite.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(new Date(now - 7 * 24 * 3600_000).toISOString());
  return token;
}

// The user a still-valid, unused link belongs to.
export function resetTokenUser(token: string): UserRow | null {
  const row = sqlite.prepare('SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?').get(sha256(token)) as
    | { user_id: number; expires_at: string; used_at: string | null }
    | undefined;
  if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) return null;
  const user = findUser(row.user_id);
  return user && !user.disabled ? user : null;
}

export function useResetToken(token: string, userId: number) {
  sqlite.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(nowIso(), sha256(token));
  // any other outstanding link for this person stops working too
  sqlite.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(userId);
}

// Set someone's permissions (is_admin follows manage_users).
export function setPermissions(userId: number, permissions: Permission[]) {
  sqlite
    .prepare('UPDATE users SET permissions = ?, is_admin = ? WHERE id = ?')
    .run(JSON.stringify(permissions), permissions.includes('manage_users') ? 1 : 0, userId);
}

const nowIso = () => new Date().toISOString();

export function userCount(): number {
  return (sqlite.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
}

export function findUserByName(username: string): UserRow | undefined {
  return sqlite.prepare('SELECT * FROM users WHERE username = ?').get(username.trim()) as UserRow | undefined;
}

export function findUser(id: number): UserRow | undefined {
  return sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

// People who can still manage users (enabled, with manage_users), not counting `exceptId`.
export function activeAdminCount(exceptId?: number): number {
  return (
    sqlite.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1 AND disabled = 0 AND id != ?').get(exceptId ?? -1) as { c: number }
  ).c;
}

export function audit(event: string, fields: { username?: string | null; actor?: string | null; ip?: string | null; detail?: string | null } = {}) {
  sqlite
    .prepare('INSERT INTO auth_events (at, event, username, actor, ip, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(nowIso(), event, fields.username ?? null, fields.actor ?? null, fields.ip ?? null, fields.detail ?? null);
  // keep a year of history
  sqlite.prepare("DELETE FROM auth_events WHERE at < ?").run(new Date(Date.now() - 365 * 24 * 3600_000).toISOString());
}

// ---- sessions -------------------------------------------------------------------------------------------
// The cookie carries 32 random bytes; the table keeps only their SHA-256.
export const COOKIE = 'hc_session';
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function createSession(userId: number, ip?: string, userAgent?: string): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  sqlite
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sha256(token), userId, new Date(now).toISOString(), new Date(now).toISOString(), new Date(now + env.sessionMaxHours * 3600_000).toISOString(), ip ?? null, (userAgent ?? '').slice(0, 200));
  // tidy up sessions that ended long ago
  sqlite.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date(now - 24 * 3600_000).toISOString());
  return token;
}

// The signed-in user for a cookie token, or null when it's unknown, expired (idle or overall) or the user is
// disabled. Each use pushes the idle deadline on (written at most once a minute).
export function resolveSession(token: string | undefined): { user: UserRow; tokenHash: string } | null {
  if (!token) return null;
  const tokenHash = sha256(token);
  const row = sqlite.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as
    | { user_id: number; last_seen_at: string; expires_at: string }
    | undefined;
  if (!row) return null;
  const now = Date.now();
  const idleFor = now - new Date(row.last_seen_at).getTime();
  if (now > new Date(row.expires_at).getTime() || idleFor > env.sessionIdleHours * 3600_000) {
    sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  const user = findUser(row.user_id);
  if (!user || user.disabled) return null;
  if (idleFor > 60_000) sqlite.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(new Date(now).toISOString(), tokenHash);
  return { user, tokenHash };
}

export function destroySession(tokenHash: string) {
  sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

// Sign a user out everywhere (password reset, disabled), or everywhere but here (own password change).
export function destroyUserSessions(userId: number, exceptTokenHash?: string) {
  sqlite.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, exceptTokenHash ?? '');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
