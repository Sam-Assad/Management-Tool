import cron from 'node-cron';
import pLimit from 'p-limit';
import { sqlite } from '../db/client.js';
import { getConnection } from '../ssh/connectionManager.js';
import { probeComponentUnit } from '../scan/detectors.js';
import { isArtemis, checkArtemis, saveArtemisCheck, notRunningReport, type ArtemisCheck, type ArtemisSource } from '../scan/artemis.js';
import { env } from '../env.js';
import type { SoftwareDefinition, Server as ServerRow } from '@healthcheck/shared';

// Artemis's own beat: a few times a day (env.artemisCheckCron), on every server that has Artemis, read its
// DLQ, ExpiryQueue and memory and keep the reading. A reading at or over the memory threshold comes back as a
// danger and the page pops a warning (GET /api/alerts). It only reads - nothing is started or stopped.

const limit = pLimit(5);

// The servers that have an Artemis component, each with that component.
function artemisTargets(serverId?: number): { server: ServerRow; def: SoftwareDefinition }[] {
  const rows = sqlite
    .prepare(
      `SELECT s.id AS server_id, sd.id AS software_id FROM servers s
       JOIN group_software gs ON gs.group_id = s.group_id
       JOIN software_definitions sd ON sd.id = gs.software_id`
    )
    .all() as { server_id: number; software_id: number }[];
  const servers = new Map((sqlite.prepare('SELECT * FROM servers').all() as unknown as ServerRow[]).map((s) => [s.id, s]));
  const defs = new Map((sqlite.prepare('SELECT * FROM software_definitions').all() as unknown as SoftwareDefinition[]).map((d) => [d.id, d]));
  return rows
    .filter((r) => serverId === undefined || r.server_id === serverId)
    .map((r) => ({ server: servers.get(r.server_id)!, def: defs.get(r.software_id)! }))
    .filter((t) => t.server && t.def && isArtemis(t.def));
}

// Read one server's Artemis now and keep the reading.
export async function checkArtemisOn(server: ServerRow, def: SoftwareDefinition, source: ArtemisSource): Promise<ArtemisCheck> {
  try {
    const client = await getConnection(server as any);
    if (def.detect_method === 'systemd') {
      const unit = await probeComponentUnit(client, def);
      if (!unit.installed || unit.active !== 'active') return saveArtemisCheck(server.id, def.id, source, notRunningReport());
    }
    return saveArtemisCheck(server.id, def.id, source, await checkArtemis(client, def.log_path, def.detect_method === 'systemd' ? def.detect_value : undefined));
  } catch (err: any) {
    const report = notRunningReport();
    report.notes = [`Couldn't reach the server: ${String(err?.message ?? err).slice(0, 200)}`];
    return saveArtemisCheck(server.id, def.id, source, report);
  }
}

export async function runArtemisBeat(serverId?: number, source: ArtemisSource = 'beat'): Promise<ArtemisCheck[]> {
  const targets = artemisTargets(serverId);
  return Promise.all(targets.map((t) => limit(() => checkArtemisOn(t.server, t.def, source))));
}

// For Check now on one server's Artemis.
export async function checkArtemisNow(serverId: number): Promise<ArtemisCheck | null> {
  const [target] = artemisTargets(serverId);
  return target ? checkArtemisOn(target.server, target.def, 'manual') : null;
}

let running = false;

async function beat() {
  if (running) return;
  running = true;
  try {
    const results = await runArtemisBeat();
    const risky = results.filter((r) => r.report.tone === 'danger').length;
    if (results.length) console.log(`Artemis beat: ${results.length} server(s) checked${risky ? `, ${risky} using too much memory` : ''}`);
  } finally {
    running = false;
  }
}

export function startArtemisScheduler() {
  if (!cron.validate(env.artemisCheckCron)) {
    console.error(`ARTEMIS_CHECK_CRON "${env.artemisCheckCron}" isn't a valid schedule - Artemis's beat is off.`);
    return;
  }
  cron.schedule(env.artemisCheckCron, () => {
    beat().catch((err) => console.error('Artemis beat failed', err));
  });
  // After a restart of this app, catch up only if the last scheduled reading is old: a reload (dev mode
  // restarts on every save) must not re-read every broker each time.
  const last = sqlite.prepare("SELECT MAX(checked_at) AS at FROM artemis_checks WHERE source = 'beat'").get() as { at: string | null };
  const ageH = last.at ? (Date.now() - new Date(last.at).getTime()) / 3600_000 : Infinity;
  if (ageH > 8) setTimeout(() => beat().catch((err) => console.error('Initial Artemis beat failed', err)), 20_000);
}
