import { sqlite } from '../db/client.js';

interface SoftwareNode {
  id: number;
  name: string;
  kind: string;
}

interface Edge {
  subject_id: number;
  target_id: number;
}

// Built-in preference: services before jars. It is only a tie-breaker, so an explicit
// condition ("jar X before service Y") always wins over it.
function tier(kind: string): number {
  return kind === 'service' ? 0 : 1;
}

// 'start_before' constrains the start order; 'stop_before' constrains the stop order. The two are
// separate graphs: a start rule never conflicts with a stop rule.
function enabledEdges(type: 'start_before' | 'stop_before'): Edge[] {
  return sqlite
    .prepare('SELECT subject_id, target_id FROM conditions WHERE enabled = 1 AND type = ?')
    .all(type) as unknown as Edge[];
}

// Would adding subject -> target (subject goes first) close a loop among conditions of the same type?
export function wouldCreateCycle(type: string, subjectId: number, targetId: number, ignoreConditionId?: number): boolean {
  if (subjectId === targetId) return true;
  const rows = sqlite
    .prepare('SELECT id, subject_id, target_id FROM conditions WHERE enabled = 1 AND type = ?')
    .all(type) as unknown as (Edge & { id: number })[];
  const next = new Map<number, number[]>();
  for (const r of rows) {
    if (r.id === ignoreConditionId) continue;
    next.set(r.subject_id, [...(next.get(r.subject_id) ?? []), r.target_id]);
  }
  // a loop exists if targetId can already reach subjectId
  const seen = new Set<number>();
  const stack = [targetId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === subjectId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(next.get(cur) ?? []));
  }
  return false;
}

// Start order for a set of software: dependency order from the conditions, and among
// items that nothing constrains, services before jars, then by name (stable and obvious).
export function computeOrder(
  nodes: SoftwareNode[],
  edges: Edge[],
  rank: (a: SoftwareNode, b: SoftwareNode) => number = (a, b) => tier(a.kind) - tier(b.kind) || a.name.localeCompare(b.name)
): number[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map<number, number>();
  const outgoing = new Map<number, number[]>();
  for (const n of nodes) incoming.set(n.id, 0);
  for (const e of edges) {
    if (!byId.has(e.subject_id) || !byId.has(e.target_id)) continue;
    incoming.set(e.target_id, (incoming.get(e.target_id) ?? 0) + 1);
    outgoing.set(e.subject_id, [...(outgoing.get(e.subject_id) ?? []), e.target_id]);
  }
  const order: number[] = [];
  const ready = nodes.filter((n) => incoming.get(n.id) === 0).sort(rank);
  const done = new Set<number>();
  while (ready.length > 0) {
    const cur = ready.shift()!;
    order.push(cur.id);
    done.add(cur.id);
    for (const t of outgoing.get(cur.id) ?? []) {
      const left = (incoming.get(t) ?? 0) - 1;
      incoming.set(t, left);
      if (left === 0) ready.push(byId.get(t)!);
    }
    ready.sort(rank);
  }
  // Only reachable if conditions contradict each other (creation blocks that) - never drop items.
  for (const n of [...nodes].sort(rank)) if (!done.has(n.id)) order.push(n.id);
  return order;
}

export function resequenceGroup(groupId: number) {
  const nodes = sqlite
    .prepare(
      `SELECT sd.id, sd.name, sd.kind FROM group_software gs
       JOIN software_definitions sd ON sd.id = gs.software_id
       WHERE gs.group_id = ?`
    )
    .all(groupId) as unknown as SoftwareNode[];
  const order = computeOrder(nodes, enabledEdges('start_before'));
  const update = sqlite.prepare('UPDATE group_software SET sequence_order = ? WHERE group_id = ? AND software_id = ?');
  order.forEach((softwareId, index) => update.run(index, groupId, softwareId));
}

function reaches(edges: Edge[], from: number, to: number): boolean {
  const next = new Map<number, number[]>();
  for (const e of edges) next.set(e.subject_id, [...(next.get(e.subject_id) ?? []), e.target_id]);
  const seen = new Set<number>();
  const stack = [from];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(next.get(cur) ?? []));
  }
  return false;
}

// "X must stop before Y" relationships: the explicit 'stop_before' conditions, plus the implied
// reverse of every 'start_before' one (if A must start before B, then B must stop before A). An
// implied one that would contradict an explicit stop rule (or another implied one) is left out, so
// explicit stop rules always win.
export function stopEdges(): Edge[] {
  const edges = [...enabledEdges('stop_before')];
  for (const e of enabledEdges('start_before')) {
    const implied = { subject_id: e.target_id, target_id: e.subject_id };
    if (!reaches(edges, implied.target_id, implied.subject_id)) edges.push(implied);
  }
  return edges;
}

function dependentsOf(edges: Edge[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const e of edges) map.set(e.subject_id, [...(map.get(e.subject_id) ?? []), e.target_id]);
  return map;
}

// If component X fails to start, these must not be started after it (they need X first).
export function startDependents(): Map<number, number[]> {
  return dependentsOf(enabledEdges('start_before'));
}

// If component X fails to stop, these must not be stopped after it (they must stop later than X).
export function stopDependents(): Map<number, number[]> {
  return dependentsOf(stopEdges());
}

// Components that must already be running before this one may start.
export function startPredecessors(softwareId: number): number[] {
  return enabledEdges('start_before')
    .filter((e) => e.target_id === softwareId)
    .map((e) => e.subject_id);
}

// Components that must already be stopped before this one may stop (they are still running "on top of" it).
export function stopPredecessors(softwareId: number): number[] {
  return stopEdges()
    .filter((e) => e.target_id === softwareId)
    .map((e) => e.subject_id);
}

// Stop order for a group: the reverse of its start order, adjusted by any 'stop_before' conditions
// ("A must stop before B" - honoured wherever both are in the group, and it wins over the reversal).
export function stopOrderIds(groupId: number): number[] {
  const nodes = sqlite
    .prepare(
      `SELECT sd.id, sd.name, sd.kind, gs.sequence_order FROM group_software gs
       JOIN software_definitions sd ON sd.id = gs.software_id
       WHERE gs.group_id = ?`
    )
    .all(groupId) as unknown as (SoftwareNode & { sequence_order: number })[];
  const startPos = new Map(nodes.map((n) => [n.id, n.sequence_order]));
  return computeOrder(nodes, stopEdges(), (a, b) => (startPos.get(b.id) ?? 0) - (startPos.get(a.id) ?? 0));
}

export function resequenceAll() {
  const groups = sqlite.prepare('SELECT id FROM groups').all() as { id: number }[];
  for (const g of groups) resequenceGroup(g.id);
}

// The ordering rules that were previously hard-wired into default_rank, given once as
// editable conditions. Only ever seeded once, so deleting one stays deleted.
export function seedDefaultConditions() {
  const done = sqlite.prepare("SELECT value FROM app_meta WHERE key = 'conditions_seeded'").get();
  if (done) return;
  const idOf = sqlite.prepare('SELECT id FROM software_definitions WHERE name = ?');
  const insert = sqlite.prepare(
    `INSERT OR IGNORE INTO conditions (type, subject_id, target_id, note, enabled, created_at)
     VALUES ('start_before', ?, ?, ?, 1, ?)`
  );
  const defaults: [string, string, string][] = [
    ['Keycloak', 'WSO2 API Manager', 'Default rule'],
    ['Artemis', 'WildFly (JBoss)', 'Default rule'],
    ['conversion-rules-selector', 'earning-rules-selector', 'Default rule'],
    ['earning-rules-selector', 'rules-interpreter', 'Default rule'],
  ];
  for (const [a, b, note] of defaults) {
    const subject = idOf.get(a) as { id: number } | undefined;
    const target = idOf.get(b) as { id: number } | undefined;
    if (subject && target) insert.run(subject.id, target.id, note, new Date().toISOString());
  }
  sqlite.prepare("INSERT INTO app_meta (key, value) VALUES ('conditions_seeded', '1')").run();
}
