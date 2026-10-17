// Maintenance tasks run inside the container by `cubby-server` (docker exec), against the live PocketBase.
//   node server/src/admin-tasks.js backup | code | reset-password <email> <new-password>
import { connectAdmin, admin } from './pb.js';
import { runMaintenance } from './backups.js';
import { getSettings } from './settings.js';

const [task, ...args] = process.argv.slice(2);
await connectAdmin();

if (task === 'backup') {
  // The nightly maintenance, now: prunes old activity, then backs up.
  await runMaintenance();
} else if (task === 'code') {
  const s = await getSettings();
  console.log(s.signup_code + (s.open_signup ? '  (open signup is on — no code needed)' : ''));
} else if (task === 'reset-password') {
  const [email, password] = args;
  if (!email || !password || password.length < 8) throw new Error('usage: reset-password <email> <new-password (8+ chars)>');
  const user = await admin.collection('users').getFirstListItem(admin.filter('email = {:e}', { e: email }));
  await admin.collection('users').update(user.id, { password, passwordConfirm: password });
  console.log(`password updated for ${email}`);
} else {
  console.error('usage: admin-tasks.js backup | code | reset-password <email> <password>');
  process.exit(1);
}
process.exit(0);
