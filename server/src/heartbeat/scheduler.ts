import cron from 'node-cron';
import pLimit from 'p-limit';
import { sqlite, insertRow } from '../db/client.js';
import { getConnection } from '../ssh/connectionManager.js';
import { checkComponent, detectInstalled } from '../scan/detectors.js';
import type { ComponentState } from '../scan/detectors.js';
import { env } from '../env.js';
import type { SoftwareDefinition, Server as ServerRow } from '@healthcheck/shared';

const limit = pLimit(5);
const KEEP_DAYS = 3;

function latestDetail(serverId: number, softwareId: number): string | null {
  const row = sqlite
    .prepare('SELECT detail FROM heartbeat_log WHERE server_id = ? AND software_id = ? ORDER BY id DESC LIMIT 1')
    .get(serverId, softwareId) as { detail: string | null } | undefined;
  return row?.detail ?? null;
}

function record(serverId: number, softwareId: number, source: 'heartbeat' | 'discovery', up: boolean, detail: string) {
  // A component a run just parked as "Failed (due to expired password)" is still down every time this
  // beat re-checks it - systemd shows it plainly "inactive"/"stopped", nothing wrong with that reading,
  // just less useful than the reason we already know. Keep the reason until either it comes back up (a
  // real change worth recording) or a fresh Start/Restart attempt records its own new outcome.
  if (source === 'heartbeat' && !up && latestDetail(serverId, softwareId) === 'credential_expired') return;
  insertRow('heartbeat_log', {
    server_id: serverId,
    software_id: softwareId,
    source,
    status: up ? 'up' : 'down',
    detail,
    checked_at: new Date().toISOString(),
  });
}

// One beat for one group: every component in the group on every server (its state is what the
// group page shows), plus a probe of the rest of the catalog to power "installed but not in this
// group" suggestions.
export async function checkGroup(groupId: number) {
  const allDefs = sqlite.prepare('SELECT * FROM software_definitions').all() as unknown as SoftwareDefinition[];
  const groupServers = sqlite
    .prepare('SELECT * FROM servers WHERE group_id = ?')
    .all(groupId) as unknown as ServerRow[];
  const assignedIds = new Set(
    (
      sqlite.prepare('SELECT software_id FROM group_software WHERE group_id = ?').all(groupId) as {
        software_id: number;
      }[]
    ).map((r) => r.software_id)
  );
  const assignedDefs = allDefs.filter((d) => assignedIds.has(d.id));
  const candidateDefs = allDefs.filter((d) => !assignedIds.has(d.id));

  // Per component: what each server reported. Only a clean "not installed" from EVERY server
  // (no unreachable hosts, no failed probes) counts as "this group doesn't have it".
  const outcomes = new Map<number, ('missing' | 'present' | 'unknown')[]>();
  const note = (defId: number, outcome: 'missing' | 'present' | 'unknown') =>
    outcomes.set(defId, [...(outcomes.get(defId) ?? []), outcome]);

  await Promise.all(
    groupServers.map((server) =>
      limit(async () => {
        // One connection attempt per server per beat: if it's unreachable, every component on
        // it is unreachable - don't wait out a connect timeout once per component.
        let client;
        try {
          client = await getConnection(server as any);
        } catch (err: any) {
          const detail = `unreachable: ${String(err?.message ?? err)}`;
          for (const def of assignedDefs) {
            record(server.id, def.id, 'heartbeat', false, detail);
            note(def.id, 'unknown');
          }
          return;
        }

        for (const def of assignedDefs) {
          try {
            const { up, state } = await checkComponent(client, def);
            record(server.id, def.id, 'heartbeat', up, state);
            note(def.id, state === 'not_installed' ? 'missing' : 'present');
          } catch (err: any) {
            record(server.id, def.id, 'heartbeat', false, `unreachable: ${String(err?.message ?? err)}`);
            note(def.id, 'unknown');
          }
        }
        for (const def of candidateDefs) {
          try {
            // "installed" (unit exists), not just "running": a stopped-but-installed
            // component is still something this group should manage.
            if (await detectInstalled(client, def)) record(server.id, def.id, 'discovery', true, 'running' as ComponentState);
          } catch {
            // this server dropped mid-beat - skip discovery probes for it
          }
        }
      })
    )
  );

  // A group only lists what's installed on its servers: drop members no server has.
  if (groupServers.length > 0) {
    const drop = sqlite.prepare('DELETE FROM group_software WHERE group_id = ? AND software_id = ?');
    for (const def of assignedDefs) {
      const seen = outcomes.get(def.id) ?? [];
      if (seen.length === groupServers.length && seen.every((o) => o === 'missing')) {
        drop.run(groupId, def.id);
        console.log(`Group ${groupId}: ${def.name} is not installed on any server - removed from the group`);
      }
    }
  }
}

export function checkGroupNow(groupId: number) {
  checkGroup(groupId).catch((err) => console.error(`Heartbeat for group ${groupId} failed`, err));
}

let ticking = false;

async function tick() {
  // A slow beat (many servers, unreachable hosts) must never overlap the next one.
  if (ticking) return;
  ticking = true;
  try {
    const groups = sqlite.prepare('SELECT id FROM groups').all() as { id: number }[];
    for (const group of groups) await checkGroup(group.id);
    const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 3600 * 1000).toISOString();
    sqlite.prepare('DELETE FROM heartbeat_log WHERE checked_at < ?').run(cutoff);
  } finally {
    ticking = false;
  }
}

export function startHeartbeatScheduler() {
  cron.schedule(env.heartbeatCron, () => {
    tick().catch((err) => console.error('Heartbeat tick failed', err));
  });
  // Don't leave the group pages on "unknown" for a whole interval after a restart.
  setTimeout(() => tick().catch((err) => console.error('Initial heartbeat failed', err)), 5000);
}
