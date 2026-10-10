// Platform accounts and tokens. Each user has exactly one token, shown on the dashboard.
import { createHash, randomBytes } from 'node:crypto';
import PocketBase from 'pocketbase';
import { admin } from './pb.js';
import { config } from './config.js';
import { HttpError } from './http.js';
import { getSettings } from './settings.js';
import { checkSignup } from './logic.js';

const hash = (key) => createHash('sha256').update(key).digest('hex');
const userView = (u) => ({ id: u.id, email: u.email, is_admin: Boolean(u.is_admin) });

async function currentKey(userId) {
  const list = await admin.collection('cubby_api_keys').getList(1, 1, { filter: admin.filter('owner = {:u}', { u: userId }), sort: '-created' });
  return list.items[0] ?? null;
}

async function issueKey(userId) {
  const key = `hk_${randomBytes(24).toString('base64url')}`;
  await admin.collection('cubby_api_keys').create({ owner: userId, label: 'default', key, key_hash: hash(key) });
  return key;
}

export async function tokenFor(userId) {
  return (await currentKey(userId))?.key ?? (await issueKey(userId));
}

export async function regenerateToken(userId) {
  const old = await admin.collection('cubby_api_keys').getFullList({ filter: admin.filter('owner = {:u}', { u: userId }) });
  for (const k of old) await admin.collection('cubby_api_keys').delete(k.id);
  return issueKey(userId);
}

export async function signup({ email, password, code }) {
  checkSignup({ email, password, code }, await getSettings());
  let user;
  try {
    user = await admin.collection('users').create({ email, password, passwordConfirm: password });
  } catch (err) {
    if (err?.response?.data?.email) throw new HttpError(409, 'An account with this email already exists');
    throw new HttpError(400, err?.response?.message || 'Could not create account');
  }
  return { user: userView(user), key: await tokenFor(user.id) };
}

export async function login({ email, password }) {
  const pb = new PocketBase(config.pb.url);
  let auth;
  try {
    auth = await pb.collection('users').authWithPassword(email, password);
  } catch {
    throw new HttpError(401, 'Invalid email or password');
  }
  if (auth.record.disabled) throw new HttpError(403, 'This account has been disabled by the admin');
  return { user: userView(auth.record), key: await tokenFor(auth.record.id) };
}

export async function authenticate(req) {
  const header = req.headers.authorization ?? '';
  const key = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!key.startsWith('hk_')) throw new HttpError(401, 'Missing token. Run `cubby login` or set CUBBY_TOKEN.');
  let record;
  try {
    record = await admin.collection('cubby_api_keys').getFirstListItem(admin.filter('key_hash = {:h}', { h: hash(key) }), { expand: 'owner' });
  } catch {
    throw new HttpError(401, 'Invalid token. Get your current token from the dashboard.');
  }
  const owner = record.expand?.owner;
  if (!owner || owner.disabled) throw new HttpError(403, 'This account has been disabled by the admin');
  admin.collection('cubby_api_keys').update(record.id, { last_used: new Date().toISOString() }).catch(() => {});
  return { ...userView(owner), key };
}
