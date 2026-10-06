// An admin who forgot their password, with no other admin around to reset it. Run on the machine (or in the
// container) where Healthcheck runs - no email server needed:
//   npm run reset-password -- <username>
// Prints a one-time link (valid RESET_LINK_MINUTES) where that person chooses a new password. It also unlocks
// and enables the account, and makes it an admin if no other active admin exists. Anyone who can run this
// already controls the machine and its database, so it needs no password itself.
import { sqlite } from '../db/client.js';
import { env } from '../env.js';
import { activeAdminCount, audit, createResetToken, findUserByName, setPermissions } from '../auth/store.js';
import { ALL } from '../auth/permissions.js';

const username = process.argv[2];
if (!username) {
  const users = sqlite.prepare('SELECT username, is_admin, disabled FROM users ORDER BY username').all() as any[];
  console.log('Usage: npm run reset-password -- <username>\n');
  console.log(users.length ? `Users: ${users.map((u) => `${u.username}${u.is_admin ? ' (admin)' : ''}${u.disabled ? ' (disabled)' : ''}`).join(', ')}` : 'No users yet: open Healthcheck in a browser to create the first admin.');
  process.exit(1);
}
const user = findUserByName(username);
if (!user) {
  console.error(`No user called "${username}".`);
  process.exit(1);
}
const makeAdmin = !user.is_admin && activeAdminCount() === 0;
sqlite.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, disabled = 0 WHERE id = ?').run(user.id);
if (makeAdmin) setPermissions(user.id, ALL);
const link = `${env.publicUrl}/reset-password?token=${createResetToken(user.id, env.resetLinkMinutes)}`;
audit('reset_link_created', { username: user.username, actor: 'command line', detail: makeAdmin ? 'also made admin (no other active admin)' : null });

console.log(`\nOne-time password reset link for ${user.username}:\n\n  ${link}\n`);
console.log(`Open it in a browser to choose a new password. It works once, for ${env.resetLinkMinutes} minutes; running this again cancels it.`);
console.log(`If people open Healthcheck at another address, put that address in place of ${env.publicUrl} (or set PUBLIC_URL in .env).`);
if (makeAdmin) console.log('The account is now an admin, as no other active admin existed.');
process.exit(0);
