import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { sqlite } from '../db/client.js';
import { env } from '../env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireAdmin } from '../middleware/auth.js';
import { hashPassword, verifyPassword, burnTime, passwordProblems, temporaryPassword, MIN_LENGTH } from '../auth/passwords.js';
import { ALL, PERMISSIONS } from '../auth/permissions.js';
import QRCode from 'qrcode';
import { codeAt, currentStep, newSecret, otpauthUri, verifyCode } from '../auth/totp.js';
import { decryptSecret, encryptSecret } from '../crypto/secretBox.js';
import {
  COOKIE,
  resetTokenUser,
  useResetToken,
  setPermissions,
  activeAdminCount,
  audit,
  createSession,
  destroySession,
  destroyUserSessions,
  findUser,
  findUserByName,
  toPublic,
  userCount,
  type UserRow,
} from '../auth/store.js';

export const authRouter = Router();

const nowIso = () => new Date().toISOString();
const ipOf = (req: Request) => req.ip ?? req.socket.remoteAddress ?? null;
const fail = (res: Response, status: number, error: string, code?: string) => res.status(status).json({ error, ...(code ? { code } : {}) });

// scrypt runs on every attempt, so a huge "password" must not reach it
const Username = z.string().trim().min(1).max(64);
const Password = z.string().min(1).max(1024);
const NewUsername = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{3,32}$/, 'Use 3-32 letters, digits, dots, dashes or underscores.');
const DisplayName = z.string().trim().min(1, 'Enter a name.').max(80);

function setSessionCookie(res: Response, token: string) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.round(env.sessionMaxHours * 3600)}${env.cookieSecure ? '; Secure' : ''}`,
  );
}

function clearSessionCookie(res: Response) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${env.cookieSecure ? '; Secure' : ''}`);
}

function signIn(req: Request, res: Response, user: UserRow) {
  // a fresh token on every sign-in (never reuse one the browser already had)
  if (req.sessionTokenHash) destroySession(req.sessionTokenHash);
  setSessionCookie(res, createSession(user.id, ipOf(req) ?? undefined, req.get('user-agent')));
}

// ---- guessing protection ----------------------------------------------------------------------------------
// Per account: after env.loginMaxAttempts wrong passwords in a row, locked for env.loginLockMinutes. Usernames
// that don't exist are counted and locked the same way (in memory), so the answers never reveal which exist.
// Per address: at most 30 failures in 15 minutes from one IP, whatever the usernames.
const phantom = new Map<string, { count: number; lockedUntil: number }>();
const ipFailures = new Map<string, number[]>();
const IP_WINDOW_MS = 15 * 60_000;
const IP_MAX = 30;

function ipBlocked(ip: string | null): boolean {
  if (!ip) return false;
  const recent = (ipFailures.get(ip) ?? []).filter((t) => Date.now() - t < IP_WINDOW_MS);
  ipFailures.set(ip, recent);
  return recent.length >= IP_MAX;
}

function noteIpFailure(ip: string | null) {
  if (ip) ipFailures.set(ip, [...(ipFailures.get(ip) ?? []), Date.now()]);
}

function lockedMinutes(until: number): string {
  const m = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  return `${m} minute${m === 1 ? '' : 's'}`;
}

// ---- status / first admin -----------------------------------------------------------------------------------
authRouter.get('/auth/status', (req, res) => {
  res.json({ setup_needed: userCount() === 0, user: req.user ?? null, min_password_length: MIN_LENGTH });
});

// ---- one-time reset link ---------------------------------------------------------------------------------------
// An admin who forgot their password gets a link from `npm run reset-password -- <username>`, run on the
// Healthcheck machine (no email needed). The link's 256-bit token can't be guessed, works once, and expires.
// The reset page asks whether its link still works (and for whom) before showing the form.
authRouter.post('/auth/reset/check', (req, res) => {
  const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.body);
  const user = resetTokenUser(token);
  res.json(user ? { valid: true, username: user.username, display_name: user.display_name } : { valid: false });
});

authRouter.post(
  '/auth/reset',
  asyncHandler(async (req, res) => {
    const { token, new_password } = z.object({ token: z.string().min(10).max(200), new_password: Password }).parse(req.body);
    const user = resetTokenUser(token);
    if (!user) return fail(res, 400, 'This link has expired or was already used. Ask for a new one.', 'bad_link');
    const problems = passwordProblems(new_password, user.username, user.display_name);
    if (problems.length) return fail(res, 400, problems.join(' '), 'weak_password');
    useResetToken(token, user.id);
    sqlite
      .prepare('UPDATE users SET password_hash = ?, must_change_password = 0, temp_password_expires_at = NULL, failed_attempts = 0, locked_until = NULL, password_changed_at = ?, last_login_at = ? WHERE id = ?')
      .run(await hashPassword(new_password), nowIso(), nowIso(), user.id);
    destroyUserSessions(user.id);
    audit('password_reset_by_link', { username: user.username, ip: ipOf(req) });
    signIn(req, res, user);
    res.json({ user: toPublic(findUser(user.id)!) });
  }),
);

// Only while nobody exists yet: the first person to open Healthcheck creates the first admin.
authRouter.post(
  '/auth/setup',
  asyncHandler(async (req, res) => {
    const body = z.object({ username: NewUsername, display_name: DisplayName, password: Password }).parse(req.body);
    const problems = passwordProblems(body.password, body.username, body.display_name);
    if (problems.length) return fail(res, 400, problems.join(' '), 'weak_password');
    const hash = await hashPassword(body.password);
    // checked again after the (slow) hash, and checked-then-inserted with no await in between: two people
    // submitting at once can't both become the first admin
    if (userCount() > 0) return fail(res, 409, 'Healthcheck already has users. Sign in instead.');
    const now = nowIso();
    const id = Number(
      sqlite
        .prepare('INSERT INTO users (username, display_name, password_hash, is_admin, permissions, password_changed_at, created_at, last_login_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)')
        .run(body.username, body.display_name, hash, JSON.stringify(ALL), now, now, now).lastInsertRowid,
    );
    const user = findUser(id)!;
    audit('setup_admin_created', { username: user.username, ip: ipOf(req) });
    signIn(req, res, user);
    res.status(201).json({ user: toPublic(user) });
  }),
);

// ---- sign in / out ----------------------------------------------------------------------------------------
authRouter.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    const { username, password } = z.object({ username: Username, password: Password }).parse(req.body);
    const ip = ipOf(req);
    if (ipBlocked(ip)) return fail(res, 429, 'Too many failed sign-ins from this computer. Wait 15 minutes and try again.', 'ip_limited');

    const user = findUserByName(username);
    const key = username.trim().toLowerCase();
    const lockedUntil = user ? (user.locked_until ? new Date(user.locked_until).getTime() : 0) : (phantom.get(key)?.lockedUntil ?? 0);
    if (lockedUntil > Date.now()) {
      return fail(res, 429, `Too many wrong passwords for this account. Try again in ${lockedMinutes(lockedUntil)}, or ask an admin to reset your password.`, 'locked');
    }

    const ok = user ? await verifyPassword(password, user.password_hash) : (await burnTime(password), false);
    if (!ok) {
      noteIpFailure(ip);
      const lockAt = env.loginMaxAttempts;
      if (user) {
        const attempts = user.failed_attempts + 1;
        const until = attempts >= lockAt ? new Date(Date.now() + env.loginLockMinutes * 60_000).toISOString() : null;
        sqlite.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(until ? 0 : attempts, until, user.id);
        audit(until ? 'account_locked' : 'login_failed', { username: user.username, ip });
      } else {
        const p = phantom.get(key) ?? { count: 0, lockedUntil: 0 };
        p.count += 1;
        if (p.count >= lockAt) phantom.set(key, { count: 0, lockedUntil: Date.now() + env.loginLockMinutes * 60_000 });
        else phantom.set(key, p);
        audit('login_failed', { username: key.slice(0, 64), ip, detail: 'unknown username' });
      }
      return fail(res, 401, 'Username or password is incorrect.', 'bad_credentials');
    }

    // the password was right: from here on, saying why the account can't be used gives nothing away
    if (user!.disabled) {
      audit('login_refused_disabled', { username: user!.username, ip });
      return fail(res, 403, 'This account is disabled. Ask an admin to enable it.', 'disabled');
    }
    if (user!.must_change_password && user!.temp_password_expires_at && new Date(user!.temp_password_expires_at).getTime() < Date.now()) {
      audit('login_refused_temp_expired', { username: user!.username, ip });
      return fail(res, 401, 'This temporary password has expired. Ask an admin for a new one.', 'temp_expired');
    }
    sqlite.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(nowIso(), user!.id);
    audit('login', { username: user!.username, ip });
    signIn(req, res, user!);
    res.json({ user: toPublic(findUser(user!.id)!) });
  }),
);

authRouter.post('/auth/logout', (req, res) => {
  if (req.sessionTokenHash) destroySession(req.sessionTokenHash);
  if (req.user) audit('logout', { username: req.user.username, ip: ipOf(req) });
  clearSessionCookie(res);
  res.status(204).end();
});

// ---- change own password --------------------------------------------------------------------------------------
authRouter.post(
  '/auth/change-password',
  asyncHandler(async (req, res) => {
    if (!req.user) return fail(res, 401, 'Please sign in.');
    const { current_password, new_password } = z.object({ current_password: Password, new_password: Password }).parse(req.body);
    const user = findUser(req.user.id)!;
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      return fail(res, 429, `Too many wrong passwords. Try again in ${lockedMinutes(new Date(user.locked_until).getTime())}.`, 'locked');
    }
    if (!(await verifyPassword(current_password, user.password_hash))) {
      // a stolen session must not be a way to guess the password: wrong "current password"s count too
      const attempts = user.failed_attempts + 1;
      const until = attempts >= env.loginMaxAttempts ? new Date(Date.now() + env.loginLockMinutes * 60_000).toISOString() : null;
      sqlite.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(until ? 0 : attempts, until, user.id);
      audit('password_change_failed', { username: user.username, ip: ipOf(req) });
      return fail(res, 400, 'Your current password is incorrect.', 'bad_current');
    }
    const problems = passwordProblems(new_password, user.username, user.display_name);
    if (problems.length) return fail(res, 400, problems.join(' '), 'weak_password');
    if (await verifyPassword(new_password, user.password_hash)) return fail(res, 400, 'Choose a password different from the current one.', 'same_password');

    sqlite
      .prepare('UPDATE users SET password_hash = ?, must_change_password = 0, temp_password_expires_at = NULL, failed_attempts = 0, locked_until = NULL, password_changed_at = ? WHERE id = ?')
      .run(await hashPassword(new_password), nowIso(), user.id);
    // signed out everywhere else; this browser gets a fresh session
    destroyUserSessions(user.id);
    signIn(req, res, user);
    audit('password_changed', { username: user.username, ip: ipOf(req) });
    res.json({ user: toPublic(findUser(user.id)!) });
  }),
);

// ---- authenticator app (admins): their way back in if they forget their password ------------------------------
// No email and no terminal: the 6-digit code from the app proves it's the admin, and knowing a username is useless
// without it. Used only for "Forgot password", never at normal sign-in.
const Code = z.string().trim().min(1).max(12);

// The code is a real one, but from a time more than ~30 s away: the phone's or this server's clock is off.
function clockOffMinutes(secret: string, code: string): number | null {
  const typed = code.replace(/\s/g, '');
  const now = currentStep();
  for (let d = 2; d <= 20; d++) {
    for (const s of [now - d, now + d]) if (codeAt(secret, s) === typed) return Math.round((d * 30) / 60) || 1;
  }
  return null;
}
const clockText = (minutes: number) =>
  `The code is right, but the time on your phone and on the Healthcheck server are about ${minutes} minute${minutes === 1 ? '' : 's'} apart. Fix the clock that's wrong (both should set their time automatically), then try again.`;

// Step 1: a new secret, shown as a QR code (and as text, to type in). Nothing changes until a code confirms it.
authRouter.post(
  '/auth/authenticator/start',
  asyncHandler(async (req, res) => {
    if (!req.user) return fail(res, 401, 'Please sign in.');
    if (req.user.must_change_password) return fail(res, 403, 'Choose a new password first.', 'must_change_password');
    if (!req.user.is_admin) return fail(res, 403, "The authenticator app is for admins. Anyone else asks an admin to reset their password.");
    const secret = newSecret();
    sqlite.prepare('UPDATE users SET totp_pending_enc = ? WHERE id = ?').run(encryptSecret(secret), req.user.id);
    const uri = otpauthUri(secret, req.user.username);
    res.json({
      secret,
      qr_svg: await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
      server_time: nowIso(),
      replacing: req.user.has_authenticator,
    });
  }),
);

// Step 2: the code the app shows proves it was added. Replacing an existing one also asks for the password, so a
// borrowed session can't swap in someone else's phone.
authRouter.post(
  '/auth/authenticator/confirm',
  asyncHandler(async (req, res) => {
    if (!req.user) return fail(res, 401, 'Please sign in.');
    const { code, password } = z.object({ code: Code, password: Password.optional() }).parse(req.body);
    const user = findUser(req.user.id)!;
    if (!user.totp_pending_enc) return fail(res, 400, 'Start again: the QR code expired.', 'no_pending');
    if (user.totp_secret_enc && !(password && (await verifyPassword(password, user.password_hash)))) {
      return fail(res, 400, 'Your password is incorrect.', 'bad_current');
    }
    const secret = decryptSecret(user.totp_pending_enc);
    const step = verifyCode(secret, code, null);
    if (step === null) {
      const off = clockOffMinutes(secret, code);
      return fail(res, 400, off ? clockText(off) : "That code doesn't match. Type the 6-digit code the app shows for Healthcheck now.", off ? 'clock_off' : 'bad_code');
    }
    sqlite
      .prepare('UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_last_step = ?, totp_set_at = ? WHERE id = ?')
      .run(step, nowIso(), user.id);
    audit(user.totp_secret_enc ? 'authenticator_replaced' : 'authenticator_set_up', { username: user.username, ip: ipOf(req) });
    res.json({ user: toPublic(findUser(user.id)!) });
  }),
);

// From the sign-in page: username + the app's current code + a new password. Wrong codes count toward the same
// lockout as wrong passwords, and the answer is the same whether the username exists, is an admin, or has an app.
authRouter.post(
  '/auth/recover-with-authenticator',
  asyncHandler(async (req, res) => {
    const body = z.object({ username: Username, code: Code, new_password: Password }).parse(req.body);
    const ip = ipOf(req);
    if (ipBlocked(ip)) return fail(res, 429, 'Too many failed attempts from this computer. Wait 15 minutes and try again.', 'ip_limited');
    const user = findUserByName(body.username);
    const key = body.username.trim().toLowerCase();
    const lockedUntil = user ? (user.locked_until ? new Date(user.locked_until).getTime() : 0) : (phantom.get(key)?.lockedUntil ?? 0);
    if (lockedUntil > Date.now()) {
      return fail(res, 429, `Too many failed attempts for this account. Try again in ${lockedMinutes(lockedUntil)}.`, 'locked');
    }
    // the new password first, so a good code isn't spent on a too-weak password
    if (user) {
      const problems = passwordProblems(body.new_password, user.username, user.display_name);
      if (problems.length) return fail(res, 400, problems.join(' '), 'weak_password');
    }
    const usable = user && toPublic(user).is_admin && !user.disabled && user.totp_secret_enc ? user : null;
    const secret = usable ? decryptSecret(usable.totp_secret_enc!) : null;
    const step = usable && secret ? verifyCode(secret, body.code, usable.totp_last_step) : null;
    if (step === null) {
      noteIpFailure(ip);
      if (user) {
        const attempts = user.failed_attempts + 1;
        const until = attempts >= env.loginMaxAttempts ? new Date(Date.now() + env.loginLockMinutes * 60_000).toISOString() : null;
        sqlite.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(until ? 0 : attempts, until, user.id);
        audit(until ? 'account_locked' : 'authenticator_reset_failed', { username: user.username, ip });
      } else {
        const p = phantom.get(key) ?? { count: 0, lockedUntil: 0 };
        p.count += 1;
        phantom.set(key, p.count >= env.loginMaxAttempts ? { count: 0, lockedUntil: Date.now() + env.loginLockMinutes * 60_000 } : p);
        audit('authenticator_reset_failed', { username: key.slice(0, 64), ip, detail: 'unknown username' });
      }
      // only someone holding the phone gets a code that is right apart from the clock, so saying so gives nothing away
      const off = secret ? clockOffMinutes(secret, body.code) : null;
      if (off) return fail(res, 401, clockText(off), 'clock_off');
      return fail(res, 401, "That username and code don't match, or the code was already used. Wait for the next code and try again.", 'bad_code');
    }
    sqlite
      .prepare(
        'UPDATE users SET password_hash = ?, must_change_password = 0, temp_password_expires_at = NULL, failed_attempts = 0, locked_until = NULL, password_changed_at = ?, last_login_at = ?, totp_last_step = ? WHERE id = ?',
      )
      .run(await hashPassword(body.new_password), nowIso(), nowIso(), step, usable!.id);
    destroyUserSessions(usable!.id);
    audit('password_reset_by_authenticator', { username: usable!.username, ip });
    signIn(req, res, usable!);
    res.json({ user: toPublic(findUser(usable!.id)!) });
  }),
);

// ---- users (admins only) ------------------------------------------------------------------------------------
const PermissionList = z
  .array(z.string())
  .max(PERMISSIONS.length)
  .transform((list) => PERMISSIONS.filter((p) => list.includes(p)));

const listUser = (u: UserRow) => ({
  ...toPublic(u),
  disabled: Boolean(u.disabled),
  locked: Boolean(u.locked_until && new Date(u.locked_until).getTime() > Date.now()),
  last_login_at: u.last_login_at,
  password_changed_at: u.password_changed_at,
  created_at: u.created_at,
});

authRouter.get('/users', requireAdmin, (_req, res) => {
  const rows = sqlite.prepare('SELECT * FROM users ORDER BY disabled, username COLLATE NOCASE').all() as unknown as UserRow[];
  res.json(rows.map(listUser));
});

// A new account starts with a temporary password the admin passes on; it must be changed at first sign-in.
authRouter.post(
  '/users',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = z.object({ username: NewUsername, display_name: DisplayName, permissions: PermissionList.default([]) }).parse(req.body);
    if (findUserByName(body.username)) return fail(res, 409, `The username "${body.username}" is already taken.`);
    const temp = temporaryPassword();
    const now = nowIso();
    const id = Number(
      sqlite
        .prepare(
          'INSERT INTO users (username, display_name, password_hash, is_admin, permissions, must_change_password, temp_password_expires_at, password_changed_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
        )
        .run(
          body.username,
          body.display_name,
          await hashPassword(temp),
          body.permissions.includes('manage_users') ? 1 : 0,
          JSON.stringify(body.permissions),
          new Date(Date.now() + env.tempPasswordHours * 3600_000).toISOString(),
          now,
          now,
        ).lastInsertRowid,
    );
    audit('user_created', { username: body.username, actor: req.user!.username, ip: ipOf(req), detail: body.permissions.join(', ') || 'view only' });
    res.status(201).json({ user: listUser(findUser(id)!), temporary_password: temp, expires_in_hours: env.tempPasswordHours });
  }),
);

// Forgot password: an admin issues a temporary one. It unlocks the account, signs the user out everywhere, and
// must be changed at the next sign-in.
authRouter.post(
  '/users/:id/reset-password',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const user = findUser(Number(req.params.id));
    if (!user) return fail(res, 404, 'No such user.');
    if (user.id === req.user!.id) return fail(res, 400, 'Use Change password for your own account.');
    const temp = temporaryPassword();
    sqlite
      .prepare('UPDATE users SET password_hash = ?, must_change_password = 1, temp_password_expires_at = ?, failed_attempts = 0, locked_until = NULL, password_changed_at = ? WHERE id = ?')
      .run(await hashPassword(temp), new Date(Date.now() + env.tempPasswordHours * 3600_000).toISOString(), nowIso(), user.id);
    destroyUserSessions(user.id);
    audit('password_reset', { username: user.username, actor: req.user!.username, ip: ipOf(req) });
    res.json({ user: listUser(findUser(user.id)!), temporary_password: temp, expires_in_hours: env.tempPasswordHours });
  }),
);

authRouter.patch(
  '/users/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        display_name: DisplayName.optional(),
        permissions: PermissionList.optional(),
        disabled: z.boolean().optional(),
        unlock: z.boolean().optional(),
        // an admin who lost their phone: they set up the app again at their next sign-in
        remove_authenticator: z.boolean().optional(),
      })
      .parse(req.body);
    const user = findUser(Number(req.params.id));
    if (!user) return fail(res, 404, 'No such user.');
    const self = user.id === req.user!.id;
    if (self && body.remove_authenticator) return fail(res, 400, 'To use a different phone, choose Authenticator app at the bottom of the sidebar.');
    if (body.remove_authenticator) {
      sqlite.prepare('UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_last_step = NULL, totp_set_at = NULL WHERE id = ?').run(user.id);
    }
    const dropsManage = body.permissions !== undefined && !body.permissions.includes('manage_users');
    if (self && body.disabled) return fail(res, 400, "You can't disable your own account.");
    if (self && dropsManage) return fail(res, 400, "You can't remove your own permission to manage users. Ask another admin.");
    // never leave Healthcheck without someone who can manage users
    const losesAdmin = user.is_admin && !user.disabled && (dropsManage || body.disabled === true);
    if (losesAdmin && activeAdminCount(user.id) === 0) return fail(res, 400, 'This is the only person who can manage users. Give someone else that permission first.');

    if (body.display_name !== undefined) sqlite.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(body.display_name, user.id);
    if (body.permissions !== undefined) setPermissions(user.id, body.permissions);
    if (body.disabled !== undefined) {
      sqlite.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(body.disabled ? 1 : 0, user.id);
      if (body.disabled) destroyUserSessions(user.id);
    }
    if (body.unlock) sqlite.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
    const what = Object.entries(body).map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(' ')}]` : v}`).join(', ');
    audit('user_updated', { username: user.username, actor: req.user!.username, ip: ipOf(req), detail: what });
    res.json(listUser(findUser(user.id)!));
  }),
);

// Recent sign-in activity, for admins.
authRouter.get('/auth/events', requireAdmin, (_req, res) => {
  res.json(sqlite.prepare('SELECT at, event, username, actor, ip, detail FROM auth_events ORDER BY id DESC LIMIT 100').all());
});
