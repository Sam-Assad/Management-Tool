import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqlite } from './client.js';
import { wouldCreateCycle } from '../orchestrator/ordering.js';

// The software catalog and the conditions that ship with Healthcheck live in ONE file in the repository
// (server/defaults/defaults.json). Every install loads it on start, so whoever pulls the repo gets the
// same catalog and conditions. It is produced from a working installation with `npm run defaults:export`.
//
// Loading is a merge, not an overwrite, so a customer's own changes survive an upgrade:
//  - an entry / condition that is not there yet is added;
//  - one that is there is left alone, except that a field the vendor has since changed in the file is
//    updated - but only if the customer never edited that field (it still holds what was shipped before);
//  - one the customer deleted stays deleted; ones the customer created themselves are never touched.
// "What was shipped before" is remembered in app_meta ('defaults_snapshot').

const here = path.dirname(fileURLToPath(import.meta.url));

export function defaultsFilePath(): string {
  return process.env.HEALTHCHECK_DEFAULTS_FILE
    ? path.resolve(process.env.HEALTHCHECK_DEFAULTS_FILE)
    : path.resolve(here, '../../defaults/defaults.json');
}

export const CATALOG_FIELDS = [
  'kind',
  'detect_method',
  'detect_value',
  'start_cmd',
  'stop_cmd',
  'restart_method',
  'start_script_path',
  'stop_script_path',
  'log_path',
  'success_pattern',
  'error_pattern',
  'health_timeout_s',
] as const;
type CatalogField = (typeof CATALOG_FIELDS)[number];
type CatalogValues = Record<CatalogField, string | number | null>;

export interface CatalogEntry extends CatalogValues {
  name: string;
}

export interface ConditionEntry {
  type: 'start_before' | 'stop_before';
  subject: string; // catalog entry name
  target: string;
  note: string | null;
  enabled: boolean;
}

export interface DefaultsFile {
  catalog: CatalogEntry[];
  conditions: ConditionEntry[];
}

interface Snapshot {
  catalog: Record<string, CatalogValues>;
  conditions: Record<string, { note: string | null; enabled: boolean }>;
}

export interface DefaultsResult {
  addedSoftware: string[];
  updatedSoftware: string[];
  addedConditions: string[];
  updatedConditions: string[];
  skipped: string[];
}

const conditionKey = (c: { type: string; subject: string; target: string }) => `${c.type}|${c.subject}|${c.target}`;

function pickValues(source: Record<string, unknown>): CatalogValues {
  const out = {} as CatalogValues;
  for (const f of CATALOG_FIELDS) out[f] = (source[f] ?? null) as string | number | null;
  return out;
}

export function readDefaults(file = defaultsFilePath()): DefaultsFile {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed?.catalog) || !Array.isArray(parsed?.conditions)) {
    throw new Error(`${file} must contain "catalog" and "conditions" lists`);
  }
  return parsed as DefaultsFile;
}

function readSnapshot(): Snapshot | null {
  const row = sqlite.prepare("SELECT value FROM app_meta WHERE key = 'defaults_snapshot'").get() as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as Snapshot;
  } catch {
    return null;
  }
}

// An earlier version saved the regex "\b" (word boundary) as a BACKSPACE character (a string-escaping slip),
// so the error pattern never matched log lines containing ERROR. A backspace can never be intended in a
// pattern: turn it back into backslash + b. Idempotent; runs on every start and before an export.
export function repairBrokenPatterns(): number {
  const backslashB = String.raw`\b`;
  const fix = (column: 'error_pattern' | 'success_pattern') =>
    Number(
      sqlite
        .prepare(`UPDATE software_definitions SET ${column} = replace(${column}, char(8), ?) WHERE instr(${column}, char(8)) > 0`)
        .run(backslashB).changes
    );
  return fix('error_pattern') + fix('success_pattern');
}

// `force` = "restore the shipped defaults": shipped values overwrite the entries they describe, and
// entries or conditions the customer deleted come back. Things the customer added themselves are kept.
export function applyBundledDefaults(options: { force?: boolean } = {}): DefaultsResult {
  const force = Boolean(options.force);
  repairBrokenPatterns();
  const file = readDefaults();
  const stored = readSnapshot();
  const firstRun = stored === null; // this database has never loaded defaults: its rows are the baseline
  const snap: Snapshot = stored ?? { catalog: {}, conditions: {} };
  const respectDeletes = !force && !firstRun;
  const next: Snapshot = { catalog: {}, conditions: {} };
  const result: DefaultsResult = { addedSoftware: [], updatedSoftware: [], addedConditions: [], updatedConditions: [], skipped: [] };

  const byName = sqlite.prepare('SELECT * FROM software_definitions WHERE name = ?');
  const idByName = sqlite.prepare('SELECT id FROM software_definitions WHERE name = ?');
  const findCondition = sqlite.prepare('SELECT * FROM conditions WHERE type = ? AND subject_id = ? AND target_id = ?');

  sqlite.exec('BEGIN');
  try {
    for (const entry of file.catalog) {
      const shipped = pickValues(entry as unknown as Record<string, unknown>);
      const row = byName.get(entry.name) as Record<string, unknown> | undefined;
      const before = snap.catalog[entry.name];
      if (!row) {
        if (!(respectDeletes && before)) {
          sqlite
            .prepare(
              `INSERT INTO software_definitions
                 (name, kind, detect_method, detect_value, start_cmd, stop_cmd, restart_method, start_script_path,
                  stop_script_path, log_path, success_pattern, error_pattern, health_timeout_s, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              entry.name,
              shipped.kind ?? 'jar',
              shipped.detect_method ?? 'systemd',
              shipped.detect_value ?? '',
              shipped.start_cmd ?? '',
              shipped.stop_cmd ?? '',
              shipped.restart_method ?? 'systemd',
              shipped.start_script_path,
              shipped.stop_script_path,
              shipped.log_path,
              shipped.success_pattern,
              shipped.error_pattern,
              shipped.health_timeout_s ?? 120,
              new Date().toISOString()
            );
          result.addedSoftware.push(entry.name);
        }
      } else {
        const changed = CATALOG_FIELDS.filter((f) => {
          if (row[f] === shipped[f]) return false;
          if (force) return true;
          // the vendor changed this field since the last load, and the customer never touched it
          return Boolean(before) && row[f] === before[f] && shipped[f] !== before[f];
        });
        if (changed.length > 0) {
          sqlite
            .prepare(`UPDATE software_definitions SET ${changed.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
            .run(...changed.map((f) => shipped[f]), row.id as number);
          result.updatedSoftware.push(`${entry.name} (${changed.join(', ')})`);
        }
      }
      next.catalog[entry.name] = shipped;
    }

    for (const c of file.conditions) {
      const subject = (idByName.get(c.subject) as { id: number } | undefined)?.id;
      const target = (idByName.get(c.target) as { id: number } | undefined)?.id;
      if (!subject || !target) continue; // one side is not in this catalog (the customer deleted it)
      const key = conditionKey(c);
      const enabled = c.enabled ? 1 : 0;
      const note = c.note ?? null;
      const row = findCondition.get(c.type, subject, target) as { id: number; enabled: number; note: string | null } | undefined;
      const before = snap.conditions[key];
      if (!row) {
        if (respectDeletes && before) {
          next.conditions[key] = { note, enabled: c.enabled };
          continue;
        }
        if (wouldCreateCycle(c.type, subject, target)) {
          result.skipped.push(`${c.subject} -> ${c.target} (${c.type}) would contradict a condition already defined here`);
          continue;
        }
        sqlite
          .prepare('INSERT INTO conditions (type, subject_id, target_id, note, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(c.type, subject, target, note, enabled, new Date().toISOString());
        result.addedConditions.push(`${c.type}: ${c.subject} -> ${c.target}`);
      } else {
        const changed: string[] = [];
        const apply = (field: 'enabled' | 'note', value: number | string | null, current: unknown, was: unknown) => {
          if (current === value) return;
          if (force || (before !== undefined && current === was && value !== was)) {
            sqlite.prepare(`UPDATE conditions SET ${field} = ? WHERE id = ?`).run(value, row.id);
            changed.push(field);
          }
        };
        apply('enabled', enabled, row.enabled, before ? (before.enabled ? 1 : 0) : undefined);
        apply('note', note, row.note, before?.note);
        if (changed.length > 0) result.updatedConditions.push(`${c.subject} -> ${c.target} (${changed.join(', ')})`);
      }
      next.conditions[key] = { note, enabled: c.enabled };
    }

    sqlite
      .prepare("INSERT INTO app_meta (key, value) VALUES ('defaults_snapshot', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(next));
    sqlite.exec('COMMIT');
  } catch (err) {
    sqlite.exec('ROLLBACK');
    throw err;
  }
  return result;
}

// The catalog and conditions of THIS installation, in the shape of the defaults file.
export function collectDefaults(): DefaultsFile {
  const rows = sqlite.prepare('SELECT * FROM software_definitions ORDER BY id').all() as Array<Record<string, unknown>>;
  const catalog = rows.map((r) => ({ name: r.name as string, ...pickValues(r) }));
  const conds = sqlite
    .prepare(
      `SELECT c.type, a.name AS subject, b.name AS target, c.note, c.enabled
         FROM conditions c
         JOIN software_definitions a ON a.id = c.subject_id
         JOIN software_definitions b ON b.id = c.target_id
        ORDER BY c.id`
    )
    .all() as Array<{ type: 'start_before' | 'stop_before'; subject: string; target: string; note: string | null; enabled: number }>;
  return {
    catalog,
    conditions: conds.map((c) => ({ type: c.type, subject: c.subject, target: c.target, note: c.note, enabled: Boolean(c.enabled) })),
  };
}
