import { Router } from 'express';
import { sqlite, insertRow, updateRow } from '../db/client.js';
import { CreateServerSchema, UpdateServerSchema } from '@healthcheck/shared';
import { testConnection } from '../ssh/connectionManager.js';
import { bootstrapServerWithPassword } from '../ssh/passwordBootstrap.js';
import { ensureAppKeypair } from '../ssh/keyManager.js';
import { autoDiscoverGroupSoftware } from '../scan/autoDiscover.js';
import { getServerComponentStatus } from '../scan/status.js';
import { checkGroupNow } from '../heartbeat/scheduler.js';
import { createGroupForServer } from '../db/serverGroups.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const serversRouter = Router();

function omitSecrets<T extends { ssh_passphrase_enc?: unknown }>(row: T) {
  const { ssh_passphrase_enc, ...rest } = row;
  return rest;
}

function badRequest(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

// Chip colour for the overview cards.
function stateToStatus(state: string): 'up' | 'down' | 'partial' | 'unknown' {
  if (state === 'running') return 'up';
  if (state === 'starting' || state === 'stopping') return 'partial';
  if (state === 'unknown') return 'unknown';
  return 'down';
}

function describeServer(server: any) {
  const members = sqlite
    .prepare(
      `SELECT sd.id, sd.name FROM group_software gs
       JOIN software_definitions sd ON sd.id = gs.software_id
       WHERE gs.group_id = ? ORDER BY gs.sequence_order`
    )
    .all(server.group_id) as { id: number; name: string }[];
  const software = members.map((m) => {
    const st = getServerComponentStatus(server.id, server.name, m.id);
    return { software_id: m.id, name: m.name, state: st.state, status: stateToStatus(st.state) };
  });
  return {
    ...omitSecrets(server),
    software,
    summary: { total: software.length, running: software.filter((s) => s.state === 'running').length },
  };
}

// ---- servers: the things you manage ------------------------------------------------------------

serversRouter.get(
  '/servers',
  asyncHandler(async (_req, res) => {
    const rows = sqlite.prepare('SELECT * FROM servers ORDER BY name COLLATE NOCASE').all() as any[];
    res.json(rows.map(describeServer));
  })
);

serversRouter.get(
  '/servers/:id',
  asyncHandler(async (req, res) => {
    const server = sqlite.prepare('SELECT * FROM servers WHERE id = ?').get(Number(req.params.id)) as any;
    if (!server) return res.status(404).json({ error: 'Not found' });
    res.json(describeServer(server));
  })
);

serversRouter.post(
  '/servers',
  asyncHandler(async (req, res) => {
    const input = CreateServerSchema.parse(req.body);

    const clash = sqlite.prepare('SELECT id FROM servers WHERE lower(name) = lower(?)').get(input.name);
    if (clash) throw badRequest(`A server named "${input.name}" already exists.`);

    const bootstrap = await bootstrapServerWithPassword({
      host: input.host,
      port: input.port,
      username: input.ssh_username,
      password: input.password,
    });
    if (!bootstrap.ok) {
      return res.status(400).json({
        error: `Could not connect with that username/password: ${bootstrap.message ?? 'unknown error'}`,
      });
    }

    const { privateKeyPath } = ensureAppKeypair();
    // Only now that the connection is proven do we create anything, so a bad password leaves no trace.
    const groupId = createGroupForServer(input.name);
    const row = insertRow('servers', {
      group_id: groupId,
      name: input.name,
      host: input.host,
      port: input.port,
      ssh_username: input.ssh_username,
      ssh_key_path: privateKeyPath,
      connection_status: 'ok',
      last_connected_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });

    const { added } = await autoDiscoverGroupSoftware(groupId);
    checkGroupNow(groupId); // fill in its statuses now instead of at the next beat

    res.status(201).json({ ...omitSecrets(row as any), discovered: added });
  })
);

// Older/other callers that only know the internal group id.
serversRouter.get(
  '/groups/:groupId/servers',
  asyncHandler(async (req, res) => {
    const rows = sqlite.prepare('SELECT * FROM servers WHERE group_id = ?').all(Number(req.params.groupId)) as any[];
    res.json(rows.map(omitSecrets));
  })
);

serversRouter.patch(
  '/servers/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const input = UpdateServerSchema.parse(req.body);
    const row = updateRow('servers', id, input);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(omitSecrets(row as any));
  })
);

// Removes the server and everything that only existed for it (its software list, history, status).
// Nothing is changed on the machine itself - Healthcheck just stops managing it.
serversRouter.delete(
  '/servers/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const server = sqlite.prepare('SELECT * FROM servers WHERE id = ?').get(id) as any;
    if (!server) return res.status(204).end();
    const running = sqlite
      .prepare("SELECT COUNT(*) AS c FROM job_runs WHERE group_id = ? AND status = 'running'")
      .get(server.group_id) as { c: number };
    if (running.c > 0) throw badRequest('A job is still running on this server - wait for it to finish first.', 409);

    sqlite.prepare('DELETE FROM heartbeat_log WHERE server_id = ?').run(id);
    sqlite.prepare('DELETE FROM servers WHERE id = ?').run(id);
    const left = sqlite.prepare('SELECT COUNT(*) AS c FROM servers WHERE group_id = ?').get(server.group_id) as {
      c: number;
    };
    if (left.c === 0) {
      sqlite.prepare('DELETE FROM suggestion_dismissals WHERE group_id = ?').run(server.group_id);
      sqlite.prepare('DELETE FROM groups WHERE id = ?').run(server.group_id); // takes its software list with it
    }
    res.status(204).end();
  })
);

serversRouter.post(
  '/servers/:id/test-connection',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const server = sqlite.prepare('SELECT * FROM servers WHERE id = ?').get(id) as any;
    if (!server) return res.status(404).json({ error: 'Not found' });
    const result = await testConnection(server);
    const status = result.ok ? 'ok' : result.kind === 'auth_failed' ? 'auth_failed' : 'unreachable';
    updateRow('servers', id, {
      connection_status: status,
      last_connected_at: result.ok ? new Date().toISOString() : server.last_connected_at,
    });
    res.json(result);
  })
);
