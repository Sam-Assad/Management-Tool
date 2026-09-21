import { Router } from 'express';
import { sqlite, insertRow, updateRow, deleteRow } from '../db/client.js';
import { CreateSoftwareDefinitionSchema } from '@healthcheck/shared';
import { asyncHandler } from '../utils/asyncHandler.js';

export const softwareRouter = Router();

softwareRouter.get(
  '/software-definitions',
  asyncHandler(async (_req, res) => {
    const rows = sqlite.prepare('SELECT * FROM software_definitions').all();
    res.json(rows);
  })
);

softwareRouter.post(
  '/software-definitions',
  asyncHandler(async (req, res) => {
    const input = CreateSoftwareDefinitionSchema.parse(req.body);
    const row = insertRow('software_definitions', { ...input, created_at: new Date().toISOString() });
    res.status(201).json(row);
  })
);

softwareRouter.patch(
  '/software-definitions/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const input = CreateSoftwareDefinitionSchema.partial().parse(req.body);
    const row = updateRow('software_definitions', id, input);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  })
);

softwareRouter.delete(
  '/software-definitions/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    deleteRow('software_definitions', id);
    res.status(204).end();
  })
);
