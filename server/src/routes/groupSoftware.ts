import { Router } from 'express';
import { sqlite } from '../db/client.js';
import { SetGroupSoftwareSchema } from '@healthcheck/shared';
import { autoDiscoverGroupSoftware } from '../scan/autoDiscover.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { resequenceGroup, stopOrderIds } from '../orchestrator/ordering.js';
import { checkGroupNow } from '../heartbeat/scheduler.js';

export const groupSoftwareRouter = Router();

groupSoftwareRouter.post(
  '/groups/:groupId/auto-discover',
  asyncHandler(async (req, res) => {
    const groupId = Number(req.params.groupId);
    const result = await autoDiscoverGroupSoftware(groupId);
    checkGroupNow(groupId);
    res.json(result);
  })
);

groupSoftwareRouter.get(
  '/groups/:groupId/software',
  asyncHandler(async (req, res) => {
    const groupId = Number(req.params.groupId);
    const rows = sqlite
      .prepare(
        `SELECT gs.id, gs.group_id, gs.software_id, gs.sequence_order, sd.*
         FROM group_software gs
         JOIN software_definitions sd ON sd.id = gs.software_id
         WHERE gs.group_id = ?
         ORDER BY gs.sequence_order ASC`
      )
      .all(groupId) as any[];
    const stopPos = new Map(stopOrderIds(groupId).map((id, index) => [id, index]));
    res.json(
      rows.map((row) => ({
        id: row.id,
        group_id: row.group_id,
        software_id: row.software_id,
        sequence_order: row.sequence_order,
        stop_order: stopPos.get(row.software_id) ?? row.sequence_order,
        software: {
          id: row.software_id,
          name: row.name,
          kind: row.kind,
          detect_method: row.detect_method,
          detect_value: row.detect_value,
          start_cmd: row.start_cmd,
          stop_cmd: row.stop_cmd,
          restart_method: row.restart_method,
          log_path: row.log_path,
          success_pattern: row.success_pattern,
          error_pattern: row.error_pattern,
          health_timeout_s: row.health_timeout_s,
        },
      }))
    );
  })
);

groupSoftwareRouter.put(
  '/groups/:groupId/software',
  asyncHandler(async (req, res) => {
    const groupId = Number(req.params.groupId);
    const input = SetGroupSoftwareSchema.parse(req.body);
    sqlite.prepare('DELETE FROM group_software WHERE group_id = ?').run(groupId);
    const insert = sqlite.prepare(
      'INSERT OR IGNORE INTO group_software (group_id, software_id, sequence_order) VALUES (?, ?, ?)'
    );
    for (const item of input.items) {
      insert.run(groupId, item.software_id, item.sequence_order);
    }
    // Membership is what the client decides; the order always comes from the conditions.
    resequenceGroup(groupId);
    checkGroupNow(groupId);
    res.status(204).end();
  })
);
