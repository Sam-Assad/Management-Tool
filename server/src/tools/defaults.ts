// Command-line helpers for the catalog and conditions that ship with Healthcheck:
//   npm run defaults:export   write this installation's catalog + conditions to server/defaults/defaults.json
//   npm run defaults:reset    put this installation back to the shipped defaults (keeps things you added)
import fs from 'node:fs';
import path from 'node:path';
import { dataDirPath } from '../db/client.js';
import { applyBundledDefaults, collectDefaults, defaultsFilePath, repairBrokenPatterns } from '../db/defaults.js';
import { resequenceAll } from '../orchestrator/ordering.js';

const command = process.argv[2];

if (command === 'export') {
  const repaired = repairBrokenPatterns();
  if (repaired > 0) console.log(`Repaired ${repaired} damaged pattern(s) in the database first.`);
  const file = defaultsFilePath();
  const data = collectDefaults();
  const text = JSON.stringify(data, null, 2) + '\n';
  const same = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text;
  if (!same) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  console.log(`Read the database in ${dataDirPath}`);
  console.log(`${same ? 'No changes -' : 'Wrote'} ${file}`);
  console.log(`  ${data.catalog.length} catalog entries, ${data.conditions.length} conditions`);
  if (!same) console.log('Now commit and push that file.');
} else if (command === 'reset') {
  const result = applyBundledDefaults({ force: true });
  resequenceAll();
  console.log(`Restored the shipped defaults in ${dataDirPath}`);
  console.log(`  catalog: ${result.addedSoftware.length} added, ${result.updatedSoftware.length} updated`);
  console.log(`  conditions: ${result.addedConditions.length} added, ${result.updatedConditions.length} updated`);
  for (const s of result.skipped) console.log(`  skipped: ${s}`);
  console.log('Restart the app to use them.');
} else {
  console.error('Usage: node dist/tools/defaults.js export | reset');
  process.exit(1);
}
