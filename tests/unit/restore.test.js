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

// Every record of the app, by collection, without what a restore can't keep (created/updated, upload names: an upload
// is its size instead). Comparing this before a clear and after its restore shows anything lost.
function dump() {
  const out = {};
  for (const col of [...pb.collections.cols.values()].filter((c) => c.name.startsWith('shop__')).sort((a, b) => a.name.localeCompare(b.name))) {
    const files = col.fields.filter((f) => f.type === 'file').map((f) => f.name);
    out[col.name.slice(6)] = pb.records(col.name).map(({ created, updated, password, ...r }) => {
      for (const f of files) r[f] = [].concat(r[f]).filter(Boolean).map((name) => readFileSync(join(dataDir, 'pb_data', 'storage', col.id, r.id, name)).length);
      return r;
    }).sort((a, b) => a.id.localeCompare(b.id));
  }
  return out;
}
// Clears with `body`, checks it lost something, restores and checks everything is back as it was.
async function clearAndRestore(body) {
  const before = dump();
  const cleared = await clear(body);
  assert.notDeepEqual(dump(), before, 'the clear deleted something');
  const restored = await restore(cleared.snapshot.id);
  assert.deepEqual(restored.failures, []);
  assert.deepEqual(dump(), before, 'the restore brings back everything the clear took');
  return { cleared, restored };
}

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

describe('everything a clear deletes comes back', () => {
  test('a thread on a cascading self-relation: replies of replies of the deleted comment too', async () => {
    await applySchema('shop', { collections: [{ name: 'comments', fields: [{ name: 'body', type: 'text' }, { name: 'parent', type: 'relation', collection: 'comments', cascadeDelete: true }] }] }, pb.collections);
    await pb.collection('shop__comments').create({ id: 'top', body: 'top' });
    await pb.collection('shop__comments').create({ id: 'rep1', body: 'r1', parent: 'top' });
    await pb.collection('shop__comments').create({ id: 'rep2', body: 'r2', parent: 'rep1' });
    await pb.collection('shop__comments').create({ id: 'other', body: 'other' });
    const { cleared } = await clearAndRestore({ collection: 'comments', ids: ['top'] });
    assert.deepEqual(cleared.cascade, [{ collection: 'comments', field: 'parent', records: 2, deletes: true }]);
  });
  async function chain() {
    await applySchema('shop', { collections: [
      { name: 'a', fields: [{ name: 't', type: 'text' }] },
      { name: 'b', fields: [{ name: 'a', type: 'relation', collection: 'a', cascadeDelete: true }] },
      { name: 'c', fields: [{ name: 'b', type: 'relation', collection: 'b', cascadeDelete: true }] },
    ] }, pb.collections);
    await pb.collection('shop__a').create({ id: 'a1', t: 'x' });
    await pb.collection('shop__a').create({ id: 'a2', t: 'y' });
    await pb.collection('shop__b').create({ id: 'b1', a: 'a1' });
    await pb.collection('shop__c').create({ id: 'c1', b: 'b1' });
    await pb.collection('shop__c').create({ id: 'c2', b: 'b1' });
  }
  test('a chain a <- b <- c cleared by id: what cascades two hops away too, in the preview and the snapshot', async () => {
    await chain();
    const dry = await clear({ collection: 'a', ids: ['a1'], dry_run: true });
    assert.deepEqual(dry.cascade, [{ collection: 'b', field: 'a', records: 1, deletes: true }, { collection: 'c', field: 'b', records: 2, deletes: true }]);
    await clearAndRestore({ collection: 'a', ids: ['a1'] });
  });
  test('uploads of records deleted by cascade are snapshotted, and count toward the files cap', async () => {
    await applySchema('shop', { collections: [
      { name: 'posts', fields: [{ name: 't', type: 'text' }] },
      { name: 'attachments', fields: [{ name: 'post', type: 'relation', collection: 'posts', cascadeDelete: true }, { name: 'file', type: 'file', maxSelect: 1 }] },
    ] }, pb.collections);
    await pb.collection('shop__posts').create({ id: 'post1', t: 'p' });
    await pb.collection('shop__attachments').create({ id: 'att1', post: 'post1', file: file('doc.bin', 5000) });
    const dry = await clear({ collection: 'posts', ids: ['post1'], dry_run: true });
    assert.equal(dry.files_bytes, 5000);
    const capped = await clearData('shop', { collection: 'posts', ids: ['post1'], dry_run: true }, deps({ filesCap: 4000 }));
    assert.match(capped.warnings.join('\n'), /uploaded files \(4\.9 KB\) are over the 3\.9 KB snapshot cap/);
    const { cleared } = await clearAndRestore({ collection: 'posts', ids: ['post1'] });
    assert.deepEqual([cleared.snapshot.files, cleared.snapshot.files_bytes], [true, 5000]);
  });
  test('links the clear removed from records that stay are put back, without touching their other fields', async () => {
    await applySchema('shop', { collections: [
      { name: 'people', fields: [{ name: 'n', type: 'text' }] },
      { name: 'notes', fields: [{ name: 't', type: 'text' }, { name: 'author', type: 'relation', collection: 'people' }] },
    ] }, pb.collections);
    await pb.collection('shop__people').create({ id: 'ann', n: 'ann' });
    await pb.collection('shop__notes').create({ id: 'n1', t: 'hi', author: 'ann' });
    await clearAndRestore({ collection: 'people', ids: ['ann'] });
    await clearAndRestore({ collections: ['people'] });
    // Edited since the clear: the edit stays, the link comes back.
    const { snapshot } = await clear({ collections: ['people'] });
    await pb.collection('shop__notes').update('n1', { t: 'edited' });
    const r = await restore(snapshot.id);
    assert.deepEqual(pb.records('shop__notes').map((x) => [x.t, x.author]), [['edited', 'ann']]);
    assert.deepEqual(r.links, [{ name: 'notes', records: 1, relinked: 1 }]);
  });
  test('a single relation set to something else since is left alone', async () => {
    await applySchema('shop', { collections: [
      { name: 'people', fields: [{ name: 'n', type: 'text' }] },
      { name: 'notes', fields: [{ name: 'author', type: 'relation', collection: 'people' }] },
    ] }, pb.collections);
    await pb.collection('shop__people').create({ id: 'ann' });
    await pb.collection('shop__people').create({ id: 'bob' });
    await pb.collection('shop__notes').create({ id: 'n1', author: 'ann' });
    const { snapshot } = await clear({ collection: 'people', ids: ['ann'] });
    await pb.collection('shop__notes').update('n1', { author: 'bob' });
    const r = await restore(snapshot.id);
    assert.equal(pb.records('shop__notes')[0].author, 'bob');
    assert.deepEqual(r.links, [{ name: 'notes', records: 1, relinked: 0 }]);
  });
  test('relations holding several ids get back the ids the clear removed, in place, keeping ones added since', async () => {
    await applySchema('shop', { collections: [
      { name: 'tags', fields: [{ name: 'n', type: 'text' }] },
      { name: 'posts', fields: [{ name: 't', type: 'text' }, { name: 'tags', type: 'relation', collection: 'tags', maxSelect: 5 }] },
      { name: 'bundles', fields: [{ name: 'items', type: 'relation', collection: 'posts', maxSelect: 10, cascadeDelete: true }] },
    ] }, pb.collections);
    for (const id of ['t1', 't2', 't3']) await pb.collection('shop__tags').create({ id, n: id });
    await pb.collection('shop__posts').create({ id: 'pa', t: 'A', tags: ['t1', 't2'] });
    await pb.collection('shop__posts').create({ id: 'pb', t: 'B', tags: ['t1'] });
    await pb.collection('shop__bundles').create({ id: 'bu1', items: ['pa'] });
    await pb.collection('shop__bundles').create({ id: 'bu2', items: ['pa', 'pb'] });
    await clearAndRestore({ collection: 'posts', ids: ['pa'] });
    await clearAndRestore({ collection: 'tags', ids: ['t1'] });
    const { snapshot } = await clear({ collection: 'tags', ids: ['t1'] });
    await pb.collection('shop__posts').update('pb', { tags: ['t3'] });
    await restore(snapshot.id);
    assert.deepEqual(pb.records('shop__posts').map((x) => [x.id, x.tags]).sort(), [['pa', ['t1', 't2']], ['pb', ['t1', 't3']]]);
  });
  test('the same chain when a is emptied whole', async () => {
    await chain();
    const { cleared } = await clearAndRestore({ collections: ['a'] });
    assert.deepEqual(cleared.cascade, [{ collection: 'b', field: 'a', records: 1, deletes: true }, { collection: 'c', field: 'b', records: 2, deletes: true }]);
  });
});

describe('more shapes of data', () => {
  test('collections pointing at each other (a cycle) and many records come back whole', async () => {
    await applySchema('shop', { collections: [
      { name: 'teams', fields: [{ name: 'captain', type: 'relation', collection: 'players' }] },
      { name: 'players', fields: [{ name: 'team', type: 'relation', collection: 'teams' }, { name: 'n', type: 'number' }] },
    ] }, pb.collections);
    await pb.collection('shop__teams').create({ id: 't1' });
    for (let i = 0; i < 150; i++) await pb.collection('shop__players').create({ id: `pl${String(i).padStart(3, '0')}`, team: 't1', n: i });
    await pb.collection('shop__teams').update('t1', { captain: 'pl007' });
    const { snapshot } = await clear({ collections: ['teams', 'players'] });
    const r = await restore(snapshot.id);
    assert.deepEqual(r.collections.map((c) => [c.name, c.restored, c.failed]).sort(), [['players', 150, 0], ['teams', 1, 0]]);
    assert.equal(pb.records('shop__teams')[0].captain, 'pl007');
  });
  test('links of a cycle that can\'t be set afterwards are reported; the records stay restored', async () => {
    await applySchema('shop', { collections: [
      { name: 'eggs', fields: [{ name: 'hen', type: 'relation', collection: 'hens' }] },
      { name: 'hens', fields: [{ name: 'egg', type: 'relation', collection: 'eggs' }] },
    ] }, pb.collections);
    await pb.collection('shop__eggs').create({ id: 'e1' });
    await pb.collection('shop__hens').create({ id: 'h1', egg: 'e1' });
    await pb.collection('shop__eggs').update('e1', { hen: 'h1' });
    const { snapshot } = await clear({ collections: ['eggs', 'hens'] });
    pb.collection = ((real) => (name) => ({ ...real(name), update: async () => { throw new Error('locked'); } }))(pb.collection.bind(pb));
    const r = await restore(snapshot.id);
    assert.deepEqual(r.failures.map((f) => f.error), ['restored without its links: locked', 'restored without its links: locked']);
    assert.equal(pb.records('shop__eggs').length + pb.records('shop__hens').length, 2);
  });
  test('a field holding several files gets all of them back', async () => {
    await applySchema('shop', { collections: [{ name: 'albums', fields: [{ name: 'pics', type: 'file', maxSelect: 5 }] }] }, pb.collections);
    await pb.collection('shop__albums').create({ id: 'a1', pics: [file('one.png', 3), file('two.png', 4)] });
    const { snapshot } = await clear({ collections: ['albums'] });
    await restore(snapshot.id);
    assert.equal(pb.records('shop__albums')[0].pics.length, 2);
  });
  test('an error without details from PocketBase is reported by its message', async () => {
    const { snapshot } = await clear({ collections: ['orders'] });
    pb.collection = ((real) => (name) => ({ ...real(name), create: async () => { throw new Error('socket hang up'); } }))(pb.collection.bind(pb));
    const r = await restore(snapshot.id);
    assert.deepEqual(r.failures, [{ collection: 'orders', id: 'o1', error: 'socket hang up' }]);
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
