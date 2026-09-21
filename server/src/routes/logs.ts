import { Router } from 'express';
import { sqlite } from '../db/client.js';
import { getConnection } from '../ssh/connectionManager.js';
import { tailLines, streamTail } from '../ssh/tail.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const logsRouter = Router();

logsRouter.get(
  '/servers/:serverId/software/:softwareId/logs',
  asyncHandler(async (req, res) => {
    const serverId = Number(req.params.serverId);
    const softwareId = Number(req.params.softwareId);
    const lines = Math.min(2000, Math.max(1, Number(req.query.lines ?? 200)));
    const server = sqlite.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    const def = sqlite.prepare('SELECT * FROM software_definitions WHERE id = ?').get(softwareId) as any;
    if (!server || !def || !def.log_path) return res.status(404).json({ error: 'Log path not configured' });
    const client = await getConnection(server);
    const text = await tailLines(client, def.log_path, lines);
    res.type('text/plain').send(text);
  })
);

logsRouter.get(
  '/servers/:serverId/software/:softwareId/logs/stream',
  asyncHandler(async (req, res) => {
    const serverId = Number(req.params.serverId);
    const softwareId = Number(req.params.softwareId);
    const server = sqlite.prepare('SELECT * FROM servers WHERE id = ?').get(serverId) as any;
    const def = sqlite.prepare('SELECT * FROM software_definitions WHERE id = ?').get(softwareId) as any;
    if (!server || !def || !def.log_path) return res.status(404).json({ error: 'Log path not configured' });

    const client = await getConnection(server);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const stop = await streamTail(client, def.log_path, (line) => {
      res.write(`data: ${JSON.stringify({ line })}\n\n`);
    });
    req.on('close', () => stop());
  })
);
