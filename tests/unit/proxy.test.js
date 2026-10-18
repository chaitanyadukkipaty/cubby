import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tokenCollectionId, isAllowed, foreignCollectionRef, checkForeignRefs, tokenAllowed, checkRealtimeSubscribe, topicCollection } from '../../server/src/proxy.js';

const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

// Fake collection index: project "app" owns pbc_users (auth) and pbc_tasks.
function fakeIndex({ ids = ['pbc_users', 'pbc_tasks'], authIds = ['pbc_users'], names = ['app__users', 'app__tasks'] } = {}) {
  const calls = [];
  const index = async (slug, opts = {}) => {
    calls.push({ slug, refresh: Boolean(opts.refresh) });
    return slug === 'app' ? { ids: new Set(ids), authIds: new Set(authIds), names: new Set(names) } : { ids: new Set(), authIds: new Set(), names: new Set() };
  };
  return { index, calls };
}

describe('tokenCollectionId', () => {
  test('reads collectionId from a JWT payload', () => assert.equal(tokenCollectionId(jwt({ collectionId: 'pbc_1', id: 'u' })), 'pbc_1'));
  test('null for tokens without a collection', () => assert.equal(tokenCollectionId(jwt({ id: 'u' })), null));
  for (const bad of ['', 'garbage', 'a.b.c', 'a.!!!.c', 'onlyone']) test(`null for malformed ${JSON.stringify(bad)}`, () => assert.equal(tokenCollectionId(bad), null));
});

describe('isAllowed path matrix (project "app", prefix app__)', () => {
  const { index } = fakeIndex();
  const allow = [
    ['GET', '/api/health'], ['GET', '/api/realtime'], ['POST', '/api/realtime'],
    ['GET', '/api/collections/app__tasks/records'], ['POST', '/api/collections/app__tasks/records'],
    ['GET', '/api/collections/app__tasks/records/abc123'], ['POST', '/api/collections/app__users/auth-with-password'],
    ['POST', '/api/collections/app__users/request-password-reset'], ['GET', '/api/collections/app__users/auth-methods'],
    ['POST', '/api/files/token'], ['GET', '/api/files/app__tasks/rec/file.png'], ['GET', '/api/files/pbc_tasks/rec/file.png'],
  ];
  const deny = [
    ['GET', '/api/collections'], ['GET', '/api/collections/app__tasks'], ['PATCH', '/api/collections/app__tasks'],
    ['GET', '/api/collections/other__tasks/records'], ['GET', '/api/collections/users/records'],
    ['GET', '/api/collections/cubby_api_keys/records'], ['GET', '/api/collections/_superusers/records'],
    ['GET', '/api/collections/pbc_tasks/records'], ['GET', '/api/collections/app__tasks/../users/records'],
    ['GET', '/api/settings'], ['GET', '/api/logs'], ['POST', '/api/batch'], ['GET', '/api/backups'], ['GET', '/_/'],
    ['GET', '/api/files/token'], ['GET', '/api/files/pbc_other/rec/f.png'], ['PUT', '/api/realtime'], ['DELETE', '/api/realtime'], ['GET', '/api/files/other__tasks/rec/f.png'], ['GET', '/'],
  ];
  for (const [m, p] of allow) test(`allows ${m} ${p}`, async () => assert.equal(await isAllowed('app', m, p, index), true));
  for (const [m, p] of deny) test(`denies ${m} ${p}`, async () => assert.equal(await isAllowed('app', m, p, index), false));
  test('refreshes the index once before denying an unknown file collection id', async () => {
    const f = fakeIndex();
    assert.equal(await isAllowed('app', 'GET', '/api/files/pbc_new/r/f', f.index), false);
    assert.deepEqual(f.calls, [{ slug: 'app', refresh: false }, { slug: 'app', refresh: true }]);
  });
  test('hyphenated slugs use underscores', async () => assert.equal(await isAllowed('my-app', 'GET', '/api/collections/my_app__t/records', fakeIndex().index), true));
});

describe('tokenAllowed', () => {
  test('no token is fine (anonymous)', async () => assert.equal(await tokenAllowed('app', '', fakeIndex().index), true));
  test('accepts tokens from the project\'s auth collections', async () => assert.equal(await tokenAllowed('app', jwt({ collectionId: 'pbc_users' }), fakeIndex().index), true));
  test('rejects tokens from another collection (other app, platform, superuser)', async () => {
    for (const c of ['pbc_other_users', 'pbc_tasks', '_pbc_superusers']) assert.equal(await tokenAllowed('app', jwt({ collectionId: c }), fakeIndex().index), false, c);
  });
  test('rejects malformed tokens without hitting the index', async () => {
    const f = fakeIndex();
    assert.equal(await tokenAllowed('app', 'not-a-jwt', f.index), false);
    assert.equal(f.calls.length, 0);
  });
  test('refreshes once for a just-created auth collection', async () => {
    let n = 0;
    const index = async () => ({ ids: new Set(), authIds: new Set(n++ ? ['pbc_new'] : []) });
    assert.equal(await tokenAllowed('app', jwt({ collectionId: 'pbc_new' }), index), true);
    assert.equal(n, 2);
  });
});

describe('foreign @collection references', () => {
  test('foreignCollectionRef finds the first foreign name', () => {
    assert.equal(foreignCollectionRef('@collection.app__x.id = 1', 'app__'), null);
    assert.equal(foreignCollectionRef('@collection.app__x.id = 1 && @collection.other__y.id = 2', 'app__'), 'other__y');
    assert.equal(foreignCollectionRef('@collection.users.email != ""', 'app__'), 'users');
    assert.equal(foreignCollectionRef('title ~ "@collection"', 'app__'), null);
  });
  test('checkForeignRefs decodes the query string (incl. + as space)', () => {
    assert.deepEqual(checkForeignRefs('?filter=%40collection.users.email+!%3D+%22%22', null, 'app__'), { foreign: 'users' });
    assert.deepEqual(checkForeignRefs('?filter=title%3D%22x%22', null, 'app__'), { foreign: null });
    assert.deepEqual(checkForeignRefs('?filter=%E0%A4%A', null, 'app__'), { foreign: null }, 'malformed encoding is tolerated');
  });
  test('checkForeignRefs inspects realtime topics, including JSON-escaped and URL-encoded options', () => {
    const body = (subs) => Buffer.from(JSON.stringify({ clientId: 'c', subscriptions: subs }));
    const opts = encodeURIComponent(JSON.stringify({ query: { filter: '@collection.other__users.id != ""' } }));
    assert.deepEqual(checkForeignRefs('', body([`app__tasks/*?options=${opts}`]), 'app__'), { foreign: 'other__users' });
    assert.deepEqual(checkForeignRefs('', Buffer.from('{"subscriptions":["app__tasks/*?options=\\u0040collection.users.id"]}'), 'app__'), { foreign: 'users' });
    assert.deepEqual(checkForeignRefs('', body(['app__tasks/*']), 'app__'), { foreign: null });
    assert.deepEqual(checkForeignRefs('', body([]), 'app__'), { foreign: null });
    assert.deepEqual(checkForeignRefs('', Buffer.from('{"clientId":"c"}'), 'app__'), { foreign: null });
  });
  test('checkForeignRefs flags invalid realtime bodies', () => {
    assert.deepEqual(checkForeignRefs('', Buffer.from('not json'), 'app__'), { invalid: true });
    assert.deepEqual(checkForeignRefs('', Buffer.from('{"subscriptions":"x"}'), 'app__'), { invalid: true });
  });
});

describe('checkRealtimeSubscribe (project "app" owns app__users = pbc_users, app__tasks = pbc_tasks)', () => {
  const body = (subscriptions, extra = {}) => Buffer.from(JSON.stringify({ clientId: 'c1', subscriptions, ...extra }));
  const check = (b, idx = fakeIndex().index) => checkRealtimeSubscribe('app', b, idx);

  test('refuses a topic naming another app\'s collection', async () => {
    assert.equal((await check(body(['other__members/*']))).status, 403);
  });
  test('allows this project\'s collections by name or id, with *, a record id, no record part and options', async () => {
    const opts = encodeURIComponent(JSON.stringify({ query: { filter: 'done = false' } }));
    const topics = ['app__tasks/*', 'pbc_tasks/*', 'app__tasks', 'pbc_tasks', 'app__tasks/abc123def456ghi', 'app__users/*?', `app__tasks/*?options=${opts}`, 'pbc_tasks?options={}'];
    for (const t of topics) assert.ok((await check(body([t]))).body, t);
    assert.ok((await check(body([]))).body, 'empty list unsubscribes');
    assert.ok((await check(Buffer.from('{"clientId":"c1"}'))).body, 'no subscriptions key unsubscribes');
  });
  test('refuses other apps, platform collections, unknown collections and ids, by name or id', async () => {
    const topics = ['other__members/*', 'pbc_other/*', 'other__members', 'users/*', 'users', '_superusers/*', 'cubby_api_keys/*', 'cubby_projects',
      '_pbc_2773867675/*', 'app__ghost/*', 'pbc_ghost', 'app__tasks_x/*'];
    for (const t of topics) assert.equal((await check(body([t]))).status, 403, t);
  });
  test('refuses topics that aren\'t a plain collection name or id (default deny)', async () => {
    const topics = ['', '*', '/app__tasks', ' app__tasks/*', 'app__tasks%2F*', 'app%5F%5Ftasks/*', 'other__members%2F*', 'app__tasks#', 'app__tasks.x/*', 'APP__TASKS/*'];
    for (const t of topics) assert.equal((await check(body([t]))).status, 403, JSON.stringify(t));
  });
  test('one foreign topic refuses the whole request', async () => {
    assert.equal((await check(body(['app__tasks/*', 'pbc_tasks/*', 'other__members/*']))).status, 403);
    assert.equal((await check(body(['app__tasks/*', 'users/*']))).status, 403);
  });
  test('JSON-escaped and URL-encoded topics are checked after decoding', async () => {
    const escaped = Buffer.from('{"clientId":"c1","subscriptions":["\\u006fther__members/*"]}');
    assert.equal((await check(escaped)).status, 403, 'JSON escape in the collection part');
    const escapedOwn = Buffer.from('{"clientId":"c1","subscriptions":["\\u0061pp__tasks/*"]}');
    assert.ok((await check(escapedOwn)).body, 'JSON escape resolving to an own collection');
    const ref = encodeURIComponent(JSON.stringify({ query: { filter: '@collection.other__users.id != ""' } }));
    const r = await check(body([`app__tasks/*?options=${ref}`]));
    assert.deepEqual([r.status, r.message], [403, 'Cannot reference collection "other__users" from this project.']);
    assert.equal((await check(Buffer.from('{"clientId":"c1","subscriptions":["app__tasks/*?options=\\u0040collection.users.id"]}'))).status, 403);
    assert.equal((await check(body(['app__tasks?options=%40collection.cubby_projects.id']))).status, 403);
  });
  test('malformed bodies are 400', async () => {
    for (const b of ['', 'not json', 'null', '[]', '"x"', '{"clientId":"c1","subscriptions":"app__tasks/*"}', '{"clientId":"c1","subscriptions":[1]}',
      '{"clientId":"c1","subscriptions":[["other__members/*"]]}', '{"subscriptions":["app__tasks/*"]}', '{"clientId":7,"subscriptions":[]}']) {
      assert.equal((await check(Buffer.from(b))).status, 400, b);
    }
  });
  test('forwards only the checked keys, as JSON (PocketBase matches keys case-insensitively)', async () => {
    const r = await check(Buffer.from('{"clientId":"c1","subscriptions":["app__tasks/*"],"Subscriptions":["other__members/*"],"x":1}'));
    assert.deepEqual(JSON.parse(r.body), { clientId: 'c1', subscriptions: ['app__tasks/*'] });
  });
  test('refreshes the index once for a just-created collection, and only once per request', async () => {
    let n = 0;
    const idx = async () => (n++ ? { ids: new Set(['pbc_new']), authIds: new Set(), names: new Set(['app__new']) } : { ids: new Set(), authIds: new Set(), names: new Set() });
    assert.ok((await check(body(['app__new/*', 'pbc_new']), idx)).body);
    assert.equal(n, 2);
    const f = fakeIndex();
    assert.equal((await check(body(['app__ghost/*', 'pbc_ghost', 'other__x']), f.index)).status, 403);
    assert.deepEqual(f.calls, [{ slug: 'app', refresh: false }, { slug: 'app', refresh: true }]);
    const g = fakeIndex();
    await check(body(['*']), g.index);
    assert.equal(g.calls.length, 0, 'unparseable topics are refused without a lookup');
  });
  test('topicCollection extracts the literal collection part', () => {
    assert.equal(topicCollection('app__tasks/*?options=x'), 'app__tasks');
    assert.equal(topicCollection('pbc_1?x=1'), 'pbc_1');
    assert.equal(topicCollection('a/b/c'), 'a');
    for (const t of [null, 3, '', '*', 'a%2Fb', ' a']) assert.equal(topicCollection(t), null, String(t));
  });
});
