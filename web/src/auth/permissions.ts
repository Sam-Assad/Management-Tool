// The same permission names as the server (server/src/auth/permissions.ts), with the words people see.
export type Permission =
  | 'start_one'
  | 'restart_one'
  | 'stop_one'
  | 'start_all'
  | 'restart_all'
  | 'stop_all'
  | 'run_checks'
  | 'view_logs'
  | 'manage_servers'
  | 'manage_catalog'
  | 'manage_conditions'
  | 'manage_users';

export const PERMISSION_GROUPS: { title: string; items: { key: Permission; label: string; hint: string }[] }[] = [
  {
    title: 'Run services',
    items: [
      { key: 'start_all', label: 'Start All', hint: 'Start everything on a server (or on several servers at once).' },
      { key: 'restart_all', label: 'Restart All', hint: 'Restart everything on a server, in order.' },
      { key: 'stop_all', label: 'Stop All', hint: 'Stop everything on a server.' },
      { key: 'start_one', label: 'Start a service', hint: 'Start one service.' },
      { key: 'restart_one', label: 'Restart a service', hint: 'Restart one service.' },
      { key: 'stop_one', label: 'Stop a service', hint: 'Stop one service.' },
    ],
  },
  {
    title: 'Look closer',
    items: [
      { key: 'run_checks', label: 'Run checks', hint: 'Check now, Test connection, Artemis Check now.' },
      { key: 'view_logs', label: 'Read logs', hint: "Open a service's log. Logs can contain sensitive data." },
    ],
  },
  {
    title: 'Configure',
    items: [
      { key: 'manage_servers', label: 'Manage servers', hint: "Add servers, stop watching them, change a server's list of services." },
      { key: 'manage_catalog', label: 'Edit the software catalog', hint: 'Add, change or delete catalog entries.' },
      { key: 'manage_conditions', label: 'Edit conditions', hint: 'Change the start/stop order rules.' },
    ],
  },
  {
    title: 'Administer',
    items: [{ key: 'manage_users', label: 'Manage users', hint: 'Add people, set their permissions, reset passwords. This makes them an admin.' }],
  },
];

export const ALL: Permission[] = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key));
export const OPERATOR: Permission[] = ['start_one', 'restart_one', 'stop_one', 'start_all', 'restart_all', 'stop_all', 'run_checks', 'view_logs'];

export const PRESETS: { id: string; label: string; hint: string; permissions: Permission[] }[] = [
  { id: 'viewer', label: 'Viewer', hint: 'Sees everything, changes nothing. For managers.', permissions: [] },
  { id: 'operator', label: 'Operator', hint: 'Starts, stops and restarts services, runs checks, reads logs.', permissions: OPERATOR },
  { id: 'admin', label: 'Admin', hint: 'Everything, including servers, the catalog, conditions and users.', permissions: ALL },
];

// "Operator", "Admin", "Viewer", or "Custom" when the set matches no preset
export function roleName(permissions: string[]): string {
  const set = [...permissions].sort().join(',');
  return PRESETS.find((p) => [...p.permissions].sort().join(',') === set)?.label ?? 'Custom';
}

export const NO_PERMISSION = "You don't have permission for this. Ask an admin.";
