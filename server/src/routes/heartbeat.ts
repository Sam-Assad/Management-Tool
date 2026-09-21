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
