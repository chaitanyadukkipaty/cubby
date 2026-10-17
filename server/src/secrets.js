// App secrets for jobs (`cubby env`). Values are encrypted at rest with a server key kept in DATA_DIR/secrets (part
// of the nightly sites backup), so they don't show in the PocketBase admin UI or a copy of pb_data. They are never
// shown again after being set and only ever reach the app's jobs.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { admin } from './pb.js';
import { config } from './config.js';
import { HttpError } from './http.js';

export const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const MAX_ENV_VALUE = 8 * 1024;
export const MAX_ENV_VARS = 50;

export const secretsDir = () => join(config.dataDir, 'secrets');

// Reads the 32-byte key, creating it on first use. `wx` never overwrites an existing key.
export function loadKey(dir = secretsDir()) {
  const file = join(dir, 'env.key');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  return Buffer.from(readFileSync(file, 'utf8'), 'base64');
}

let key;
const serverKey = () => (key ??= loadKey());

// AES-256-GCM. `aad` binds a value to its app and name, so a value copied to another row doesn't decrypt.
export function encrypt(k, plaintext, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv).setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((p) => (Buffer.isBuffer(p) ? p.toString('base64') : p)).join(':');
}

export function decrypt(k, blob, aad) {
  const [version, iv, tag, data] = String(blob).split(':');
  if (version !== 'v1' || data === undefined) throw new Error('unknown secret format');
  const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64')).setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

export function checkEnvVar(name, value) {
  if (!ENV_KEY_RE.test(name ?? '')) throw new HttpError(400, 'Secret names use capital letters, digits and underscores, e.g. RESEND_API_KEY (max 64)');
  if (typeof value !== 'string') throw new HttpError(400, 'Body must be { "value": "<string>" }');
  if (Buffer.byteLength(value) > MAX_ENV_VALUE) throw new HttpError(400, `A secret can be at most ${MAX_ENV_VALUE / 1024} KB`);
}

const aadFor = (project, name) => `${project.id}:${name}`;
const rows = (project) => admin.collection('cubby_app_env').getFullList({ filter: admin.filter('project = {:p}', { p: project.id }), sort: 'key' });

export async function listEnv(project) {
  return (await rows(project)).map((r) => ({ key: r.key, updated: r.updated }));
}

export async function setEnv(project, name, value) {
  checkEnvVar(name, value);
  const all = await rows(project);
  const existing = all.find((r) => r.key === name);
  if (!existing && all.length >= MAX_ENV_VARS) throw new HttpError(403, `An app can have at most ${MAX_ENV_VARS} secrets`);
  const data = { value: encrypt(serverKey(), value, aadFor(project, name)) };
  if (existing) await admin.collection('cubby_app_env').update(existing.id, data);
  else await admin.collection('cubby_app_env').create({ project: project.id, key: name, ...data });
  return { key: name, created: !existing };
}

export async function unsetEnv(project, name) {
  const existing = (await rows(project)).find((r) => r.key === name);
  if (!existing) throw new HttpError(404, `No secret called ${name}`);
  await admin.collection('cubby_app_env').delete(existing.id);
  return { key: name, removed: true };
}

// { NAME: value } for a job run.
export async function envFor(project) {
  const env = {};
  for (const r of await rows(project)) {
    try {
      env[r.key] = decrypt(serverKey(), r.value, aadFor(project, r.key));
    } catch {
      throw new Error(`Could not decrypt secret ${r.key}. Was DATA_DIR/secrets/env.key replaced? Set it again with \`cubby env set\`.`);
    }
  }
  return env;
}
