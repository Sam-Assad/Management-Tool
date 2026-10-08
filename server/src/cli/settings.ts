// The settings file (.env in the Healthcheck folder), written again: every setting in order with what it does and
// its default, the values already in it kept. Healthcheck does this by itself at start when the file is missing or
// lacks a setting; this is for when Healthcheck may not write there (on Ubuntu the file belongs to root), or to
// tidy the file after editing it by hand:
//   npm run settings          (Ubuntu: cd /opt/healthcheck && sudo node server/dist/cli/settings.js)
import fs from 'node:fs';
import dotenv from 'dotenv';
import { SETTINGS, settingsFile, settingsStatus, settingsText } from '../env.js';

let current: Record<string, string> = {};
try {
  current = dotenv.parse(fs.readFileSync(settingsFile, 'utf8'));
} catch {
  // not there yet
}
const known = new Set(SETTINGS.flatMap((s) => s.settings.map((x) => x.key)));
try {
  fs.writeFileSync(settingsFile, settingsText(current, Object.fromEntries(Object.entries(current).filter(([k]) => !known.has(k)))), { mode: 0o600 });
} catch (err: any) {
  console.error(`Could not write ${settingsFile}: ${err?.message ?? err}`);
  process.exit(1);
}
console.log(`Settings file: ${settingsFile}`);
if (settingsStatus.created) console.log('Created, with every setting at its default.');
else if (settingsStatus.added.length) console.log(`Added at their defaults: ${settingsStatus.added.join(', ')}`);
else console.log('Written again in order; your values are kept.');
if (!current.ARTEMIS_PASSWORD) console.log('ARTEMIS_PASSWORD is empty: fill it in for the Artemis report.');
console.log('Restart Healthcheck for changes to take effect.');
process.exit(0);
