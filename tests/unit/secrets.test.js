import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'cubby-secrets-'));
process.env.DATA_DIR = dataDir;
const secrets = await import('../../server/src/secrets.js');
const { admin } = await import('../../server/src/pb.js');

after(() => rmSync(dataDir, { recursive: true, force: true }));

describe('server key', () => {
  test('created once with owner-only permissions, then reused', () => {
    const dir = join(dataDir, 'k1');
    const key = secrets.loadKey(dir);
    assert.equal(key.length, 32);
    assert.equal(statSync(join(dir, 'env.key')).mode & 0o777, 0o600);
    assert.deepEqual(secrets.loadKey(dir), key);
    assert.equal(Buffer.from(readFileSync(join(dir, 'env.key'), 'utf8'), 'base64').length, 32);
  });
  test('other errors surface', { skip: process.getuid?.() === 0 && 'root ignores file permissions' }, () => {
    const dir = join(dataDir, 'locked');
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    try {
      assert.throws(() => secrets.loadKey(dir), /EACCES/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
  test('the default lives in DATA_DIR/secrets', () => assert.equal(secrets.secretsDir(), join(dataDir, 'secrets')));
});

describe('encrypt / decrypt', () => {
  const key = Buffer.alloc(32, 7);
  test('round trip, with a fresh IV every time', () => {
    const a = secrets.encrypt(key, 'sk_live_ünïcode', 'p1:API');
    assert.match(a, /^v1:[^:]+:[^:]+:[^:]+$/);
    assert.notEqual(a, secrets.encrypt(key, 'sk_live_ünïcode', 'p1:API'));
    assert.equal(secrets.decrypt(key, a, 'p1:API'), 'sk_live_ünïcode');
  });
  test('a value moved to another app or name, a wrong key or tampering fails', () => {
    const blob = secrets.encrypt(key, 'v', 'p1:API');
    assert.throws(() => secrets.decrypt(key, blob, 'p2:API'));
    assert.throws(() => secrets.decrypt(Buffer.alloc(32, 8), blob, 'p1:API'));
    assert.throws(() => secrets.decrypt(key, blob.slice(0, -4) + 'AAAA', 'p1:API'));
  });
  test('unknown formats are refused', () => {
    for (const bad of ['v2:a:b:c', 'v1:a:b', 'plain']) assert.throws(() => secrets.decrypt(key, bad, 'x'), /unknown secret format/, bad);
  });
});

describe('checkEnvVar', () => {
  test('names are SHOUTY_SNAKE_CASE up to 64 chars; values are strings up to 8 KB', () => {
    assert.doesNotThrow(() => secrets.checkEnvVar('RESEND_API_KEY', 'x'));
    assert.doesNotThrow(() => secrets.checkEnvVar('_X1', ''));
    for (const name of ['lower', '1ABC', 'A-B', '', undefined, 'A'.repeat(65)]) assert.throws(() => secrets.checkEnvVar(name, 'x'), /capital letters/, String(name));
    assert.throws(() => secrets.checkEnvVar('A', 5), /\{ "value": "<string>" \}/);
    assert.throws(() => secrets.checkEnvVar('A', 'x'.repeat(secrets.MAX_ENV_VALUE + 1)), /at most 8 KB/);
  });
});

describe('app secrets (PocketBase stubbed)', () => {
  const rows = [];
  let n = 0;
  const orig = admin.collection;
  before(() => {
    admin.collection = () => ({
      getFullList: async () => rows.map((r) => ({ ...r })),
      create: async (d) => { rows.push({ id: `e${++n}`, updated: 'now', ...d }); },
      update: async (id, d) => Object.assign(rows.find((r) => r.id === id), d),
      delete: async (id) => rows.splice(rows.findIndex((r) => r.id === id), 1),
    });
  });
  after(() => { admin.collection = orig; });
  const project = { id: 'p1' };

  test('set, overwrite, list names only, decrypt for jobs, unset', async () => {
    assert.deepEqual(await secrets.setEnv(project, 'API_KEY', 'one'), { key: 'API_KEY', created: true });
    assert.deepEqual(await secrets.setEnv(project, 'API_KEY', 'two'), { key: 'API_KEY', created: false });
    await secrets.setEnv(project, 'OTHER', 'x');
    assert.deepEqual(await secrets.listEnv(project), [{ key: 'API_KEY', updated: 'now' }, { key: 'OTHER', updated: 'now' }]);
    assert.ok(!rows.some((r) => r.value.includes('two')), 'stored encrypted');
    assert.deepEqual(await secrets.envFor(project), { API_KEY: 'two', OTHER: 'x' });
    assert.deepEqual(await secrets.unsetEnv(project, 'OTHER'), { key: 'OTHER', removed: true });
    await assert.rejects(secrets.unsetEnv(project, 'OTHER'), (err) => err.status === 404);
  });
  test('at most 50 per app, but existing ones can still change', async () => {
    rows.length = 0;
    for (let i = 0; i < secrets.MAX_ENV_VARS; i++) await secrets.setEnv(project, `K${i}`, 'v');
    await assert.rejects(secrets.setEnv(project, 'ONE_MORE', 'v'), (err) => err.status === 403);
    await secrets.setEnv(project, 'K0', 'changed');
  });
  test('a value that no longer decrypts names the secret and the fix', async () => {
    rows.length = 0;
    rows.push({ id: 'x', key: 'BROKEN', value: 'v1:AAAA:AAAA:AAAA' });
    await assert.rejects(secrets.envFor(project), /Could not decrypt secret BROKEN.*cubby env set/);
  });
});
