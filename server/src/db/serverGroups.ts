import { sqlite, insertRow } from './client.js';

// The app is organised around SERVERS. Internally every server still owns exactly one "group" (a
// group of one): that's where its software list, start/stop order, jobs and status live, so all of
// that machinery keeps working unchanged. These groups are an implementation detail - the UI never
// shows them.

function uniqueGroupName(base: string): string {
  const exists = sqlite.prepare('SELECT 1 FROM groups WHERE name = ?');
  let name = base;
  for (let n = 2; exists.get(name); n++) name = `${base} (${n})`;
  return name;
}

export function createGroupForServer(serverName: string): number {
  const row = insertRow<{ id: number }>('groups', {
    name: uniqueGroupName(serverName),
    description: null,
    created_at: new Date().toISOString(),
  });
  return row.id;
}

// Guarantees "one server = one group". A group that ended up with several servers (from when groups
// were a thing you managed) is split: its first server keeps the group, every other server gets its own
// group with a copy of the same software list. Safe to run on every boot; a no-op once normalised.
export function normalizeServerGroups() {
  const groups = sqlite.prepare('SELECT id, name FROM groups').all() as { id: number; name: string }[];
  const serversOf = sqlite.prepare('SELECT id, name FROM servers WHERE group_id = ? ORDER BY id');
  const members = sqlite.prepare('SELECT software_id, sequence_order FROM group_software WHERE group_id = ?');
  const addMember = sqlite.prepare(
    'INSERT OR IGNORE INTO group_software (group_id, software_id, sequence_order) VALUES (?, ?, ?)'
  );
  const moveServer = sqlite.prepare('UPDATE servers SET group_id = ? WHERE id = ?');

  for (const group of groups) {
    const servers = serversOf.all(group.id) as { id: number; name: string }[];
    if (servers.length <= 1) continue;
    const software = members.all(group.id) as { software_id: number; sequence_order: number }[];
    for (const server of servers.slice(1)) {
      const newGroupId = createGroupForServer(server.name);
      for (const m of software) addMember.run(newGroupId, m.software_id, m.sequence_order);
      moveServer.run(newGroupId, server.id);
      console.log(`Split group "${group.name}": server "${server.name}" now has its own software list.`);
    }
  }
}
