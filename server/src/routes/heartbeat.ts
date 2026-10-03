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
import { latestArtemisCheck, isArtemis, describeArtemisSchedule, type ArtemisReport } from '../scan/artemis.js';
import { checkArtemisNow } from '../heartbeat/artemisBeat.js';

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

interface Alert {
  kind: 'wildfly' | 'artemis';
  server_id: number;
  server_name: string;
  software_id: number;
  software_name: string;
  state: string;
  detail: string | null;
  artemis?: ArtemisReport;
  checked_at: string | null;
}

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
    const alerts = rows.flatMap((row): Alert[] => {
      // Artemis: its own beat found it using too much memory (the latest reading, while it still says so)
      const artemis = latestArtemisCheck(row.server_id, row.software_id);
      if (artemis && artemis.source === 'beat' && artemis.report.tone === 'danger') {
        return [
          {
            kind: 'artemis' as const,
            server_id: row.server_id,
            server_name: row.server_name,
            software_id: row.software_id,
            software_name: row.software_name,
            state: 'memory_high',
            detail: null,
            artemis: artemis.report,
            checked_at: artemis.checked_at,
          },
        ];
      }
      const status = getServerComponentStatus(row.server_id, row.server_name, row.software_id);
      if (status.state !== 'not_ready' && status.state !== 'datasource_down') return [];
      const source = (latestSource.get(row.server_id, row.software_id) as { source: string } | undefined)?.source;
      if (source !== 'heartbeat') return [];
      return [
        {
          kind: 'wildfly' as const,
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
    res.json({ interval_minutes: intervalMinutes(), artemis_schedule: describeArtemisSchedule(), alerts });
  })
);

// The latest Artemis reading on a server (DLQ / ExpiryQueue / memory), for the line under its row.
heartbeatRouter.get(
  '/servers/:serverId/artemis',
  asyncHandler(async (req, res) => {
    const serverId = Number(req.params.serverId);
    const has = (
      sqlite
        .prepare(
          `SELECT sd.* FROM servers s JOIN group_software gs ON gs.group_id = s.group_id
           JOIN software_definitions sd ON sd.id = gs.software_id WHERE s.id = ?`
        )
        .all(serverId) as any[]
    ).some((d) => isArtemis(d));
    res.json({
      has_artemis: has,
      schedule: describeArtemisSchedule(),
      danger_percent: env.artemisMemoryDangerPercent,
      latest: has ? latestArtemisCheck(serverId) : null,
    });
  })
);

// Check now: read this server's Artemis right away (~2 s) and keep the reading.
heartbeatRouter.post(
  '/servers/:serverId/artemis-check',
  asyncHandler(async (req, res) => {
    const check = await checkArtemisNow(Number(req.params.serverId));
    if (!check) return res.status(404).json({ error: "This server doesn't have Artemis." });
    res.json(check);
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
