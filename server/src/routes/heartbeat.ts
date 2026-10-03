import { Router } from 'express';
import { sqlite } from '../db/client.js';
import {
  aggregateGroupSoftwareStatus,
  getLatestStatus,
  getServerComponentStatus,
  summarizeStates,
} from '../scan/status.js';
import { env } from '../env.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const heartbeatRouter = Router();

// "*/5 * * * *" -> 5. Anything fancier than every-N-minutes is reported as unknown.
function intervalMinutes(): number | null {
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(env.heartbeatCron.trim());
  return m ? Number(m[1]) : null;
}

heartbeatRouter.get(
  '/groups/:groupId/heartbeat',
  asyncHandler(async (req, res) => {
    const groupId = Number(req.params.groupId);
    const serverRows = sqlite.prepare('SELECT id, name FROM servers WHERE group_id = ?').all(groupId) as {
      id: number;
      name: string;
    }[];
    const links = sqlite
      .prepare(
        `SELECT sd.id, sd.name FROM group_software gs
         JOIN software_definitions sd ON sd.id = gs.software_id
         WHERE gs.group_id = ?
         ORDER BY gs.sequence_order`
      )
      .all(groupId) as { id: number; name: string }[];

    let lastChecked: string | null = null;
    const items = links.map((def) => {
      const servers = serverRows.map((sv) => getServerComponentStatus(sv.id, sv.name, def.id));
      for (const sv of servers) if (sv.checked_at && (!lastChecked || sv.checked_at > lastChecked)) lastChecked = sv.checked_at;
      return {
        software_id: def.id,
        name: def.name,
        state: summarizeStates(servers),
        status: aggregateGroupSoftwareStatus(serverRows.map((s) => s.id), def.id),
        servers,
      };
    });
    res.json({ interval_minutes: intervalMinutes(), last_checked_at: lastChecked, items });
  })
);

// What the latest heartbeat found wrong with WildFly, on every server: running but unable to take traffic, or
// with datasources that can't connect. Only beats count (not Start/Restart runs, which ask in their own popup),
// and only while it's still the latest reading. The page pops a warning for each new one.
heartbeatRouter.get(
  '/alerts',
  asyncHandler(async (_req, res) => {
    const rows = sqlite
      .prepare(
        `SELECT s.id AS server_id, s.name AS server_name, sd.id AS software_id, sd.name AS software_name
         FROM servers s
         JOIN group_software gs ON gs.group_id = s.group_id
         JOIN software_definitions sd ON sd.id = gs.software_id
         ORDER BY s.name, gs.sequence_order`
      )
      .all() as { server_id: number; server_name: string; software_id: number; software_name: string }[];
    const latestSource = sqlite.prepare(
      'SELECT source FROM heartbeat_log WHERE server_id = ? AND software_id = ? ORDER BY id DESC LIMIT 1'
    );
    const alerts = rows.flatMap((row) => {
      const status = getServerComponentStatus(row.server_id, row.server_name, row.software_id);
      if (status.state !== 'not_ready' && status.state !== 'datasource_down') return [];
      const source = (latestSource.get(row.server_id, row.software_id) as { source: string } | undefined)?.source;
      if (source !== 'heartbeat') return [];
      return [
        {
          server_id: row.server_id,
          server_name: row.server_name,
          software_id: row.software_id,
          software_name: row.software_name,
          state: status.state,
          // not_ready: the reason in words; datasource_down: the failed datasource names, comma-separated
          detail: status.detail,
          checked_at: status.checked_at,
        },
      ];
    });
    res.json({ interval_minutes: intervalMinutes(), alerts });
  })
);

heartbeatRouter.get(
  '/groups/:groupId/suggestions',
  asyncHandler(async (req, res) => {
    const groupId = Number(req.params.groupId);
    const serverRows = sqlite.prepare('SELECT id FROM servers WHERE group_id = ?').all(groupId) as { id: number }[];
    const assignedIds = new Set(
      (
        sqlite.prepare('SELECT software_id FROM group_software WHERE group_id = ?').all(groupId) as {
          software_id: number;
        }[]
      ).map((r) => r.software_id)
    );
    const dismissedIds = new Set(
      (
        sqlite.prepare('SELECT software_id FROM suggestion_dismissals WHERE group_id = ?').all(groupId) as {
          software_id: number;
        }[]
      ).map((r) => r.software_id)
    );
    const allDefs = sqlite.prepare('SELECT * FROM software_definitions').all() as { id: number; name: string }[];

    const suggestions = allDefs
      .filter((def) => !assignedIds.has(def.id) && !dismissedIds.has(def.id))
      .filter((def) => serverRows.some((s) => getLatestStatus(s.id, def.id) === 'up'))
      .map((def) => ({ software_id: def.id, name: def.name }));

    res.json(suggestions);
  })
);

heartbeatRouter.post(
  '/groups/:groupId/suggestions/:softwareId/dismiss',
  asyncHandler(async (req, res) => {
    const groupId = Number(req.params.groupId);
    const softwareId = Number(req.params.softwareId);
    sqlite
      .prepare(
        'INSERT OR REPLACE INTO suggestion_dismissals (group_id, software_id, dismissed_at) VALUES (?, ?, ?)'
      )
      .run(groupId, softwareId, new Date().toISOString());
    res.status(204).end();
  })
);
