import type { NextFunction, Request, Response } from 'express';
import { COOKIE, parseCookies, resolveSession, toPublic, type PublicUser } from '../auth/store.js';
import type { Permission } from '../auth/permissions.js';
import { sqlite } from '../db/client.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser;
      sessionTokenHash?: string;
    }
  }
}

// Requests that change something must carry this header. A page on another site can't add a custom header to
// a request to us without our permission (CORS, which this app never grants), so together with the
// SameSite=Strict cookie this blocks cross-site request forgery.
export const CSRF_HEADER = 'x-healthcheck';

export function csrfGuard(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.get(CSRF_HEADER) !== '1') return res.status(403).json({ error: 'Request blocked: missing the Healthcheck header.' });
  next();
}

// Attaches the signed-in user (if any) to every request.
export function loadUser(req: Request, _res: Response, next: NextFunction) {
  const session = resolveSession(parseCookies(req.headers.cookie)[COOKIE]);
  if (session) {
    req.user = toPublic(session.user);
    req.sessionTokenHash = session.tokenHash;
  }
  next();
}

// Everything under /api except the sign-in endpoints. A user who must choose a new password can do nothing else
// until they have.
export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  if (req.user.must_change_password) return res.status(403).json({ error: 'Choose a new password first.', code: 'must_change_password' });
  next();
}

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
    if (req.user.must_change_password) return res.status(403).json({ error: 'Choose a new password first.', code: 'must_change_password' });
    if (!req.user.permissions.includes(permission)) return refuse(res, permission);
    next();
  };
}

export const requireAdmin = requirePermission('manage_users');

const WHAT: Record<Permission, string> = {
  start_one: 'start a service',
  restart_one: 'restart a service',
  stop_one: 'stop a service',
  start_all: 'run Start All',
  restart_all: 'run Restart All',
  stop_all: 'run Stop All',
  run_checks: 'run checks',
  view_logs: 'read service logs',
  manage_servers: 'add, change or remove servers',
  manage_catalog: 'change the software catalog',
  manage_conditions: 'change the start/stop conditions',
  manage_users: 'manage users',
};

function refuse(res: Response, permission: Permission) {
  return res.status(403).json({ error: `You don't have permission to ${WHAT[permission]}. Ask an admin.`, code: 'forbidden', permission });
}

// ---- which permission each action needs ------------------------------------------------------------------
// Every request that changes something (and reading logs) is matched here. A change that matches nothing is
// refused: a new endpoint must be listed before anyone can use it.
const RULES: { method: string; path: RegExp; permission: Permission | ((req: Request) => Permission | null) }[] = [
  { method: 'POST', path: /^\/groups\/\d+\/start-all$/, permission: 'start_all' },
  { method: 'POST', path: /^\/groups\/\d+\/restart-all$/, permission: 'restart_all' },
  { method: 'POST', path: /^\/groups\/\d+\/stop-all$/, permission: 'stop_all' },
  { method: 'POST', path: /^\/servers\/\d+\/software\/\d+\/start$/, permission: 'start_one' },
  { method: 'POST', path: /^\/servers\/\d+\/software\/\d+\/restart$/, permission: 'restart_one' },
  { method: 'POST', path: /^\/servers\/\d+\/software\/\d+\/stop$/, permission: 'stop_one' },
  { method: 'POST', path: /^\/groups\/\d+\/scan$/, permission: 'run_checks' },
  { method: 'POST', path: /^\/servers\/\d+\/artemis-check$/, permission: 'run_checks' },
  { method: 'POST', path: /^\/servers\/\d+\/test-connection$/, permission: 'run_checks' },
  // answering a run's question / vouching for a step: whoever may start that kind of run
  { method: 'POST', path: /^\/jobs\/\d+\/(decision|steps\/\d+\/accept)$/, permission: (req) => jobPermission(Number(req.path.split('/')[2])) },
  { method: 'GET', path: /^\/servers\/\d+\/software\/\d+\/logs(\/stream)?$/, permission: 'view_logs' },
  { method: 'POST', path: /^\/servers$/, permission: 'manage_servers' },
  { method: 'PATCH', path: /^\/servers\/\d+$/, permission: 'manage_servers' },
  { method: 'DELETE', path: /^\/servers\/\d+$/, permission: 'manage_servers' },
  { method: 'POST', path: /^\/groups\/?$/, permission: 'manage_servers' },
  { method: 'PATCH', path: /^\/groups\/\d+$/, permission: 'manage_servers' },
  { method: 'DELETE', path: /^\/groups\/\d+$/, permission: 'manage_servers' },
  { method: 'PUT', path: /^\/groups\/\d+\/software$/, permission: 'manage_servers' },
  { method: 'POST', path: /^\/groups\/\d+\/auto-discover$/, permission: 'manage_servers' },
  { method: 'POST', path: /^\/groups\/\d+\/suggestions\/\d+\/dismiss$/, permission: 'manage_servers' },
  { method: 'POST', path: /^\/software-definitions$/, permission: 'manage_catalog' },
  { method: 'PATCH', path: /^\/software-definitions\/\d+$/, permission: 'manage_catalog' },
  { method: 'DELETE', path: /^\/software-definitions\/\d+$/, permission: 'manage_catalog' },
  { method: 'POST', path: /^\/conditions$/, permission: 'manage_conditions' },
  { method: 'PATCH', path: /^\/conditions\/\d+$/, permission: 'manage_conditions' },
  { method: 'DELETE', path: /^\/conditions\/\d+$/, permission: 'manage_conditions' },
];

const JOB_PERMISSION: Record<string, Permission> = {
  start_all: 'start_all',
  restart_all: 'restart_all',
  stop_all: 'stop_all',
  start_one: 'start_one',
  restart_one: 'restart_one',
  stop_one: 'stop_one',
  scan: 'run_checks',
};

function jobPermission(jobId: number): Permission | null {
  const job = sqlite.prepare('SELECT kind FROM job_runs WHERE id = ?').get(jobId) as { kind: string } | undefined;
  return job ? (JOB_PERMISSION[job.kind] ?? null) : null;
}

// Mounted on /api after requireUser (so req.path is relative to /api).
export function permissionGate(req: Request, res: Response, next: NextFunction) {
  const rule = RULES.find((r) => r.method === req.method && r.path.test(req.path));
  if (!rule) {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    return res.status(403).json({ error: 'This action is not allowed.', code: 'forbidden' });
  }
  const needed = typeof rule.permission === 'function' ? rule.permission(req) : rule.permission;
  if (!needed) return next(); // e.g. a run id that doesn't exist: the route answers 404 itself
  if (!req.user!.permissions.includes(needed)) return refuse(res, needed);
  next();
}
