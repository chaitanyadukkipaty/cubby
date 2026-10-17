// Clearing an app's data (empty, drop, by filter or id) with a snapshot, and restoring it, against a real
// server and PocketBase.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PocketBase from 'pocketbase';
import { startServer, ADMIN, ROOT } from '../helpers/server.js';
import { api, signup, adminToken, app } from '../helpers/integration.js';

let srv, pb, ownerToken, owner, stranger, adminCall, adminTok;

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

const cubby = (args, token = ownerToken, cwd) => new Promise((resolve) => {
  const home = mkdtempSync(join(tmpdir(), 'cubby-data-home-'));
  const child = spawn(process.execPath, [join(ROOT, 'cli/src/launcher.js'), ...args], {
    cwd: cwd ?? home, env: { ...process.env, HOME: home, CUBBY_TOKEN: token, CUBBY_SERVER: srv.url, CUBBY_CLIENT: '' },
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
  srv = await startServer({ MAX_APPS_PER_USER: '30' });
  pb = new PocketBase(srv.pbUrl);
  pb.autoCancellation(false);
  await pb.collection('_superusers').authWithPassword(srv.env.PB_SUPERUSER_EMAIL, srv.env.PB_SUPERUSER_PASSWORD);
  ownerToken = await signup(srv.url, 'owner-data@test.dev');
  owner = api(srv.url, ownerToken);
  stranger = api(srv.url, await signup(srv.url, 'stranger-data@test.dev'));
  adminTok = await adminToken(srv.url, ADMIN);
  adminCall = api(srv.url, adminTok);
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

describe('restoring', () => {
  const clear = async (slug, body) => {
    const r = await owner('POST', `/api/projects/${slug}/data/clear`, { body });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.snapshot.id;
  };
  const restore = (id, body = {}, call = owner) => call('POST', `/api/snapshots/${id}/restore`, { body });
  const count = async (name) => (await pb.collection(name).getList(1, 1)).totalItems;

  test('clear then restore brings back records with their ids, cascaded ones and uploaded files; twice is harmless', async () => {
    await newApp('undo');
    const id = await clear('undo', { collections: ['products'] });
    const listed = await cubby(['data', 'snapshots', 'undo', '--json']);
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(listed.json.map((x) => [x.id, x.mode, x.records, x.by]), [[id, 'empty', 3, 'owner-data@test.dev']]);
    const r = await cubby(['data', 'restore', id, '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json.collections.map((c) => [c.name, c.restored]), [['products', 2], ['orders', 1]]);
    const mug = await pb.collection('undo__products').getOne('prodmug00000001');
    assert.match(mug.photo, /^mug_\w+\.png$/);
    const photo = await fetch(pb.files.getURL(mug, mug.photo));
    assert.equal((await photo.arrayBuffer()).byteLength, 1234);
    assert.equal((await pb.collection('undo__orders').getOne('order0000000001')).product, 'prodmug00000001');
    const again = await restore(id);
    assert.deepEqual(again.data.collections.map((c) => [c.restored, c.existing, c.failed]), [[0, 2, 0], [0, 1, 0]]);
    assert.equal(await count('undo__products'), 2);
    const activity = (await owner('GET', '/api/activity?app=undo')).data;
    assert.equal(activity[0].action, 'data.restore');
    assert.match(activity[0].summary, /^Restored 0 records from snapshot \S+ \(3 already there\)$/);
  });
  test('a dropped collection is recreated with its rules; a dry run changes nothing', async () => {
    await newApp('redo');
    const before = (await owner('GET', '/api/projects/redo/schema')).data.collections.find((c) => c.name === 'products');
    const id = await clear('redo', { collections: ['products', 'orders'], drop: true });
    const dry = await cubby(['data', 'restore', id, '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /^Dry run of snapshot \S+ \(nothing changed\):[\s\S]*Would recreate: products, orders/);
    assert.ok(!(await owner('GET', '/api/projects/redo/schema')).data.collections.some((c) => c.name === 'products'));
    assert.equal((await restore(id)).status, 200);
    const after = (await owner('GET', '/api/projects/redo/schema')).data.collections.find((c) => c.name === 'products');
    assert.deepEqual([after.listRule, after.viewRule, after.fields.map((f) => f.name)], [before.listRule, before.viewRule, before.fields.map((f) => f.name)]);
    assert.equal(await count('redo__products'), 2);
    assert.equal(await count('redo__orders'), 1);
    // The app reaches the recreated collection right away (the proxy's collection index is refreshed).
    assert.equal((await app(srv, 'redo')('GET', '/pb/api/collections/redo__products/records')).status, 200);
  });
  test('schema drift: removed fields are skipped, a field whose type changed refuses the restore', async () => {
    await newApp('drift');
    const id = await clear('drift', { collections: ['products'] });
    assert.equal((await owner('DELETE', '/api/projects/drift/schema/products.photo')).status, 200);
    const col = await pb.collections.getOne('drift__products');
    // PocketBase won't change a type in place either: the field is replaced by a new one of the same name.
    await pb.collections.update(col.id, { fields: col.fields.filter((f) => f.name !== 'title') });
    await pb.collections.update(col.id, { fields: [...(await pb.collections.getOne(col.id)).fields, { name: 'title', type: 'number' }] });
    const dry = await restore(id, { dry_run: true });
    assert.deepEqual([dry.data.skipped_fields, dry.data.refused_fields], [['products.photo'], ['products.title was text, is number now']]);
    const refused = await restore(id);
    assert.equal(refused.status, 409);
    assert.equal(await count('drift__products'), 0);
    const now = await pb.collections.getOne(col.id);
    await pb.collections.update(col.id, { fields: now.fields.filter((f) => f.name !== 'title') });
    await pb.collections.update(col.id, { fields: [...(await pb.collections.getOne(col.id)).fields, { name: 'title', type: 'text' }] });
    const ok = await restore(id);
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.deepEqual(ok.data.skipped_fields, ['products.photo']);
    assert.equal(await count('drift__products'), 2);
  });
  test('restored accounts get new random passwords that work (PocketBase never hands out password hashes)', async () => {
    await newApp('accounts');
    const id = await clear('accounts', { collections: ['customers'] });
    const r = await cubby(['data', 'restore', id]);
    assert.equal(r.code, 0, r.stderr);
    const m = /\n {2}customers {2}ann@shop\.test {2}(\S+)\n/.exec(r.stdout);
    assert.ok(m, r.stdout);
    const login = await app(srv, 'accounts')('POST', '/pb/api/collections/accounts__customers/auth-with-password', {
      headers: { 'content-type': 'application/json' }, body: { identity: 'ann@shop.test', password: m[1] },
    });
    assert.equal(login.status, 200, login.text);
    const old = await app(srv, 'accounts')('POST', '/pb/api/collections/accounts__customers/auth-with-password', {
      headers: { 'content-type': 'application/json' }, body: { identity: 'ann@shop.test', password: 'ann-pass-1234' },
    });
    assert.equal(old.status, 400, 'the old password is gone');
  });
  test('--overwrite needs --yes, replaces records and saves what it replaced', async () => {
    await newApp('over');
    const id = await clear('over', { collections: ['products'] });
    await pb.collection('over__products').create({ id: 'prodhat00000002', title: 'Hat v2' });
    assert.equal((await cubby(['data', 'restore', id, '--overwrite'])).code, 1);
    const r = await cubby(['data', 'restore', id, '--overwrite', '--yes', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal((await pb.collection('over__products').getOne('prodhat00000002')).title, 'Hat');
    assert.ok(r.json.backup.id);
    const snaps = (await owner('GET', '/api/snapshots?app=over')).data;
    assert.deepEqual(snaps.map((x) => x.mode), ['overwrite', 'empty']);
  });
  test('only the owner (or an admin) can restore or list an app\'s snapshots', async () => {
    await newApp('mine');
    const id = await clear('mine', { collections: ['orders'] });
    assert.equal((await restore(id, {}, stranger)).status, 404);
    assert.equal((await stranger('GET', '/api/snapshots?app=mine')).status, 404);
    assert.deepEqual((await stranger('GET', '/api/snapshots')).data, []);
    assert.equal((await restore('20260101T000000-000000')).status, 404);
    assert.equal((await restore('not-a-snapshot')).status, 400);
    assert.equal((await restore(id, {}, adminCall)).status, 200);
  });
});

describe('admin clears are never silent', () => {
  test('an admin needs a reason; the owner sees who did it and why, in their activity and on the app', async () => {
    await newApp('watched');
    const none = await cubby(['data', 'clear', 'watched', '--collections', 'orders', '--yes', '--json'], adminTok);
    assert.equal(none.code, 1);
    assert.match(none.json.error, /needs a reason/);
    assert.equal((await adminCall('POST', '/api/projects/watched/data/clear', { body: { collections: ['orders'], dry_run: true } })).status, 200, 'a dry run needs no reason');
    const r = await cubby(['data', 'clear', 'watched', '--collections', 'orders', '--reason', 'spam flood', '--yes', '--json'], adminTok);
    assert.equal(r.code, 0, r.stderr);
    const mine = (await owner('GET', '/api/activity?app=watched')).data[0];
    assert.equal(mine.action, 'admin.data.clear');
    assert.match(mine.summary, /^Admin \(admin@test\.dev\) emptied orders — 1 record · snapshot \S+ until \S+\. Reason: spam flood$/);
    const flag = (await owner('GET', '/api/projects/watched')).data.admin_clear;
    assert.deepEqual([flag.by, flag.reason, flag.snapshot], ['admin@test.dev', 'spam flood', r.json.snapshot.id]);
    assert.match((await cubby(['info'], ownerToken, (() => { const d = mkdtempSync(join(tmpdir(), 'cubby-info-')); writeFileSync(join(d, 'cubby.json'), JSON.stringify({ project: 'watched', server: srv.url })); return d; })())).stdout, /notice: {2}Admin \(admin@test\.dev\) emptied orders/);
    assert.equal((await stranger('DELETE', '/api/projects/watched/admin-clear')).status, 404);
    assert.equal((await owner('DELETE', '/api/projects/watched/admin-clear')).status, 200);
    assert.equal((await owner('GET', '/api/projects/watched')).data.admin_clear, null);
  });
  test('owners can restore an admin\'s snapshot but not purge it; admins can purge any', async () => {
    await newApp('policed');
    const made = await adminCall('POST', '/api/projects/policed/data/clear', { body: { collections: ['products'], reason: 'test data' } });
    assert.equal(made.status, 200, JSON.stringify(made.data));
    const id = made.data.snapshot.id;
    assert.deepEqual((await owner('GET', '/api/snapshots?app=policed')).data.map((x) => [x.by, x.by_admin, x.reason]), [['admin@test.dev', true, 'test data']]);
    const purge = await cubby(['data', 'purge', id, '--yes', '--json']);
    assert.equal(purge.code, 1);
    assert.match(purge.json.error, /made by an admin/);
    assert.equal((await owner('POST', `/api/snapshots/${id}/restore`, { body: {} })).status, 200);
    assert.equal((await pb.collection('policed__products').getList(1, 1)).totalItems, 2);
    assert.equal((await cubby(['data', 'purge', id])).code, 1, 'needs --yes');
    const done = await cubby(['data', 'purge', id, '--yes', '--json'], adminTok);
    assert.equal(done.code, 0, done.stderr);
    assert.deepEqual((await owner('GET', '/api/snapshots?app=policed')).data, []);
    const own = await owner('POST', '/api/projects/policed/data/clear', { body: { collections: ['orders'] } });
    assert.equal((await owner('DELETE', `/api/snapshots/${own.data.snapshot.id}`)).status, 200, 'their own they can purge');
  });
  test('wipe database drops every collection; the next `cubby deploy` pushes schema.json again', async () => {
    await newApp('wiped');
    const r = await cubby(['data', 'clear', 'wiped', '--wipe', '--reason', 'start over', '--yes', '--json'], adminTok);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.json.wipe, r.json.collections.length], [true, 3]);
    assert.deepEqual((await owner('GET', '/api/projects/wiped/schema')).data.collections, []);
    assert.equal((await owner('GET', '/api/projects/wiped')).data.schema_hash, null);

    const dir = mkdtempSync(join(tmpdir(), 'cubby-wiped-'));
    writeFileSync(join(dir, 'cubby.json'), JSON.stringify({ project: 'wiped', server: srv.url }));
    mkdirSync(join(dir, 'cubby'));
    writeFileSync(join(dir, 'cubby', 'schema.json'), JSON.stringify(SCHEMA));
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'index.html'), '<h1>again</h1>');
    const deploy = await cubby(['deploy', '--no-build'], ownerToken, dir);
    assert.equal(deploy.code, 0, deploy.stderr);
    assert.match(deploy.stdout, /Schema applied\. created: products, orders, customers/);
    assert.deepEqual((await owner('GET', '/api/projects/wiped/schema')).data.collections.map((c) => c.name).sort(), ['customers', 'orders', 'products']);
    rmSync(dir, { recursive: true, force: true });
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

// Each scenario builds a small app, dumps every record, clears, restores, and compares: nothing may be lost.
describe('whatever a clear deletes, a restore brings back (real PocketBase cascades)', () => {
  const make = async (slug, collections) => {
    assert.equal((await owner('POST', '/api/projects', { body: { slug } })).status, 200);
    const r = await owner('PUT', `/api/projects/${slug}/schema`, { body: { collections } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  };
  const C = (slug, name) => pb.collection(`${slug}__${name}`);
  // Records without what a restore can't keep: created/updated, and upload names (the bytes are compared instead).
  const dump = async (slug) => {
    const out = {};
    for (const col of (await pb.collections.getFullList()).filter((c) => c.name.startsWith(`${slug}__`)).sort((a, b) => a.name.localeCompare(b.name))) {
      const files = col.fields.filter((f) => f.type === 'file').map((f) => f.name);
      out[col.name.slice(slug.length + 2)] = await Promise.all((await pb.collection(col.name).getFullList({ sort: 'id' })).map(async ({ created, updated, ...r }) => {
        for (const f of files) r[f] = await Promise.all([].concat(r[f]).filter(Boolean).map(async (name) => (await (await fetch(pb.files.getURL(r, name))).arrayBuffer()).byteLength));
        return r;
      }));
    }
    return out;
  };
  const clearAndRestore = async (slug, body) => {
    const before = await dump(slug);
    const cleared = await owner('POST', `/api/projects/${slug}/data/clear`, { body });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
    assert.notDeepEqual(await dump(slug), before, 'the clear deleted something');
    const restored = await owner('POST', `/api/snapshots/${cleared.data.snapshot.id}/restore`, { body: {} });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.deepEqual(restored.data.failures, []);
    assert.deepEqual(await dump(slug), before, 'everything the clear took is back');
    return { cleared: cleared.data, restored: restored.data };
  };

  test('a thread on a cascading self-relation', async () => {
    await make('thread', [{ name: 'comments', fields: [{ name: 'body', type: 'text' }, { name: 'parent', type: 'relation', collection: 'comments', cascadeDelete: true }] }]);
    await C('thread', 'comments').create({ id: 'top000000000001', body: 'top' });
    await C('thread', 'comments').create({ id: 'rep000000000001', body: 'r1', parent: 'top000000000001' });
    await C('thread', 'comments').create({ id: 'rep000000000002', body: 'r2', parent: 'rep000000000001' });
    await C('thread', 'comments').create({ id: 'other0000000001', body: 'other' });
    const dry = await owner('POST', '/api/projects/thread/data/clear', { body: { collection: 'comments', ids: ['top000000000001'], dry_run: true } });
    assert.deepEqual(dry.data.cascade, [{ collection: 'comments', field: 'parent', records: 2, deletes: true }]);
    await clearAndRestore('thread', { collection: 'comments', ids: ['top000000000001'] });
  });
  test('a chain a <- b <- c, cleared by id and emptied whole', async () => {
    await make('chain', [
      { name: 'a', fields: [{ name: 't', type: 'text' }] },
      { name: 'b', fields: [{ name: 'a', type: 'relation', collection: 'a', cascadeDelete: true }] },
      { name: 'c', fields: [{ name: 'b', type: 'relation', collection: 'b', cascadeDelete: true }] },
    ]);
    await C('chain', 'a').create({ id: 'aaaaaaaaaaaaaa1', t: 'x' });
    await C('chain', 'a').create({ id: 'aaaaaaaaaaaaaa2', t: 'y' });
    await C('chain', 'b').create({ id: 'bbbbbbbbbbbbbb1', a: 'aaaaaaaaaaaaaa1' });
    for (const id of ['ccccccccccccc01', 'ccccccccccccc02']) await C('chain', 'c').create({ id, b: 'bbbbbbbbbbbbbb1' });
    const both = [{ collection: 'b', field: 'a', records: 1, deletes: true }, { collection: 'c', field: 'b', records: 2, deletes: true }];
    assert.deepEqual((await clearAndRestore('chain', { collection: 'a', ids: ['aaaaaaaaaaaaaa1'] })).cleared.cascade, both);
    assert.deepEqual((await clearAndRestore('chain', { collections: ['a'] })).cleared.cascade, both);
  });
  test('uploads of records deleted by cascade are snapshotted and come back', async () => {
    await make('attach', [
      { name: 'posts', fields: [{ name: 't', type: 'text' }] },
      { name: 'attachments', fields: [{ name: 'post', type: 'relation', collection: 'posts', cascadeDelete: true }, { name: 'file', type: 'file', maxSelect: 1, maxSize: 10_000_000 }] },
    ]);
    await C('attach', 'posts').create({ id: 'post00000000001', t: 'p' });
    await C('attach', 'attachments').create({ id: 'att000000000001', post: 'post00000000001', file: new File([new Uint8Array(5000).fill(7)], 'doc.bin') });
    const dry = await owner('POST', '/api/projects/attach/data/clear', { body: { collection: 'posts', ids: ['post00000000001'], dry_run: true } });
    assert.ok(dry.data.files_bytes >= 5000, `the cascaded upload counts toward the cap: ${dry.data.files_bytes}`);
    const { cleared } = await clearAndRestore('attach', { collection: 'posts', ids: ['post00000000001'] });
    assert.ok(existsSync(join(srv.dataDir, 'snapshots', 'attach', cleared.snapshot.id, 'files', 'attachments', 'att000000000001')));
  });
  test('relations holding several ids: matched by `field.id ?=`, so counts and snapshots see them', async () => {
    await make('multi', [
      { name: 'tags', fields: [{ name: 'n', type: 'text' }] },
      { name: 'posts', fields: [{ name: 't', type: 'text' }, { name: 'tags', type: 'relation', collection: 'tags', maxSelect: 5 }] },
      { name: 'bundles', fields: [{ name: 'items', type: 'relation', collection: 'posts', maxSelect: 10, cascadeDelete: true }] },
    ]);
    await C('multi', 'tags').create({ id: 'tag000000000001', n: 'x' });
    await C('multi', 'tags').create({ id: 'tag000000000002', n: 'y' });
    await C('multi', 'posts').create({ id: 'posta0000000001', t: 'A', tags: ['tag000000000001', 'tag000000000002'] });
    await C('multi', 'posts').create({ id: 'postb0000000001', t: 'B', tags: ['tag000000000001'] });
    await C('multi', 'bundles').create({ id: 'bund00000000001', items: ['posta0000000001'] });
    await C('multi', 'bundles').create({ id: 'bund00000000002', items: ['posta0000000001', 'postb0000000001'] });
    const dry = await owner('POST', '/api/projects/multi/data/clear', { body: { collection: 'posts', ids: ['posta0000000001'], dry_run: true } });
    assert.deepEqual(dry.data.cascade, [{ collection: 'bundles', field: 'items', records: 1, deletes: true }, { collection: 'bundles', field: 'items', records: 1, deletes: false }]);
    const tag = await owner('POST', '/api/projects/multi/data/clear', { body: { collection: 'tags', filter: 'n = "x"', dry_run: true } });
    assert.deepEqual(tag.data.cascade, [{ collection: 'posts', field: 'tags', records: 2, deletes: false }]);
    // Deleted bundles come back, and the ids PocketBase took out of the others go back in place.
    await clearAndRestore('multi', { collection: 'posts', ids: ['posta0000000001'] });
    await clearAndRestore('multi', { collection: 'tags', ids: ['tag000000000001'] });
    await clearAndRestore('multi', { collections: ['tags'] });
  });
  test('a required relation that doesn\'t cascade: previewed as blocking, refused (409) with nothing deleted or kept', async () => {
    await make('required', [
      { name: 'products', fields: [{ name: 'price', type: 'number' }] },
      { name: 'orders', fields: [{ name: 'product', type: 'relation', collection: 'products', required: true }] },
    ]);
    await C('required', 'products').create({ id: '0000000000000aa', price: 1 });
    await C('required', 'products').create({ id: 'prod00000000002', price: 2 });
    await C('required', 'orders').create({ id: 'ordr00000000001', product: 'prod00000000002' });
    const before = await dump('required');
    const dry = await owner('POST', '/api/projects/required/data/clear', { body: { collection: 'products', ids: ['prod00000000002'], dry_run: true } });
    assert.match(dry.data.blocked.join('\n'), /^orders\.product must point at a products record and doesn't cascade: 1 record \(ordr00000000001\)/);
    for (const body of [{ collection: 'products', ids: ['prod00000000002'] }, { collection: 'products', filter: 'price > 0' }, { collections: ['products'] }]) {
      const r = await owner('POST', '/api/projects/required/data/clear', { body });
      assert.equal(r.status, 409, JSON.stringify(r.data));
      assert.match(r.data.details.join('\n'), /orders\.product/);
    }
    const cli = await cubby(['data', 'clear', 'required', '--collection', 'products', '--ids', 'prod00000000002', '--dry-run']);
    assert.match(cli.stdout, /\nblocked: orders\.product must point at a products record/);
    assert.deepEqual(await dump('required'), before, 'nothing deleted');
    assert.ok(!existsSync(join(srv.dataDir, 'snapshots', 'required')) || !readdirSync(join(srv.dataDir, 'snapshots', 'required')).length, 'no snapshot left');
    assert.ok(!(await owner('GET', '/api/activity?app=required')).data.some((a) => a.action === 'data.clear'));
  });
  test('a link the clear removed from a record that stays comes back; edits made since stay', async () => {
    await make('relink', [
      { name: 'people', fields: [{ name: 'n', type: 'text' }] },
      { name: 'notes', fields: [{ name: 't', type: 'text' }, { name: 'author', type: 'relation', collection: 'people' }] },
    ]);
    await C('relink', 'people').create({ id: 'pers00000000001', n: 'ann' });
    await C('relink', 'notes').create({ id: 'note00000000001', t: 'hi', author: 'pers00000000001' });
    const { restored } = await clearAndRestore('relink', { collection: 'people', ids: ['pers00000000001'] });
    assert.deepEqual(restored.links, [{ name: 'notes', records: 1, relinked: 1 }]);
    const cleared = await owner('POST', '/api/projects/relink/data/clear', { body: { collections: ['people'] } });
    await C('relink', 'notes').update('note00000000001', { t: 'edited' });
    assert.equal((await owner('POST', `/api/snapshots/${cleared.data.snapshot.id}/restore`, { body: {} })).status, 200);
    const note = await C('relink', 'notes').getOne('note00000000001');
    assert.deepEqual([note.t, note.author], ['edited', 'pers00000000001']);
  });
});
