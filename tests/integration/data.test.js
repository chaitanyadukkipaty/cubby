// Clearing an app's data (empty, drop, by filter or id) with a snapshot, and restoring it, against a real
// server and PocketBase.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PocketBase from 'pocketbase';
import { startServer, ADMIN, ROOT } from '../helpers/server.js';
import { api, signup, adminToken } from '../helpers/integration.js';

let srv, pb, ownerToken, owner, stranger, adminCall;

const SCHEMA = { collections: [
  { name: 'products', listRule: '', viewRule: '', fields: [{ name: 'title', type: 'text' }, { name: 'photo', type: 'file', maxSelect: 1 }] },
  { name: 'orders', fields: [{ name: 'product', type: 'relation', collection: 'products', cascadeDelete: true }, { name: 'qty', type: 'number' }] },
  { name: 'customers', type: 'auth', fields: [{ name: 'nick', type: 'text' }] },
] };

// Seeds the app's records as the superuser.
async function seed(slug) {
  try { await seedRecords(slug); } catch (err) { throw new Error(`seed ${slug}: ${JSON.stringify(err.response)}`); }
}
async function seedRecords(slug) {
  await pb.collection(`${slug}__products`).create({ id: 'prodmug00000001', title: 'Mug', photo: new File([new Uint8Array(1234)], 'mug.png') });
  await pb.collection(`${slug}__products`).create({ id: 'prodhat00000002', title: 'Hat' });
  await pb.collection(`${slug}__orders`).create({ id: 'order0000000001', product: 'prodmug00000001', qty: 2 });
  await pb.collection(`${slug}__customers`).create({ id: `cust${slug.replaceAll('_', '').padEnd(11, '0').slice(0, 11)}`, email: 'ann@shop.test', password: 'ann-pass-1234', passwordConfirm: 'ann-pass-1234', nick: 'ann' });
}
async function newApp(slug, call = owner) {
  assert.equal((await call('POST', '/api/projects', { body: { slug } })).status, 200);
  assert.equal((await call('PUT', `/api/projects/${slug}/schema`, { body: { ...SCHEMA, hash: 'h1' } })).status, 200);
  await seed(slug.replaceAll('-', '_'));
}

const cubby = (args, token = ownerToken) => new Promise((resolve) => {
  const home = mkdtempSync(join(tmpdir(), 'cubby-data-home-'));
  const child = spawn(process.execPath, [join(ROOT, 'cli/src/launcher.js'), ...args], {
    cwd: home, env: { ...process.env, HOME: home, CUBBY_TOKEN: token, CUBBY_SERVER: srv.url, CUBBY_CLIENT: '' },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.on('close', (code) => {
    rmSync(home, { recursive: true, force: true });
    resolve({ code, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch { return null; } })() });
  });
});

before(async () => {
  srv = await startServer();
  pb = new PocketBase(srv.pbUrl);
  pb.autoCancellation(false);
  await pb.collection('_superusers').authWithPassword(srv.env.PB_SUPERUSER_EMAIL, srv.env.PB_SUPERUSER_PASSWORD);
  ownerToken = await signup(srv.url, 'owner-data@test.dev');
  owner = api(srv.url, ownerToken);
  stranger = api(srv.url, await signup(srv.url, 'stranger-data@test.dev'));
  adminCall = api(srv.url, await adminToken(srv.url, ADMIN));
  await newApp('shop');
});
after(() => srv?.stop());

describe('listing data', () => {
  test('collections with record counts and uploaded bytes, for the owner (and admins) only', async () => {
    const r = await owner('GET', '/api/projects/shop/data');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.map((c) => [c.name, c.type, c.records]), [['customers', 'auth', 1], ['orders', 'base', 1], ['products', 'base', 2]]);
    assert.ok(r.data.find((c) => c.name === 'products').files_bytes >= 1234, 'the upload (and PocketBase\'s metadata next to it)');
    assert.equal((await stranger('GET', '/api/projects/shop/data')).status, 404);
    assert.equal((await adminCall('GET', '/api/projects/shop/data')).status, 200);
    const cli = await cubby(['data', 'list', 'shop']);
    assert.equal(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /products\s+base\s+2 records\s+files 1\.\d KB/);
  });
});

describe('emptying collections', () => {
  test('the CLI refuses without --yes and says what would go', async () => {
    const r = await cubby(['data', 'clear', 'shop', '--collections', 'products']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /empties products in shop[\s\S]*--yes/);
    assert.equal((await cubby(['data', 'clear', 'shop'])).code, 1);
    assert.equal((await pb.collection('shop__products').getList(1, 1)).totalItems, 2);
  });
  test('only the owner (or an admin) can clear', async () => {
    assert.equal((await stranger('POST', '/api/projects/shop/data/clear', { body: { collections: ['products'] } })).status, 404);
    assert.equal((await pb.collection('shop__products').getList(1, 1)).totalItems, 2);
  });
  test('empties a collection, keeping its fields and rules, with a snapshot of records and files; logs it', async () => {
    const schemaBefore = (await owner('GET', '/api/projects/shop/schema')).data;
    const r = await cubby(['data', 'clear', 'shop', '--collections', 'products', '--yes', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.collections.map((c) => [c.name, c.records]), [['products', 2]]);
    assert.deepEqual(r.json.cascade, [{ collection: 'orders', field: 'product', records: 1, deletes: true }]);
    assert.equal((await pb.collection('shop__products').getList(1, 1)).totalItems, 0);
    assert.equal((await pb.collection('shop__orders').getList(1, 1)).totalItems, 0, 'cascade');
    assert.deepEqual((await owner('GET', '/api/projects/shop/schema')).data, schemaBefore);

    const dir = join(srv.dataDir, 'snapshots', 'shop', r.json.snapshot.id);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    assert.deepEqual([meta.by.email, meta.mode, meta.files], ['owner-data@test.dev', 'empty', true]);
    assert.equal(readFileSync(join(dir, 'records', 'products.jsonl'), 'utf8').trim().split('\n').length, 2);
    assert.equal(readFileSync(join(dir, 'records', 'orders.jsonl'), 'utf8').trim().split('\n').length, 1);
    const [photoDir] = readdirSync(join(dir, 'files', 'products'));
    assert.equal(photoDir, 'prodmug00000001');

    const activity = (await owner('GET', '/api/activity?app=shop')).data;
    assert.equal(activity[0].action, 'data.clear');
    assert.match(activity[0].summary, /^Emptied products — 2 records · snapshot \S+ until \d{4}-\d{2}-\d{2}$/);
    const storage = (await adminCall('GET', '/api/admin/storage')).data;
    assert.ok(storage.breakdown.snapshots_bytes > 1234);
    assert.ok(storage.apps.find((a) => a.slug === 'shop').snapshots_bytes > 1234);
  });
  test('the app\'s users collection is cleared only when named, with a warning about passwords', async () => {
    const r = await owner('POST', '/api/projects/shop/data/clear', { body: { collections: ['customers'] } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.match(r.data.warnings.join('\n'), /new random passwords/);
    assert.equal((await pb.collection('shop__customers').getList(1, 1)).totalItems, 0);
  });
});

describe('dropping collections', () => {
  test('drops the collection and clears the schema hash, so the next deploy pushes schema.json again', async () => {
    await newApp('dropper');
    const r = await owner('POST', '/api/projects/dropper/data/clear', { body: { collections: ['orders'], drop: true } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(!(await owner('GET', '/api/projects/dropper/schema')).data.collections.some((c) => c.name === 'orders'));
    assert.equal((await owner('GET', '/api/projects/dropper')).data.schema_hash, null);
    const refused = await owner('POST', '/api/projects/dropper/data/clear', { body: { collections: ['nope'] } });
    assert.equal(refused.status, 404);
  });
});

describe('deleting by filter or ids', () => {
  before(() => newApp('picky'));
  test('a dry run reports matches N of M, samples and cascades, and deletes nothing', async () => {
    const r = await cubby(['data', 'clear', 'picky', '--collection', 'products', '--filter', 'title = "Mug"', '--dry-run', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.json.dry_run, r.json.matches, r.json.total, r.json.samples.map((x) => x.id)], [true, 1, 2, ['prodmug00000001']]);
    assert.deepEqual(r.json.cascade, [{ collection: 'orders', field: 'product', records: 1, deletes: true }]);
    const text = await cubby(['data', 'clear', 'picky', '--collection', 'products', '--filter', 'title = "Mug"']);
    assert.equal(text.code, 1, 'without --yes it only previews');
    assert.match(text.stderr, /deletes 1 records from products in picky[\s\S]*Re-run with --yes[\s\S]*prodmug00000001[\s\S]*cascade on orders\.product/);
    assert.equal((await pb.collection('picky__products').getList(1, 1)).totalItems, 2);
  });
  test('filters naming another app\'s or a platform collection are refused', async () => {
    for (const filter of ['@collection.shop__products.title != ""', '@collection.users.email != ""', 'cubby_projects_via_owner.slug != ""']) {
      const r = await owner('POST', '/api/projects/picky/data/clear', { body: { collection: 'products', filter } });
      assert.equal(r.status, 403, filter);
    }
    assert.equal((await owner('POST', '/api/projects/picky/data/clear', { body: { collection: 'products', filter: 'nope ===' } })).status, 400);
    assert.equal((await pb.collection('picky__products').getList(1, 1)).totalItems, 2);
  });
  test('a filter deletes only the matching records, snapshotting just those and their files', async () => {
    const r = await cubby(['data', 'clear', 'picky', '--collection', 'products', '--filter', 'title = "Mug"', '--yes', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.json.mode, r.json.matches], ['filter', 1]);
    assert.deepEqual((await pb.collection('picky__products').getFullList()).map((x) => x.id), ['prodhat00000002']);
    assert.equal((await pb.collection('picky__orders').getList(1, 1)).totalItems, 0, 'its order went by cascade');
    const dir = join(srv.dataDir, 'snapshots', 'picky', r.json.snapshot.id);
    assert.equal(readFileSync(join(dir, 'records', 'products.jsonl'), 'utf8').trim().split('\n').length, 1);
    assert.deepEqual(readdirSync(join(dir, 'files', 'products')), ['prodmug00000001']);
    const activity = (await owner('GET', '/api/activity?app=picky')).data;
    assert.match(activity[0].summary, /^Deleted 1 record from products matching title = "Mug"/);
  });
  test('ids delete exactly those records', async () => {
    const r = await owner('POST', '/api/projects/picky/data/clear', { body: { collection: 'products', ids: ['prodhat00000002', 'missing0000000x'] } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual([r.data.matches, r.data.missing], [1, ['missing0000000x']]);
    assert.equal((await pb.collection('picky__products').getList(1, 1)).totalItems, 0);
  });
});

describe('snapshot lifetime', () => {
  const task = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'server/src/admin-tasks.js'), ...args], { env: srv.env });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve({ code, stdout }));
  });
  test('the nightly maintenance deletes snapshots after 7 days', async () => {
    await newApp('aging');
    const r = await owner('POST', '/api/projects/aging/data/clear', { body: { collections: ['products', 'orders'] } });
    const metaFile = join(srv.dataDir, 'snapshots', 'aging', r.data.snapshot.id, 'meta.json');
    assert.equal(r.data.snapshot.expires.slice(0, 10), new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    writeFileSync(metaFile, JSON.stringify({ ...meta, expires: new Date(Date.now() - 1000).toISOString() }));
    const run = await task(['backup']);
    assert.equal(run.code, 0);
    assert.match(run.stdout, /pruned 1 data snapshots/);
    assert.ok(!existsSync(metaFile));
  });
  test('deleting the app deletes its snapshots', async () => {
    await newApp('goner');
    assert.equal((await owner('POST', '/api/projects/goner/data/clear', { body: { collections: ['customers'] } })).status, 200);
    assert.ok(existsSync(join(srv.dataDir, 'snapshots', 'goner')));
    assert.equal((await owner('DELETE', '/api/projects/goner')).status, 200);
    assert.ok(!existsSync(join(srv.dataDir, 'snapshots', 'goner')));
  });
});
