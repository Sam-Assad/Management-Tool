import { Router } from 'express';
import { sqlite, insertRow, updateRow, deleteRow } from '../db/client.js';
import { CreateGroupSchema } from '@healthcheck/shared';
import { aggregateGroupSoftwareStatus } from '../scan/status.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const groupsRouter = Router();

groupsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const rows = sqlite.prepare('SELECT * FROM groups').all() as any[];
    const out = [];
    for (const group of rows) {
      const serverRows = sqlite.prepare('SELECT * FROM servers WHERE group_id = ?').all(group.id) as any[];
      const links = sqlite
        .prepare(
          `SELECT sd.* FROM group_software gs
           JOIN software_definitions sd ON sd.id = gs.software_id
           WHERE gs.group_id = ?`
        )
        .all(group.id) as any[];
      const software = links.map((def) => ({
        software_id: def.id,
        name: def.name,
        status: aggregateGroupSoftwareStatus(serverRows.map((s) => s.id), def.id),
      }));
      out.push({ ...group, server_count: serverRows.length, software });
    }
    res.json(out);
  })
);

groupsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = CreateGroupSchema.parse(req.body);
    const row = insertRow('groups', {
      name: input.name,
      description: input.description ?? null,
      created_at: new Date().toISOString(),
    });
    res.status(201).json(row);
  })
);

groupsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const group = sqlite.prepare('SELECT * FROM groups WHERE id = ?').get(id) as any;
    if (!group) return res.status(404).json({ error: 'Not found' });
    const serverRows = sqlite.prepare('SELECT * FROM servers WHERE group_id = ?').all(id);
    res.json({ ...group, servers: serverRows });
  })
);

groupsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const input = CreateGroupSchema.partial().parse(req.body);
    const row = updateRow('groups', id, input);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  })
);

groupsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    deleteRow('groups', id);
    res.status(204).end();
  })
);
