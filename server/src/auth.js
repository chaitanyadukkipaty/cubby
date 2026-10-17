// Platform accounts and tokens. Each user has one manual token (shown on the dashboard, used by the dashboard
// itself and by `cubby login --token`), plus one key per agent they approved with `cubby login` (an "agent").
import { createHash, randomBytes } from 'node:crypto';
import PocketBase from 'pocketbase';
import { admin } from './pb.js';
import { config } from './config.js';
import { HttpError } from './http.js';
import { getSettings } from './settings.js';
import { recordActivity } from './activity.js';
import { checkSignup, agentName, agentView, agentLabel, isAgentKey, touchThrottle } from './logic.js';

// Last-used times ("last seen" in `cubby agents`) are written at most once a minute per key.
const LAST_USED_EVERY_MS = 60_000;
const lastUsed = touchThrottle(LAST_USED_EVERY_MS);

const hash = (key) => createHash('sha256').update(key).digest('hex');
const userView = (u) => ({ id: u.id, email: u.email, is_admin: Boolean(u.is_admin) });

// The manual token: any key that isn't an agent's (keys from before agents have an empty kind).
async function manualKey(userId) {
  const list = await admin.collection('cubby_api_keys').getList(1, 1, { filter: admin.filter('owner = {:u} && kind != "agent"', { u: userId }), sort: '-created' });
  return list.items[0] ?? null;
}

// Returns the new key record (with the key itself).
async function issueKey(userId, fields = { label: 'default' }) {
  const key = `hk_${randomBytes(24).toString('base64url')}`;
  // `scopes` is reserved for limiting a key later; empty means full access.
  return admin.collection('cubby_api_keys').create({ owner: userId, ...fields, scopes: [], key, key_hash: hash(key) });
}

async function tokenFor(userId) {
  return (await manualKey(userId))?.key ?? (await issueKey(userId)).key;
}

// A new key for each approved device login, named after the client hint the CLI sent.
export async function issueAgentToken(userId, hint = {}) {
  const record = await issueKey(userId, { label: agentName(hint), kind: 'agent', tool: hint.tool || '', machine: hint.machine || '' });
  const agent = { id: record.id, name: record.label };
  await recordActivity({ id: userId, agent }, { action: 'agent.login', summary: `Connected agent "${agent.name}"` });
  return record.key;
}

export async function listAgents(user) {
  const keys = await admin.collection('cubby_api_keys').getFullList({ filter: admin.filter('owner = {:u}', { u: user.id }), sort: 'created' });
  return keys.map((k) => agentView(k, user.keyId));
}

// One of this user's agents by id. Anyone else's looks like it doesn't exist; the manual token isn't an agent.
async function ownedAgent(user, id) {
  let k;
  try {
    k = await admin.collection('cubby_api_keys').getFirstListItem(admin.filter('id = {:id} && owner = {:u}', { id: String(id), u: user.id }));
  } catch {
    throw new HttpError(404, `No agent ${String(id).slice(0, 40)} in your account. See \`cubby agents\`.`);
  }
  if (!isAgentKey(k)) throw new HttpError(400, 'That is your manual token, not an agent. Replace it with Regenerate on the dashboard.');
  return k;
}

export async function renameAgent(user, id, name) {
  const label = agentLabel(name);
  const k = await ownedAgent(user, id);
  const renamed = await admin.collection('cubby_api_keys').update(k.id, { label });
  await recordActivity(user, { action: 'agent.rename', summary: `Renamed agent "${k.label}" to "${label}"` });
  return agentView(renamed, user.keyId);
}

// Deleting the key is the revoke: authenticate looks every request up by hash, so it fails from the next request.
export async function revokeAgent(user, id) {
  const k = await ownedAgent(user, id);
  await admin.collection('cubby_api_keys').delete(k.id);
  lastUsed.forget(k.id);
  await recordActivity(user, { action: 'agent.revoke', summary: `Revoked agent "${k.label}"` });
  return { ok: true, id: k.id, current: k.id === user.keyId };
}

// Replaces the manual token. Agents keep their own keys; they're revoked one at a time (revokeAgent).
export async function regenerateToken(userId) {
  const old = await admin.collection('cubby_api_keys').getFullList({ filter: admin.filter('owner = {:u} && kind != "agent"', { u: userId }) });
  for (const k of old) {
    await admin.collection('cubby_api_keys').delete(k.id);
    lastUsed.forget(k.id);
  }
  const key = (await issueKey(userId)).key;
  await recordActivity({ id: userId }, { action: 'token.regenerate', summary: 'Replaced the manual token' });
  return key;
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
  // Awaited (once a minute at most) so a listing right after a request already shows it.
  if (lastUsed.due(record.id, Date.now())) {
    await admin.collection('cubby_api_keys').update(record.id, { last_used: new Date().toISOString() }).catch(() => {});
  }
  // `agent` attributes this request's actions in the activity log; null for the manual token (the dashboard).
  return { ...userView(owner), key, keyId: record.id, agent: isAgentKey(record) ? { id: record.id, name: record.label } : null };
}
