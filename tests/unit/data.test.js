import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakePocketBase } from '../helpers/fake-pocketbase.js';
import { applySchema } from '../../server/src/schema.js';
import { listData, clearData, formatBytes } from '../../server/src/data.js';

let dataDir, pb;
const T = Date.parse('2026-10-17T10:15:00Z');
const OWNER = { id: 'u1', email: 'owner@x.dev', admin: false };
const deps = (extra) => ({ pb, dataDir, project: { id: 'proj1', slug: 'shop' }, actor: OWNER, now: () => T, ...extra });
const lines = (path) => readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const file = (name, bytes = 10) => new File([new Uint8Array(bytes)], name);

// An app "shop" with products (with uploads), orders pointing at products (cascading), customers (auth) and a
// neighbour app "other" that must never be touched.
async function seed() {
  await applySchema('shop', { collections: [
    { name: 'products', fields: [{ name: 'title', type: 'text' }, { name: 'photo', type: 'file', maxSelect: 1 }] },
    { name: 'orders', fields: [{ name: 'product', type: 'relation', collection: 'products', cascadeDelete: true }, { name: 'qty', type: 'number' }] },
    { name: 'customers', type: 'auth', fields: [{ name: 'nick', type: 'text' }] },
  ] }, pb.collections);
  await applySchema('other', { collections: [{ name: 'products', fields: [{ name: 'title', type: 'text' }] }] }, pb.collections);
  await pb.collection('shop__products').create({ id: 'p1', title: 'Mug', photo: file('mug.png', 100) });
  await pb.collection('shop__products').create({ id: 'p2', title: 'Hat' });
  await pb.collection('shop__orders').create({ id: 'o1', product: 'p1', qty: 2 });
  await pb.collection('shop__customers').create({ id: 'c1', email: 'ann@x.dev', password: 'secret-pass-1', nick: 'ann' });
  await pb.collection('other__products').create({ id: 'x1', title: 'Not yours' });
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'cubby-data-'));
  pb = fakePocketBase({ dataDir });
  await seed();
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe('listing an app\'s data', () => {
  test('each collection of the app with its type, record count and uploaded bytes; never another app\'s', async () => {
    const list = await listData('shop', { pb, dataDir });
    assert.deepEqual(list, [
      { name: 'customers', type: 'auth', records: 1, files_bytes: 0 },
      { name: 'orders', type: 'base', records: 1, files_bytes: 0 },
      { name: 'products', type: 'base', records: 2, files_bytes: 100 },
    ]);
  });
});

describe('emptying collections', () => {
  test('deletes every record but keeps the collection, its fields and rules; the snapshot has schema, records and files', async () => {
    const before = await pb.collections.getOne('shop__products');
    const r = await clearData('shop', { collections: ['products'] }, deps());
    assert.equal(r.mode, 'empty');
    assert.deepEqual(r.collections, [{ name: 'products', type: 'base', records: 2, files_bytes: 100 }]);
    assert.deepEqual(pb.records('shop__products'), []);
    assert.deepEqual(await pb.collections.getOne('shop__products'), before, 'schema and rules unchanged');
    assert.equal(pb.records('other__products').length, 1, 'another app is never touched');

    const dir = join(dataDir, 'snapshots', 'shop', r.snapshot.id);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    assert.deepEqual([meta.app, meta.project, meta.mode, meta.by, meta.files, meta.files_bytes], ['shop', 'proj1', 'empty', OWNER, true, 100]);
    assert.equal(meta.created, '2026-10-17T10:15:00.000Z');
    assert.equal(meta.expires, '2026-10-24T10:15:00.000Z');
    assert.equal(r.snapshot.expires, meta.expires);
    const schema = JSON.parse(readFileSync(join(dir, 'schema.json'), 'utf8'));
    assert.deepEqual(schema.collections.map((c) => [c.name, c.fields.map((f) => f.name)]), [['products', ['title', 'photo', 'created', 'updated']]]);
    assert.deepEqual(lines(join(dir, 'records', 'products.jsonl')).map((x) => [x.id, x.title]), [['p1', 'Mug'], ['p2', 'Hat']]);
    const photo = lines(join(dir, 'records', 'products.jsonl'))[0].photo;
    assert.equal(readFileSync(join(dir, 'files', 'products', 'p1', photo)).length, 100);
  });
  test('records other collections lose by cascade are snapshotted too, and reported', async () => {
    const r = await clearData('shop', { collections: ['products'] }, deps());
    assert.deepEqual(pb.records('shop__orders'), [], 'PocketBase cascaded the delete');
    assert.deepEqual(r.cascade, [{ collection: 'orders', field: 'product', records: 1, deletes: true }]);
    const dir = join(dataDir, 'snapshots', 'shop', r.snapshot.id);
    assert.deepEqual(lines(join(dir, 'records', 'orders.jsonl')).map((x) => x.id), ['o1']);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).cascade, r.cascade);
  });
  test('a collection cleared together with the ones pointing at it is no cascade', async () => {
    const r = await clearData('shop', { collections: ['products', 'orders'] }, deps());
    assert.deepEqual(r.cascade, []);
    assert.deepEqual(r.collections.map((c) => [c.name, c.records]), [['products', 2], ['orders', 1]]);
  });
  test('uploads over the cap are not snapshotted, and the result warns that they cannot be restored', async () => {
    const r = await clearData('shop', { collections: ['products'] }, deps({ filesCap: 50 }));
    assert.equal(r.snapshot.files, false);
    assert.match(r.warnings.join('\n'), /uploaded files \(100 B\) are over the 50 B snapshot cap: they are deleted and can't be restored/);
    assert.ok(!existsSync(join(dataDir, 'snapshots', 'shop', r.snapshot.id, 'files')));
  });
  test('an auth collection can be cleared when named, with a warning about passwords', async () => {
    const r = await clearData('shop', { collections: ['customers'] }, deps());
    assert.deepEqual(pb.records('shop__customers'), []);
    assert.match(r.warnings.join('\n'), /customers holds user accounts: PocketBase never hands out password hashes, so restored accounts get new random passwords/);
  });
  test('unknown collections, another app\'s and an empty list are refused before anything is deleted', async () => {
    await assert.rejects(clearData('shop', { collections: ['products', 'nope'] }, deps()), (e) => e.status === 404 && /"nope" not found/.test(e.message));
    await assert.rejects(clearData('shop', { collections: ['other__products'] }, deps()), (e) => e.status === 404);
    await assert.rejects(clearData('shop', { collections: [] }, deps()), (e) => e.status === 400 && /Name the collections/.test(e.message));
    await assert.rejects(clearData('shop', {}, deps()), (e) => e.status === 400);
    assert.equal(pb.records('shop__products').length, 2);
    assert.ok(!existsSync(join(dataDir, 'snapshots')));
  });
  test('if the snapshot can\'t be written, nothing is deleted and no half snapshot is left', async () => {
    const real = pb.collection.bind(pb);
    pb.collection = (name) => ({ ...real(name), getList: async (page, perPage, opts) => { if (opts?.skipTotal) throw new Error('disk full'); return real(name).getList(page, perPage, opts); } });
    await assert.rejects(clearData('shop', { collections: ['products'] }, deps()), /disk full/);
    pb.collection = real;
    assert.equal(pb.records('shop__products').length, 2);
    assert.deepEqual(readdirSync(join(dataDir, 'snapshots', 'shop')), []);
  });
});

describe('big collections', () => {
  test('records are read and snapshotted a page (500) at a time, all of them', async () => {
    for (let i = 0; i < 520; i++) await pb.collection('shop__orders').create({ product: 'p2', qty: i });
    const r = await clearData('shop', { collections: ['orders'] }, deps());
    assert.equal(r.collections[0].records, 521);
    assert.equal(lines(join(dataDir, 'snapshots', 'shop', r.snapshot.id, 'records', 'orders.jsonl')).length, 521);
  });
  test('sizes read like the CLI\'s', () => {
    assert.deepEqual([formatBytes(0), formatBytes(1536), formatBytes(100 * 1024 * 1024)], ['0 B', '1.5 KB', '100.0 MB']);
  });
});

describe('dropping collections', () => {
  test('removes the collections themselves, after snapshotting their schema and records', async () => {
    const r = await clearData('shop', { collections: ['orders'], drop: true }, deps());
    assert.equal(r.mode, 'drop');
    assert.equal(pb.collections.byName('shop__orders'), undefined);
    assert.ok(pb.collections.byName('shop__products'));
    const schema = JSON.parse(readFileSync(join(dataDir, 'snapshots', 'shop', r.snapshot.id, 'schema.json'), 'utf8'));
    assert.deepEqual(schema.collections.map((c) => c.name), ['orders']);
  });
  test('a collection others point at can\'t be dropped alone: nothing is snapshotted or deleted', async () => {
    await assert.rejects(clearData('shop', { collections: ['products'], drop: true }, deps()), (e) => e.status === 409 && /orders\.product points at products/.test(e.message));
    assert.ok(pb.collections.byName('shop__products'));
    assert.ok(!existsSync(join(dataDir, 'snapshots')));
    const r = await clearData('shop', { collections: ['products', 'orders'], drop: true }, deps());
    assert.deepEqual([pb.collections.byName('shop__products'), pb.collections.byName('shop__orders')], [undefined, undefined]);
    assert.equal(r.collections.length, 2);
  });
});
