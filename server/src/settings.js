// Server-wide settings (signup code, limits) and first-boot admin account.
import { randomInt } from 'node:crypto';
import { admin } from './pb.js';
import { config } from './config.js';

const WORDS = ['otter', 'maple', 'cedar', 'comet', 'river', 'falcon', 'ember', 'harbor', 'lumen', 'pebble', 'quartz', 'sable', 'tundra', 'willow', 'zephyr', 'birch'];
export const newSignupCode = () => `${WORDS[randomInt(WORDS.length)]}-${WORDS[randomInt(WORDS.length)]}-${randomInt(10, 100)}`;

let cached;

export async function getSettings() {
  if (cached) return cached;
  const list = await admin.collection('cubby_settings').getList(1, 1, { sort: 'created' });
  cached = list.items[0];
  return cached;
}

export async function updateSettings(patch) {
  const current = await getSettings();
  cached = await admin.collection('cubby_settings').update(current.id, patch);
  return cached;
}

export async function bootstrap() {
  const list = await admin.collection('cubby_settings').getList(1, 1);
  if (!list.items.length) {
    await admin.collection('cubby_settings').create({
      signup_code: config.initial.signupCode || newSignupCode(),
      open_signup: false,
      max_apps_per_user: config.initial.maxAppsPerUser,
      max_deploy_mb: config.initial.maxDeployMb,
    });
  }

  // Admin is created once from env; later password changes made elsewhere are never overwritten.
  const { adminEmail, adminPassword } = config.initial;
  if (adminEmail && adminPassword) {
    const existing = await admin.collection('users').getFirstListItem(admin.filter('email = {:e}', { e: adminEmail })).catch(() => null);
    if (!existing) {
      await admin.collection('users').create({ email: adminEmail, password: adminPassword, passwordConfirm: adminPassword, is_admin: true, verified: true });
      console.log(`created admin account ${adminEmail}`);
    } else if (!existing.is_admin) {
      await admin.collection('users').update(existing.id, { is_admin: true });
    }
  }
  const s = await getSettings();
  console.log(`signup code: ${s.signup_code}${s.open_signup ? ' (open signup is on)' : ''}`);
}
