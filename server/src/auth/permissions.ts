// What a signed-in person may do. Looking at everything (servers, statuses, runs, alerts) needs no permission;
// every action that changes something needs the one listed in permissionFor() (server/src/middleware/auth.ts).

export const PERMISSIONS = [
  // operate
  'start_one',
  'restart_one',
  'stop_one',
  'start_all',
  'restart_all',
  'stop_all',
  'run_checks',
  'view_logs',
  // configure
  'manage_servers',
  'manage_catalog',
  'manage_conditions',
  // administer
  'manage_users',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const OPERATOR: Permission[] = ['start_one', 'restart_one', 'stop_one', 'start_all', 'restart_all', 'stop_all', 'run_checks', 'view_logs'];
export const ALL: Permission[] = [...PERMISSIONS];

export function isPermission(p: string): p is Permission {
  return (PERMISSIONS as readonly string[]).includes(p);
}

// Stored as a JSON array; anything unknown (e.g. from a newer version) is ignored.
export function parsePermissions(json: string | null | undefined): Permission[] {
  try {
    const list = JSON.parse(json ?? '[]');
    return Array.isArray(list) ? PERMISSIONS.filter((p) => list.includes(p)) : [];
  } catch {
    return [];
  }
}
