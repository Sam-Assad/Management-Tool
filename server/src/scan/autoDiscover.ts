import { sqlite } from '../db/client.js';
import { getConnection } from '../ssh/connectionManager.js';
import { detectInstalled } from './detectors.js';
import { resequenceGroup } from '../orchestrator/ordering.js';
import type { SoftwareDefinition, Server as ServerRow } from '@healthcheck/shared';

export async function autoDiscoverGroupSoftware(groupId: number): Promise<{ added: string[] }> {
  const servers = sqlite.prepare('SELECT * FROM servers WHERE group_id = ?').all(groupId) as unknown as ServerRow[];
  if (servers.length === 0) return { added: [] };

  const allDefs = sqlite.prepare('SELECT * FROM software_definitions').all() as unknown as SoftwareDefinition[];
  const existingLinks = sqlite
    .prepare('SELECT software_id, sequence_order FROM group_software WHERE group_id = ?')
    .all(groupId) as { software_id: number; sequence_order: number }[];
  const existingIds = new Set(existingLinks.map((r) => r.software_id));

  const newlyPresent: SoftwareDefinition[] = [];
  for (const def of allDefs) {
    if (existingIds.has(def.id)) continue;

    let present = false;
    for (const server of servers) {
      try {
        const client = await getConnection(server as any);
        if (await detectInstalled(client, def)) {
          present = true;
          break;
        }
      } catch {
        // This server is unreachable right now - don't let it block discovery via the others.
      }
    }

    if (present) newlyPresent.push(def);
  }

  if (newlyPresent.length === 0) return { added: [] };

  // Append, then let the ordering conditions decide where everything belongs.
  const insert = sqlite.prepare('INSERT OR IGNORE INTO group_software (group_id, software_id, sequence_order) VALUES (?, ?, ?)');
  const base = existingLinks.length;
  newlyPresent.forEach((def, i) => insert.run(groupId, def.id, base + i));
  resequenceGroup(groupId);

  return { added: newlyPresent.map((d) => d.name) };
}
