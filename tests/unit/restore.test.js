import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakePocketBase } from '../helpers/fake-pocketbase.js';
import { applySchema, readSchema } from '../../server/src/schema.js';
import { clearData } from '../../server/src/data.js';
import { restoreSnapshot } from '../../server/src/restore.js';
import { findSnapshot } from '../../server/src/snapshots.js';

let dataDir, pb;
const T = Date.parse('2026-10-17T10:15:00Z');
const OWNER = { id: 'u1', email: 'owner@x.dev', admin: false };
const PROJECT = { id: 'proj1', slug: 'shop' };
const deps = (extra) => ({ pb, dataDir, project: PROJECT, actor: OWNER, now: () => T, ...extra });
const file = (name, bytes = 10) => new File([new Uint8Array(bytes).fill(7)], name);
const ids = (name) => pb.records(name).map((r) => r.id).sort();

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'cubby-restore-'));
  pb = fakePocketBase({ dataDir });
  await applySchema('shop', { collections: [
    { name: 'products', listRule: '', fields: [{ name: 'title', type: 'text' }, { name: 'tags', type: 'json' }, { name: 'photo', type: 'file', maxSelect: 1 }] },
    { name: 'orders', fields: [{ name: 'product', type: 'relation', collection: 'products', cascadeDelete: true }, { name: 'qty', type: 'number' }] },
    { name: 'customers', type: 'auth', fields: [{ name: 'nick', type: 'text' }] },
  ] }, pb.collections);
  await pb.collection('shop__products').create({ id: 'p1', title: 'Mug', tags: ['a'], photo: file('mug.png', 100) });
  await pb.collection('shop__products').create({ id: 'p2', title: 'Hat' });
  await pb.collection('shop__orders').create({ id: 'o1', product: 'p1', qty: 2 });
  await pb.collection('shop__customers').create({ id: 'c1', email: 'ann@x.dev', password: 'secret-pass-1', nick: 'ann' });
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const clear = (body) => clearData('shop', body, deps());
const restore = async (id, opts = {}, extra) => restoreSnapshot(await findSnapshot(dataDir, id), opts, deps(extra));

describe('restoring a snapshot', () => {
  test('brings back the records with their ids, the ones lost by cascade, and the uploaded files', async () => {
    const { snapshot } = await clear({ collections: ['products'] });
    const r = await restore(snapshot.id);
    assert.deepEqual(ids('shop__products'), ['p1', 'p2']);
    assert.deepEqual(ids('shop__orders'), ['o1']);
    const mug = pb.records('shop__products').find((x) => x.id === 'p1');
    assert.deepEqual([mug.title, mug.tags], ['Mug', ['a']]);
    assert.match(mug.photo, /^mug_\w+\.png$/);
    assert.equal(readFileSync(join(dataDir, 'pb_data', 'storage', pb.collections.byName('shop__products').id, 'p1', mug.photo)).length, 100);
    assert.equal(pb.records('shop__orders')[0].product, 'p1');
    assert.deepEqual(r.collections.map((c) => [c.name, c.restored, c.existing]), [['products', 2, 0], ['orders', 1, 0]]);
  });
  test('restoring twice changes nothing the second time: existing ids are skipped', async () => {
    const { snapshot } = await clear({ collections: ['products'] });
    await restore(snapshot.id);
    pb.records('shop__products').find((x) => x.id === 'p2').title = 'Hat (edited since)';
    const again = await restore(snapshot.id);
    assert.deepEqual(again.collections.map((c) => [c.name, c.restored, c.existing, c.failed]), [['products', 0, 2, 0], ['orders', 0, 1, 0]]);
    assert.equal(pb.records('shop__products').length, 2);
    assert.equal(pb.records('shop__products').find((x) => x.id === 'p2').title, 'Hat (edited since)');
  });
});

describe('schema drift', () => {
  test('a dropped collection is recreated from the snapshot\'s schema, rules included, then filled', async () => {
    const { snapshot } = await clear({ collections: ['orders'], drop: true });
    const dry = await restore(snapshot.id, { dry_run: true });
    assert.deepEqual([dry.dry_run, dry.recreated], [true, ['orders']]);
    assert.equal(pb.collections.byName('shop__orders'), undefined, 'a dry run changes nothing');
    const r = await restore(snapshot.id);
    assert.deepEqual(r.recreated, ['orders']);
    const orders = (await readSchema('shop', pb.collections)).collections.find((c) => c.name === 'orders');
    assert.deepEqual(orders.fields.map((f) => [f.name, f.type, f.collection]), [['product', 'relation', 'products'], ['qty', 'number', undefined], ['created', 'autodate', undefined], ['updated', 'autodate', undefined]]);
    assert.deepEqual(ids('shop__orders'), ['o1']);
  });
  test('a recreated collection loses relations to collections that are gone too', async () => {
    const { snapshot } = await clear({ collections: ['orders'], drop: true });
    await pb.collections.truncate('shop__products');
    await clear({ collections: ['products'], drop: true });
    const r = await restore(snapshot.id);
    assert.deepEqual(r.skipped_fields, ['orders.product']);
    assert.deepEqual(pb.records('shop__orders').map((x) => [x.id, x.qty]), [['o1', 2]]);
  });
  test('fields removed since are skipped; the rest of each record comes back', async () => {
    const { snapshot } = await clear({ collections: ['products'] });
    const col = pb.collections.byName('shop__products');
    await pb.collections.update(col.id, { fields: col.fields.filter((f) => f.name !== 'tags') });
    const dry = await restore(snapshot.id, { dry_run: true });
    assert.deepEqual([dry.skipped_fields, dry.refused_fields], [['products.tags'], []]);
    await restore(snapshot.id);
    assert.deepEqual(pb.records('shop__products').map((x) => [x.id, x.title, 'tags' in x]), [['p1', 'Mug', false], ['p2', 'Hat', false]]);
  });
  test('fields whose type changed are refused: the dry run lists them and the restore writes nothing', async () => {
    const { snapshot } = await clear({ collections: ['products'] });
    const col = pb.collections.byName('shop__products');
    await pb.collections.update(col.id, { fields: col.fields.map((f) => (f.name === 'title' ? { ...f, type: 'number' } : f)) });
    const dry = await restore(snapshot.id, { dry_run: true });
    assert.deepEqual(dry.refused_fields, ['products.title was text, is number now']);
    await assert.rejects(restore(snapshot.id), (e) => e.status === 409 && /changed type/.test(e.message) && e.details[0] === 'products.title was text, is number now');
    assert.deepEqual(pb.records('shop__products'), []);
  });
});

describe('relations', () => {
  test('a record pointing at one restored after it (a self-relation) is retried once the rest are in', async () => {
    await applySchema('shop', { collections: [{ name: 'folders', fields: [{ name: 'name', type: 'text' }, { name: 'parent', type: 'relation', collection: 'folders' }] }] }, pb.collections);
    await pb.collection('shop__folders').create({ id: 'fb', name: 'root' });
    await pb.collection('shop__folders').create({ id: 'fa', name: 'child', parent: 'fb' });
    const { snapshot } = await clear({ collections: ['folders'] });
    const r = await restore(snapshot.id);
    assert.deepEqual(r.collections.map((c) => [c.name, c.restored, c.failed]), [['folders', 2, 0]]);
    assert.equal(pb.records('shop__folders').find((x) => x.id === 'fa').parent, 'fb');
  });
});

describe('accounts', () => {
  test('restored accounts get new random passwords, listed so they can be handed out', async () => {
    const { snapshot } = await clear({ collections: ['customers'] });
    const r = await restore(snapshot.id);
    assert.equal(r.accounts.length, 1);
    const [a] = r.accounts;
    assert.deepEqual([a.collection, a.id, a.email], ['customers', 'c1', 'ann@x.dev']);
    assert.match(a.password, /^[\w-]{16}$/);
    assert.equal(pb.password('shop__customers', 'c1'), a.password);
    assert.equal(pb.records('shop__customers')[0].nick, 'ann');
    assert.match(r.warnings.join('\n'), /new random passwords/);
  });
});

describe('--overwrite', () => {
  test('replaces records that exist again, after snapshotting the versions it replaces', async () => {
    const { snapshot } = await clear({ collections: ['products'] });
    await pb.collection('shop__products').create({ id: 'p2', title: 'Hat v2' });
    const r = await restore(snapshot.id, { overwrite: true });
    assert.deepEqual(r.collections.find((c) => c.name === 'products'), { name: 'products', records: 2, existing: 1, restored: 1, replaced: 1, failed: 0 });
    assert.equal(pb.records('shop__products').find((x) => x.id === 'p2').title, 'Hat');
    const backup = await findSnapshot(dataDir, r.backup.id);
    assert.equal(backup.meta.mode, 'overwrite');
    assert.match(backup.meta.reason, new RegExp(snapshot.id));
    const saved = readFileSync(join(backup.dir, 'records', 'products.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(saved.map((x) => [x.id, x.title]), [['p2', 'Hat v2']]);
  });
  test('nothing to replace: no extra snapshot', async () => {
    const { snapshot } = await clear({ collections: ['products'] });
    const r = await restore(snapshot.id, { overwrite: true });
    assert.equal(r.backup, undefined);
  });
});

describe('what can\'t come back', () => {
  test('a snapshot without files restores records without them, and says so', async () => {
    const { snapshot } = await clearData('shop', { collections: ['products'] }, deps({ filesCap: 1 }));
    const r = await restore(snapshot.id);
    assert.match(r.warnings.join('\n'), /no uploaded files/);
    assert.equal(pb.records('shop__products').find((x) => x.id === 'p1').photo, '');
  });
  test('a record PocketBase refuses is reported, and the others still come back', async () => {
    const { snapshot } = await clear({ collections: ['customers'] });
    await pb.collection('shop__customers').create({ id: 'c9', email: 'other@x.dev', password: 'x-pass-12345' });
    pb.collection = ((real) => (name) => ({ ...real(name), create: async (d) => { if (d.id === 'c1') throw Object.assign(new Error('Failed to create record.'), { response: { data: { email: { code: 'validation_not_unique', message: 'Value must be unique.' } } } }); return real(name).create(d); } }))(pb.collection.bind(pb));
    const r = await restore(snapshot.id);
    assert.deepEqual(r.collections[0].failed, 1);
    assert.match(r.failures[0].error, /validation_not_unique/);
  });
  test('a snapshot of another app is not restored into this one', async () => {
    const { snapshot } = await clear({ collections: ['products'] });
    await assert.rejects(restore(snapshot.id, {}, { project: { id: 'proj2', slug: 'shop' } }), (e) => e.status === 404);
  });
});
