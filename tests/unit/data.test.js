import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakePocketBase } from '../helpers/fake-pocketbase.js';
import { applySchema } from '../../server/src/schema.js';
import { listData, clearData, formatBytes, checkDataFilter, oneAtATime } from '../../server/src/data.js';

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
    // The cleared collection, and the ones that lose records by cascade (so a restore can check them for drift).
    assert.deepEqual(schema.collections.map((c) => [c.name, c.fields.map((f) => f.name)]), [['products', ['title', 'photo', 'created', 'updated']], ['orders', ['product', 'qty', 'created', 'updated']]]);
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
    pb.collection = (name) => ({ ...real(name), getList: async (page, perPage, opts) => { if (opts?.skipTotal && !opts.fields) throw new Error('disk full'); return real(name).getList(page, perPage, opts); } });
    await assert.rejects(clearData('shop', { collections: ['products'] }, deps()), /disk full/);
    pb.collection = real;
    assert.equal(pb.records('shop__products').length, 2);
    assert.deepEqual(readdirSync(join(dataDir, 'snapshots', 'shop')), []);
  });
});

describe('wiping the database', () => {
  test('drops every collection of the app (users included) after one snapshot, and touches no other app', async () => {
    const r = await clearData('shop', { wipe: true }, deps());
    assert.deepEqual([r.mode, r.wipe, r.collections.map((c) => c.name).sort()], ['drop', true, ['customers', 'orders', 'products']]);
    assert.deepEqual([...pb.collections.cols.values()].map((c) => c.name), ['other__products']);
    assert.match(r.warnings.join('\n'), /customers holds user accounts/);
    const meta = JSON.parse(readFileSync(join(dataDir, 'snapshots', 'shop', r.snapshot.id, 'meta.json'), 'utf8'));
    assert.equal(meta.wipe, true);
  });
  test('wipe goes alone: not with collections, a filter or ids', async () => {
    await assert.rejects(clearData('shop', { wipe: true, collections: ['products'] }, deps()), (e) => e.status === 400);
    await assert.rejects(clearData('shop', { wipe: true, collection: 'products', ids: ['p1'] }, deps()), (e) => e.status === 400);
  });
  test('an app with no collections has nothing to wipe', async () => {
    await assert.rejects(clearData('empty-app', { wipe: true }, deps()), (e) => e.status === 400 && /no collections/.test(e.message));
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

describe('deleting by filter or ids', () => {
  test('a filter deletes only the matching records; the snapshot has only those, with their files', async () => {
    const r = await clearData('shop', { collection: 'products', filter: 'title = "Mug"' }, deps());
    assert.deepEqual([r.mode, r.matches, r.total], ['filter', 1, 2]);
    assert.deepEqual(pb.records('shop__products').map((x) => x.id), ['p2']);
    assert.deepEqual(pb.records('shop__orders'), [], 'its order went by cascade');
    assert.deepEqual(r.cascade, [{ collection: 'orders', field: 'product', records: 1, deletes: true }]);
    const dir = join(dataDir, 'snapshots', 'shop', r.snapshot.id);
    assert.deepEqual(lines(join(dir, 'records', 'products.jsonl')).map((x) => x.id), ['p1']);
    assert.deepEqual(lines(join(dir, 'records', 'orders.jsonl')).map((x) => x.id), ['o1']);
    assert.deepEqual(readdirSync(join(dir, 'files', 'products')), ['p1']);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    assert.deepEqual([meta.mode, meta.filter, meta.collections], ['filter', 'title = "Mug"', [{ name: 'products', type: 'base', records: 1, files_bytes: 100 }]]);
  });
  test('ids delete exactly those records; unknown ids are reported, not an error', async () => {
    const r = await clearData('shop', { collection: 'products', ids: ['p2', 'nope'] }, deps());
    assert.deepEqual([r.mode, r.matches, r.total, r.missing], ['ids', 1, 2, ['nope']]);
    assert.deepEqual(pb.records('shop__products').map((x) => x.id), ['p1']);
    assert.deepEqual(r.cascade, [{ collection: 'orders', field: 'product', records: 0, deletes: true }]);
    assert.equal(pb.records('shop__orders').length, 1);
  });
  test('a filter that matches nothing deletes nothing and leaves no snapshot', async () => {
    const r = await clearData('shop', { collection: 'products', filter: 'title = "Nothing"' }, deps());
    assert.deepEqual([r.matches, r.total, r.snapshot], [0, 2, null]);
    assert.ok(!existsSync(join(dataDir, 'snapshots')));
  });
  test('a dry run deletes nothing and says: matches N of M, 5 sample rows, what cascades', async () => {
    for (let i = 0; i < 8; i++) await pb.collection('shop__products').create({ title: `Cup ${i}` });
    const r = await clearData('shop', { collection: 'products', filter: 'title != "Hat"', dry_run: true }, deps());
    assert.deepEqual([r.dry_run, r.matches, r.total, r.samples.length], [true, 9, 10, 5]);
    assert.ok(r.samples.every((x) => x.title !== 'Hat'));
    assert.deepEqual(r.cascade, [{ collection: 'orders', field: 'product', records: 1, deletes: true }]);
    assert.equal(r.snapshot, undefined);
    assert.equal(pb.records('shop__products').length, 10);
    assert.ok(!existsSync(join(dataDir, 'snapshots')));
  });
  test('a dry run works for whole collections too', async () => {
    const r = await clearData('shop', { collections: ['products', 'customers'], dry_run: true }, deps());
    assert.deepEqual([r.mode, r.matches, r.total, r.samples.length], ['empty', 3, 3, 3]);
    assert.match(r.warnings.join('\n'), /random passwords/);
    assert.equal(pb.records('shop__products').length, 2);
  });
  test('more than 10,000 matches are refused unless all_matching is set', async () => {
    await assert.rejects(clearData('shop', { collection: 'products', filter: 'title != ""' }, deps({ maxMatches: 1 })), (e) => e.status === 409 && /matches 2 records, more than 1/.test(e.message) && /--all-matching/.test(e.message));
    assert.equal(pb.records('shop__products').length, 2);
    const r = await clearData('shop', { collection: 'products', filter: 'title != ""', all_matching: true }, deps({ maxMatches: 1 }));
    assert.equal(r.matches, 2);
  });
  test('a filter with a foreign @collection is refused before it runs', async () => {
    await assert.rejects(clearData('shop', { collection: 'products', filter: '@collection.other__products.title != ""' }, deps()), (e) => e.status === 403);
    assert.equal(pb.records('other__products').length, 1);
    assert.equal(pb.records('shop__products').length, 2);
  });
  test('a filter PocketBase can\'t read is a 400 with its message', async () => {
    await assert.rejects(clearData('shop', { collection: 'products', filter: 'title = ' }, deps()), (e) => e.status === 400 && /PocketBase rejected the filter/.test(e.message));
  });
  test('PocketBase being down while matching is passed on as it is', async () => {
    const real = pb.collection.bind(pb);
    pb.collection = (name) => ({ ...real(name), getList: async () => { throw Object.assign(new Error('down'), { status: 0 }); } });
    await assert.rejects(clearData('shop', { collection: 'products', filter: 'title = "x"' }, deps()), /down/);
  });
  test('one collection, with a filter or ids (not both), never with collections', async () => {
    for (const body of [
      { collection: 'products' }, { collection: 'products', filter: 'a = 1', ids: ['p1'] }, { collections: ['products'], filter: 'a = 1' },
      { collection: 'products', ids: [] }, { collection: 'products', ids: ['bad id!'] }, { collection: 'products', filter: 'a = 1', drop: true },
    ]) await assert.rejects(clearData('shop', body, deps()), (e) => e.status === 400, JSON.stringify(body));
    await assert.rejects(clearData('shop', { collection: 'other__products', ids: ['x1'] }, deps()), (e) => e.status === 404);
  });
});

describe('relations holding several ids', () => {
  beforeEach(async () => {
    await applySchema('shop', { collections: [
      { name: 'tags', fields: [{ name: 'n', type: 'text' }] },
      { name: 'posts', fields: [{ name: 't', type: 'text' }, { name: 'tags', type: 'relation', collection: 'tags', maxSelect: 5 }] },
      { name: 'bundles', fields: [{ name: 'items', type: 'relation', collection: 'posts', maxSelect: 10, cascadeDelete: true }] },
    ] }, pb.collections);
    await pb.collection('shop__tags').create({ id: 't1', n: 'x' });
    await pb.collection('shop__tags').create({ id: 't2', n: 'y' });
    await pb.collection('shop__posts').create({ id: 'pa', t: 'A', tags: ['t1', 't2'] });
    await pb.collection('shop__posts').create({ id: 'pb', t: 'B', tags: ['t1'] });
    await pb.collection('shop__bundles').create({ id: 'bu1', items: ['pa'] });
    await pb.collection('shop__bundles').create({ id: 'bu2', items: ['pa', 'pb'] });
  });
  const snapshotted = (r, name, part = 'records') => lines(join(dataDir, 'snapshots', 'shop', r.snapshot.id, part, `${name}.jsonl`)).map((x) => x.id);
  test('by id: a cascading one deletes records left with no ids, and the others lose one; both are snapshotted', async () => {
    const r = await clearData('shop', { collection: 'posts', ids: ['pa'] }, deps());
    assert.deepEqual(r.cascade, [{ collection: 'bundles', field: 'items', records: 1, deletes: true }, { collection: 'bundles', field: 'items', records: 1, deletes: false }]);
    assert.deepEqual(pb.records('shop__bundles').map((x) => [x.id, x.items]), [['bu2', ['pb']]], 'PocketBase deleted bu1 and unlinked bu2');
    assert.deepEqual(snapshotted(r, 'bundles'), ['bu1'], 'what was deleted');
    assert.deepEqual(snapshotted(r, 'bundles', 'links'), ['bu2'], 'what stayed but lost a link, as it was');
    assert.deepEqual(lines(join(dataDir, 'snapshots', 'shop', r.snapshot.id, 'links', 'bundles.jsonl'))[0].items, ['pa', 'pb']);
  });
  test('by filter: records that lose one of their ids by a relation that doesn\'t cascade are counted and snapshotted', async () => {
    const r = await clearData('shop', { collection: 'tags', filter: 'n = "x"' }, deps());
    assert.deepEqual(r.cascade, [{ collection: 'posts', field: 'tags', records: 2, deletes: false }]);
    assert.deepEqual(snapshotted(r, 'posts', 'links'), ['pa', 'pb']);
  });
});

describe('required relations that don\'t cascade', () => {
  beforeEach(async () => {
    await applySchema('shop', { collections: [
      { name: 'items', fields: [{ name: 'price', type: 'number' }] },
      { name: 'lines', fields: [{ name: 'item', type: 'relation', collection: 'items', required: true }] },
    ] }, pb.collections);
    await pb.collection('shop__items').create({ id: 'i1', price: 1 });
    await pb.collection('shop__items').create({ id: 'i2', price: 2 });
    await pb.collection('shop__lines').create({ id: 'l1', item: 'i2' });
  });
  const nothingChanged = () => {
    assert.deepEqual(pb.records('shop__items').map((x) => x.id), ['i1', 'i2']);
    assert.ok(!existsSync(join(dataDir, 'snapshots', 'shop')) || !readdirSync(join(dataDir, 'snapshots', 'shop')).length, 'no snapshot left');
  };
  test('the preview names the relation that blocks the clear', async () => {
    const r = await clearData('shop', { collection: 'items', filter: 'price > 0', dry_run: true }, deps());
    assert.deepEqual(r.blocked, ['lines.item must point at an items record and doesn\'t cascade: 1 record (l1) would point at nothing. Delete or relink it first, or clear lines too.']);
  });
  test('the clear is refused (409) before anything is snapshotted or deleted, in every mode', async () => {
    for (const body of [{ collection: 'items', filter: 'price > 0' }, { collection: 'items', ids: ['i1', 'i2'] }, { collections: ['items'] }]) {
      await assert.rejects(clearData('shop', body, deps()), (e) => e.status === 409 && /lines\.item must point at an items record/.test(e.details.join('\n')), JSON.stringify(body));
      nothingChanged();
    }
  });
  test('records the clear deletes anyway don\'t block it; they go in an order PocketBase accepts', async () => {
    const r = await clearData('shop', { collections: ['items', 'lines'] }, deps());
    assert.deepEqual([r.blocked, pb.records('shop__items'), pb.records('shop__lines')], [[], [], []]);
    await applySchema('shop', { collections: [{ name: 'folders', fields: [{ name: 'parent', type: 'relation', collection: 'folders', required: true }] }] }, pb.collections);
    // aroot (its own parent) can't go while bkid points at it: bkid goes first.
    await pb.collection('shop__folders').create({ id: 'aroot' });
    pb.records('shop__folders')[0].parent = 'aroot';
    await pb.collection('shop__folders').create({ id: 'bkid', parent: 'aroot' });
    const f = await clearData('shop', { collection: 'folders', ids: ['aroot', 'bkid'] }, deps());
    assert.deepEqual([f.matches, pb.records('shop__folders')], [2, []]);
  });
  test('a delete PocketBase refuses midway (a link made meanwhile) is a 409; what went is kept in the snapshot and reported', async () => {
    await pb.collection('shop__lines').delete('l1');
    const real = pb.collection.bind(pb);
    let deletes = 0;
    pb.collection = (name) => ({ ...real(name), delete: async (id) => {
      if (++deletes === 2) await real('shop__lines').create({ id: 'l2', item: id });
      return real(name).delete(id);
    } });
    const err = await clearData('shop', { collection: 'items', ids: ['i1', 'i2'] }, deps()).catch((e) => e);
    pb.collection = real;
    assert.equal(err.status, 409);
    assert.match(err.message, /PocketBase refused/);
    assert.deepEqual(pb.records('shop__items').map((x) => x.id), ['i2']);
    assert.deepEqual([err.cleared.mode, err.cleared.collections[0].records], ['ids', 2]);
    assert.ok(existsSync(join(dataDir, 'snapshots', 'shop', err.cleared.snapshot.id, 'meta.json')), 'the snapshot holds what went');
  });
  test('when nothing was deleted before PocketBase refused, no snapshot is left', async () => {
    pb.collection = ((real) => (name) => ({ ...real(name), delete: async () => { throw Object.assign(new Error('Failed to delete record.'), { status: 400, response: { message: 'Failed to delete record.' } }); } }))(pb.collection.bind(pb));
    await assert.rejects(clearData('shop', { collection: 'items', ids: ['i1'] }, deps()), (e) => e.status === 409 && !e.cleared);
    assert.deepEqual(readdirSync(join(dataDir, 'snapshots', 'shop')), []);
  });
});

describe('one data change at a time per app', () => {
  test('clears, restores and schema changes of one app wait for each other; other apps don\'t wait; a failure frees the turn', async () => {
    const log = [];
    const step = (name, ms, fail) => async () => {
      log.push(`${name} start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name} end`);
      if (fail) throw new Error(name);
      return name;
    };
    const runs = [oneAtATime('shop', step('a', 20, true)), oneAtATime('shop', step('b', 1)), oneAtATime('blog', step('c', 1))];
    const [a, b, c] = await Promise.allSettled(runs);
    assert.deepEqual([a.reason.message, b.value, c.value], ['a', 'b', 'c']);
    assert.deepEqual(log, ['a start', 'c start', 'c end', 'a end', 'b start', 'b end']);
  });
});

describe('filters run as superuser, so they may only reach this app', () => {
  const refused = (filter, re) => assert.throws(() => checkDataFilter(filter, 'shop__'), (e) => e.status === 403 && re.test(e.message), filter);
  test('a filter on this app\'s own fields and collections passes', () => {
    for (const f of ['title = "Mug"', 'qty > 1 && product.title ~ "M"', '@collection.shop__orders.product ?= id', 'shop__orders_via_product.qty > 1', 'title ~ "@collection"']) {
      assert.doesNotThrow(() => checkDataFilter(f, 'shop__'), f);
    }
  });
  test('@collection refs to another app or a platform collection are refused, however they are written', () => {
    refused('@collection.other__products.title = "x"', /"other__products"/);
    refused('id != "" && @collection.users.email != ""', /"users"/);
    refused('%40collection.cubby_api_keys.key != ""', /"cubby_api_keys"/);
    refused('title = "a" || @collection.shop_x__y.id != ""', /"shop_x__y"/);
  });
  test('back-relations from another app\'s collections are refused too', () => {
    refused('other__orders_via_product.qty > 0', /"other__orders"/);
    refused('cubby_projects_via_owner.slug != ""', /"cubby_projects"/);
  });
  test('a filter is a non-empty string of at most 2000 characters', () => {
    for (const bad of ['', '   ', 42, null, 'x'.repeat(2001)]) assert.throws(() => checkDataFilter(bad, 'shop__'), (e) => e.status === 400, String(bad));
  });
});
