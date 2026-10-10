import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  validate, buildFields, buildIndexes, rewriteRule, unrewriteRule, parseIndexes,
  applySchema, dropFromSchema, deleteCollections, readSchema, collectionIndex, projectCollections, resetCollectionCache,
} from '../../server/src/schema.js';
import { mergeFieldIds } from '../../server/src/pb.js';
import { HttpError } from '../../server/src/http.js';
import { fakeCollections } from '../helpers/fake-pb.js';

const errorsOf = (input) => {
  try { validate(input); return []; } catch (e) { assert.ok(e instanceof HttpError); assert.equal(e.status, 400); return e.details ?? [e.message]; }
};

describe('validate', () => {
  test('accepts a well-formed schema', () => {
    assert.deepEqual(errorsOf({ collections: [
      { name: 'users', type: 'auth', fields: [{ name: 'name', type: 'text' }] },
      { name: 'posts', fields: [{ name: 'author', type: 'relation', collection: 'users' }], indexes: [{ columns: ['author'], unique: false }] },
    ] }), []);
  });
  test('requires a collections array', () => {
    for (const bad of [undefined, {}, { collections: 'x' }]) assert.throws(() => validate(bad), /collections/);
  });
  const cases = [
    ['uppercase collection name', [{ name: 'Posts' }], /name must match/],
    ['collection name with "__"', [{ name: 'a__b' }], /without "__"/],
    ['missing collection name', [{}], /name must match/],
    ['duplicate names', [{ name: 'a' }, { name: 'a' }], /duplicated/],
    ['view collections', [{ name: 'v', type: 'view' }], /type must be "base" or "auth"/],
    ['bad field name', [{ name: 'a', fields: [{ name: '1x', type: 'text' }] }], /name is invalid/],
    ['unknown field type', [{ name: 'a', fields: [{ name: 'x', type: 'blob' }] }], /type must be one of/],
    ['relation without collection', [{ name: 'a', fields: [{ name: 'x', type: 'relation' }] }], /needs "collection"/],
    ['relation to unknown collection', [{ name: 'a', fields: [{ name: 'x', type: 'relation', collection: 'ghost' }] }], /unknown collection "ghost"/],
    ['index without columns', [{ name: 'a', indexes: [{ columns: [] }] }], /indexes\[0\]/],
    ['index with SQL in a column', [{ name: 'a', indexes: [{ columns: ['x); DROP TABLE users; --'] }] }], /indexes\[0\]/],
  ];
  for (const [label, collections, re] of cases) {
    test(`rejects ${label}`, () => assert.ok(errorsOf({ collections }).some((e) => re.test(e)), `expected ${re}`));
  }
  test('reports every error at once', () => {
    assert.equal(errorsOf({ collections: [{ name: 'Bad' }, { name: 'ok', fields: [{ name: '!', type: 'nope' }] }] }).length, 3);
  });
});

describe('buildFields', () => {
  const ids = new Map([['app__users', 'pbc_users']]);
  test('strips client-supplied ids/system flags, resolves relations, adds autodates', () => {
    const fields = buildFields({ name: 'posts', fields: [
      { id: 'evil', system: true, name: 'title', type: 'text', required: true },
      { name: 'author', type: 'relation', collection: 'users', collectionId: 'someone_else', maxSelect: 1 },
    ] }, 'app__', ids, { skipRelations: false });
    assert.deepEqual(fields[0], { name: 'title', type: 'text', required: true });
    assert.deepEqual(fields[1], { name: 'author', type: 'relation', collectionId: 'pbc_users', maxSelect: 1 });
    assert.deepEqual(fields.slice(2).map((f) => [f.name, f.onCreate, f.onUpdate]), [['created', true, false], ['updated', true, true]]);
  });
  test('skips relations in the first pass', () => {
    const fields = buildFields({ fields: [{ name: 'author', type: 'relation', collection: 'users' }] }, 'app__', ids, { skipRelations: true });
    assert.deepEqual(fields.map((f) => f.name), ['created', 'updated']);
  });
  test('does not duplicate explicit created/updated fields', () => {
    const fields = buildFields({ fields: [{ name: 'created', type: 'autodate', onCreate: true }] }, 'p__', ids, { skipRelations: false });
    assert.equal(fields.filter((f) => f.name === 'created').length, 1);
  });
  test('drops auth system fields on auth collections only', () => {
    const def = (type) => ({ type, fields: [{ name: 'email', type: 'email' }, { name: 'password', type: 'text' }, { name: 'nick', type: 'text' }] });
    assert.deepEqual(buildFields(def('auth'), 'p__', ids, { skipRelations: false }).map((f) => f.name), ['nick', 'created', 'updated']);
    assert.deepEqual(buildFields(def('base'), 'p__', ids, { skipRelations: false }).map((f) => f.name), ['email', 'password', 'nick', 'created', 'updated']);
  });
});

describe('indexes', () => {
  test('buildIndexes emits safe, quoted SQL', () => {
    assert.deepEqual(buildIndexes({ indexes: [{ columns: ['owner'] }, { columns: ['a', 'b'], unique: true }] }, 'app__tasks'), [
      'CREATE INDEX `idx_app__tasks_owner` ON `app__tasks` (`owner`)',
      'CREATE UNIQUE INDEX `idx_app__tasks_a_b` ON `app__tasks` (`a`, `b`)',
    ]);
    assert.deepEqual(buildIndexes({}, 'x'), []);
  });
  test('parseIndexes round-trips buildIndexes and ignores other SQL', () => {
    const sql = buildIndexes({ indexes: [{ columns: ['owner'] }, { columns: ['a', 'b'], unique: true }] }, 'app__tasks');
    assert.deepEqual(parseIndexes([...sql, 'SELECT 1', 'CREATE INDEX "x" ON "t" ("q")']), [
      { columns: ['owner'], unique: false }, { columns: ['a', 'b'], unique: true }, { columns: ['q'], unique: false },
    ]);
    assert.deepEqual(parseIndexes(undefined), []);
  });
});

describe('rule rewriting', () => {
  test('prefixes every @collection reference', () => {
    assert.equal(rewriteRule('@collection.members.user ?= @request.auth.id && @collection.teams.id != ""', 'app__'),
      '@collection.app__members.user ?= @request.auth.id && @collection.app__teams.id != ""');
  });
  test('a foreign prefix cannot be smuggled in: it gets our prefix too', () => {
    assert.equal(rewriteRule('@collection.other__secrets.id != ""', 'app__'), '@collection.app__other__secrets.id != ""');
  });
  test('leaves rules without references and null/empty rules alone', () => {
    assert.equal(rewriteRule('owner = @request.auth.id', 'app__'), 'owner = @request.auth.id');
    assert.equal(rewriteRule(null, 'app__'), null);
    assert.equal(rewriteRule(undefined, 'app__'), null);
    assert.equal(rewriteRule('', 'app__'), '');
  });
  test('unrewriteRule reverses rewriteRule', () => {
    const rule = '@collection.members.user ?= @request.auth.id';
    assert.equal(unrewriteRule(rewriteRule(rule, 'app__'), 'app__'), rule);
    assert.equal(unrewriteRule(null, 'app__'), null);
  });
});

describe('mergeFieldIds', () => {
  test('keeps ids for fields matched by name and always keeps system fields', () => {
    const existing = [{ id: 's1', name: 'id', system: true }, { id: 'f1', name: 'title', type: 'text' }, { id: 'f2', name: 'gone', type: 'text' }];
    const merged = mergeFieldIds(existing, [{ name: 'title', type: 'text', required: true }, { name: 'new', type: 'bool' }]);
    assert.deepEqual(merged, [{ id: 's1', name: 'id', system: true }, { name: 'title', type: 'text', required: true, id: 'f1' }, { name: 'new', type: 'bool' }]);
  });
});

describe('applySchema (against a fake PocketBase)', () => {
  let pb;
  beforeEach(() => { pb = fakeCollections(); resetCollectionCache(); });
  const schema = {
    collections: [
      { name: 'users', type: 'auth', fields: [{ name: 'name', type: 'text' }], createRule: '', listRule: 'id = @request.auth.id', authRule: '', passwordAuth: { enabled: true, identityFields: ['email'] } },
      { name: 'tasks', fields: [{ name: 'title', type: 'text' }, { name: 'owner', type: 'relation', collection: 'users', maxSelect: 1 }],
        listRule: 'owner = @request.auth.id || @collection.users.id = owner', indexes: [{ columns: ['owner'] }] },
    ],
  };

  test('creates prefixed collections, resolves relations, rewrites rules, defaults missing rules to admin-only', async () => {
    const r = await applySchema('my-app', schema, pb);
    assert.deepEqual(r, { created: ['users', 'tasks'], updated: [], kept: [] });
    const users = pb.byName('my_app__users');
    const tasks = pb.byName('my_app__tasks');
    assert.equal(users.type, 'auth');
    assert.equal(tasks.fields.find((f) => f.name === 'owner').collectionId, users.id);
    assert.equal(tasks.listRule, 'owner = @request.auth.id || @collection.my_app__users.id = owner');
    assert.equal(tasks.createRule, null, 'unspecified rules are superuser-only');
    assert.equal(users.createRule, '');
    assert.equal(users.authRule, '');
    assert.deepEqual(users.passwordAuth, { enabled: true, identityFields: ['email'] });
    assert.equal(tasks.authRule, undefined, 'auth-only rules are not sent for base collections');
    assert.deepEqual(tasks.indexes, ['CREATE INDEX `idx_my_app__tasks_owner` ON `my_app__tasks` (`owner`)']);
    assert.ok(users.fields.some((f) => f.name === 'email' && f.system), 'auth system fields are kept');
  });

  test('a second push updates in place and keeps field ids stable', async () => {
    await applySchema('my-app', schema, pb);
    const before = pb.byName('my_app__tasks').fields.find((f) => f.name === 'title').id;
    const r = await applySchema('my-app', schema, pb);
    assert.deepEqual(r, { created: [], updated: ['users', 'tasks'], kept: [] });
    assert.equal(pb.byName('my_app__tasks').fields.find((f) => f.name === 'title').id, before);
  });

  test('never deletes: removed fields and collections are kept and reported', async () => {
    await applySchema('my-app', schema, pb);
    const r = await applySchema('my-app', { collections: [{ name: 'tasks', fields: [{ name: 'owner', type: 'relation', collection: 'tasks' }] }] }, pb);
    assert.deepEqual(r.kept.sort(), ['tasks.title', 'users'].sort());
    assert.ok(pb.byName('my_app__tasks').fields.some((f) => f.name === 'title'));
    assert.ok(pb.byName('my_app__users'));
  });

  test('rejects type changes with a hint to drop first', async () => {
    await applySchema('my-app', schema, pb);
    const changed = structuredClone(schema);
    changed.collections[1].fields[0].type = 'number';
    await assert.rejects(applySchema('my-app', changed, pb), (e) => e.status === 400 && /from text to number/.test(e.message) && /schema drop tasks.title/.test(e.details[0]));
  });

  test('only sees its own collections', async () => {
    await applySchema('other', { collections: [{ name: 'tasks' }] }, pb);
    const r = await applySchema('my-app', { collections: [{ name: 'notes' }] }, pb);
    assert.deepEqual(r.kept, []);
    assert.deepEqual((await projectCollections('my-app', pb)).map((c) => c.name), ['my_app__notes']);
  });

  test('wraps PocketBase errors as 400 with details', async () => {
    await assert.rejects(applySchema('my-app', { collections: [{ name: 'x' }] }, fakeCollections({ failCreate: true })),
      (e) => e.status === 400 && /PocketBase rejected collection "x"/.test(e.message) && /invalid/.test(e.details[0]));
    const pb2 = fakeCollections();
    await applySchema('my-app', { collections: [{ name: 'x' }] }, pb2);
    const failing = Object.assign(fakeCollections({ failUpdate: true }), { cols: pb2.cols, getFullList: pb2.getFullList });
    await assert.rejects(applySchema('my-app', { collections: [{ name: 'x' }] }, failing), (e) => e.status === 400 && /Something went wrong/.test(e.details[0]));
  });

  test('invalid input never reaches PocketBase', async () => {
    await assert.rejects(applySchema('my-app', { collections: [{ name: 'Bad' }] }, pb), (e) => e.status === 400);
    assert.equal(pb.calls.create + pb.calls.update, 0);
  });
});

describe('dropFromSchema / deleteCollections', () => {
  let pb;
  beforeEach(async () => {
    pb = fakeCollections();
    resetCollectionCache();
    await applySchema('app', { collections: [
      { name: 'users', type: 'auth' },
      { name: 'tasks', fields: [{ name: 'title', type: 'text' }, { name: 'color', type: 'text' }, { name: 'owner', type: 'relation', collection: 'users' }] },
    ] }, pb);
  });
  test('drops a single field', async () => {
    assert.deepEqual(await dropFromSchema('app', 'tasks.color', pb), { dropped: 'tasks.color' });
    assert.ok(!pb.byName('app__tasks').fields.some((f) => f.name === 'color'));
  });
  test('drops a whole collection', async () => {
    await dropFromSchema('app', 'tasks', pb);
    assert.equal(pb.byName('app__tasks'), undefined);
  });
  test('404s for unknown collection or field, 400 for system fields', async () => {
    await assert.rejects(dropFromSchema('app', 'ghost', pb), (e) => e.status === 404);
    await assert.rejects(dropFromSchema('app', 'tasks.ghost', pb), (e) => e.status === 404);
    await assert.rejects(dropFromSchema('app', 'tasks.id', pb), (e) => e.status === 400 && /system field/.test(e.message));
  });
  test('cannot drop another project\'s collection', async () => {
    await assert.rejects(dropFromSchema('other', 'tasks', pb), (e) => e.status === 404);
    assert.ok(pb.byName('app__tasks'));
  });
  test('wraps PocketBase update errors', async () => {
    const failing = Object.assign(fakeCollections({ failUpdate: true }), { cols: pb.cols, getFullList: pb.getFullList });
    await assert.rejects(dropFromSchema('app', 'tasks.color', failing), (e) => e.status === 400);
  });
  test('deleteCollections retries until relation order resolves', async () => {
    const cols = await projectCollections('app', pb);
    const usersFirst = [cols.find((c) => c.name === 'app__users'), cols.find((c) => c.name === 'app__tasks')];
    assert.deepEqual((await deleteCollections(usersFirst, pb)).sort(), ['app__tasks', 'app__users']);
    assert.equal(pb.cols.size, 0);
  });
  test('deleteCollections gives up with 409 when something can never be deleted', async () => {
    const stuck = { ...pb, delete: async () => { throw new Error('locked'); } };
    await assert.rejects(deleteCollections(await projectCollections('app', pb), stuck), (e) => e.status === 409 && /Could not delete/.test(e.message));
  });
});

describe('readSchema', () => {
  test('returns the file format: unprefixed names, relation names, original rules and indexes', async () => {
    const pb = fakeCollections();
    resetCollectionCache();
    const input = { collections: [
      { name: 'users', type: 'auth', fields: [{ name: 'name', type: 'text' }], authRule: '', manageRule: null },
      { name: 'tasks', fields: [{ name: 'owner', type: 'relation', collection: 'users' }], listRule: '@collection.users.id ?= owner', indexes: [{ columns: ['owner'], unique: true }] },
    ] };
    await applySchema('app', input, pb);
    const out = await readSchema('app', pb);
    const users = out.collections.find((c) => c.name === 'users');
    const tasks = out.collections.find((c) => c.name === 'tasks');
    assert.deepEqual(users.fields.map((f) => f.name), ['name', 'created', 'updated'], 'system and auth fields hidden');
    assert.equal(users.authRule, '');
    assert.equal(tasks.fields[0].collection, 'users');
    assert.ok(!('collectionId' in tasks.fields[0]) && !('id' in tasks.fields[0]));
    assert.equal(tasks.listRule, '@collection.users.id ?= owner');
    assert.deepEqual(tasks.indexes, [{ columns: ['owner'], unique: true }]);
    assert.ok(!('authRule' in tasks));
  });
});

describe('collectionIndex', () => {
  test('caches per project and refreshes on demand', async () => {
    const pb = fakeCollections();
    resetCollectionCache();
    await applySchema('app', { collections: [{ name: 'users', type: 'auth' }, { name: 'tasks' }] }, pb);
    const calls = pb.calls.getFullList;
    const idx = await collectionIndex('app', {}, pb);
    assert.equal(pb.calls.getFullList, calls, 'served from the cache applySchema refreshed');
    assert.equal(idx.ids.size, 2);
    assert.deepEqual([...idx.authIds], [pb.byName('app__users').id]);
    await collectionIndex('app', { refresh: true }, pb);
    assert.equal(pb.calls.getFullList, calls + 1);
    resetCollectionCache();
    await collectionIndex('app', {}, pb);
    assert.equal(pb.calls.getFullList, calls + 2);
  });
});
