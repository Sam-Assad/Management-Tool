import { sqlite } from '../db/client.js';

export function getLatestStatus(serverId: number, softwareId: number): 'up' | 'down' | 'unknown' {
  const row = sqlite
    .prepare('SELECT status FROM heartbeat_log WHERE server_id = ? AND software_id = ? ORDER BY id DESC LIMIT 1')
    .get(serverId, softwareId) as { status: 'up' | 'down' } | undefined;
  return row?.status ?? 'unknown';
}

export function aggregateGroupSoftwareStatus(
  serverIds: number[],
  softwareId: number
): 'up' | 'down' | 'partial' | 'unknown' {
  const statuses = serverIds.map((id) => getLatestStatus(id, softwareId));
  if (statuses.length === 0 || statuses.every((s) => s === 'unknown')) return 'unknown';
  if (statuses.every((s) => s === 'up')) return 'up';
  if (statuses.every((s) => s === 'down' || s === 'unknown')) return 'down';
  return 'partial';
}

const KNOWN_STATES = ['running', 'stopped', 'failed', 'starting', 'stopping', 'not_installed', 'unreachable'];

export interface ServerComponentStatus {
  server_id: number;
  server_name: string;
  status: 'up' | 'down' | 'unknown';
  state: string;
  checked_at: string | null;
  detail: string | null;
}

// Latest known state of one component on one server. heartbeat/scan rows carry a state word in
// `detail`; anything else in there (older rows, free-text excerpts) falls back to up/down.
export function getServerComponentStatus(
  serverId: number,
  serverName: string,
  softwareId: number
): ServerComponentStatus {
  const row = sqlite
    .prepare(
      'SELECT status, detail, checked_at FROM heartbeat_log WHERE server_id = ? AND software_id = ? ORDER BY id DESC LIMIT 1'
    )
    .get(serverId, softwareId) as { status: 'up' | 'down'; detail: string | null; checked_at: string } | undefined;
  if (!row) {
    return { server_id: serverId, server_name: serverName, status: 'unknown', state: 'unknown', checked_at: null, detail: null };
  }
  const detail = row.detail ?? '';
  let state: string;
  if (detail.startsWith('unreachable')) state = 'unreachable';
  else if (row.status === 'up') state = 'running';
  else state = KNOWN_STATES.includes(detail) ? detail : 'stopped';
  return {
    server_id: serverId,
    server_name: serverName,
    status: row.status,
    state,
    checked_at: row.checked_at,
    detail: detail.startsWith('unreachable') ? detail : null,
  };
}

// One state for the whole group: all servers agree -> that state, otherwise 'mixed'.
export function summarizeStates(perServer: ServerComponentStatus[]): string {
  if (perServer.length === 0) return 'unknown';
  // A server that doesn't have the component at all isn't a disagreement about its state.
  const having = perServer.filter((s) => s.state !== 'not_installed');
  const states = new Set((having.length > 0 ? having : perServer).map((s) => s.state));
  return states.size === 1 ? [...states][0] : 'mixed';
}
