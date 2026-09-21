import { Router } from 'express';
import { sqlite } from '../db/client.js';
import { CreateConditionSchema, UpdateConditionSchema } from '@healthcheck/shared';
import { asyncHandler } from '../utils/asyncHandler.js';
import { resequenceAll, wouldCreateCycle } from '../orchestrator/ordering.js';

export const conditionsRouter = Router();

const SELECT_CONDITIONS = `
  SELECT c.id, c.type, c.subject_id, c.target_id, c.note, c.enabled, c.created_at,
         s.name AS subject_name, t.name AS target_name
  FROM conditions c
  JOIN software_definitions s ON s.id = c.subject_id
  JOIN software_definitions t ON t.id = c.target_id`;

function loadCondition(id: number) {
  return sqlite.prepare(`${SELECT_CONDITIONS} WHERE c.id = ?`).get(id) as any;
}

function badRequest(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

conditionsRouter.get(
  '/conditions',
  asyncHandler(async (_req, res) => {
    res.json(sqlite.prepare(`${SELECT_CONDITIONS} ORDER BY c.id`).all());
  })
);

conditionsRouter.post(
  '/conditions',
  asyncHandler(async (req, res) => {
    const input = CreateConditionSchema.parse(req.body);
    if (input.subject_id === input.target_id) throw badRequest('A component cannot be ordered against itself.');
    const exists = sqlite
      .prepare('SELECT id FROM conditions WHERE type = ? AND subject_id = ? AND target_id = ?')
      .get(input.type, input.subject_id, input.target_id);
    if (exists) throw badRequest('That condition already exists.');
    if (wouldCreateCycle(input.type, input.subject_id, input.target_id)) {
      throw badRequest(`That would create a loop with the other "${input.type === 'stop_before' ? 'stop' : 'start'} before" conditions (A before B before ... before A).`);
    }
    const row = sqlite
      .prepare(
        `INSERT INTO conditions (type, subject_id, target_id, note, enabled, created_at)
         VALUES (?, ?, ?, ?, 1, ?) RETURNING id`
      )
      .get(input.type, input.subject_id, input.target_id, input.note ?? null, new Date().toISOString()) as {
      id: number;
    };
    resequenceAll();
    res.status(201).json(loadCondition(row.id));
  })
);

conditionsRouter.patch(
  '/conditions/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const input = UpdateConditionSchema.parse(req.body);
    const current = loadCondition(id);
    if (!current) return res.status(404).json({ error: 'Not found' });
    if (input.enabled === true && !current.enabled && wouldCreateCycle(current.type, current.subject_id, current.target_id, id)) {
      throw badRequest('Enabling this would create a loop with other conditions.');
    }
    sqlite
      .prepare('UPDATE conditions SET enabled = ?, note = ? WHERE id = ?')
      .run(
        input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0,
        input.note === undefined ? current.note : input.note,
        id
      );
    resequenceAll();
    res.json(loadCondition(id));
  })
);

conditionsRouter.delete(
  '/conditions/:id',
  asyncHandler(async (req, res) => {
    sqlite.prepare('DELETE FROM conditions WHERE id = ?').run(Number(req.params.id));
    resequenceAll();
    res.status(204).end();
  })
);
