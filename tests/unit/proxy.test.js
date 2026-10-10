import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tokenCollectionId, isAllowed, foreignCollectionRef, checkForeignRefs, tokenAllowed } from '../../server/src/proxy.js';

const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

// Fake collection index: project "app" owns pbc_users (auth) and pbc_tasks.
function fakeIndex({ ids = ['pbc_users', 'pbc_tasks'], authIds = ['pbc_users'] } = {}) {
  const calls = [];
  const index = async (slug, opts = {}) => {
    calls.push({ slug, refresh: Boolean(opts.refresh) });
    return slug === 'app' ? { ids: new Set(ids), authIds: new Set(authIds) } : { ids: new Set(), authIds: new Set() };
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
    ['GET', '/api/files/token'], ['GET', '/api/files/pbc_other/rec/f.png'], ['GET', '/api/files/other__tasks/rec/f.png'], ['GET', '/'],
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
