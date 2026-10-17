// Deploy tarball → disk → Host-routed serving, and app traffic through the PocketBase proxy.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.js';
import { api, signup, deployTo, app } from '../helpers/integration.js';

let srv, alice, bob, shop, other;
before(async () => {
  srv = await startServer({ MAX_DEPLOY_MB: '1' });
  alice = api(srv.url, await signup(srv.url, 'alice@test.dev'));
  bob = api(srv.url, await signup(srv.url, 'bob@test.dev'));
  await alice('POST', '/api/projects', { body: { slug: 'shop' } });
  await bob('POST', '/api/projects', { body: { slug: 'other' } });
  const schema = (extra = []) => ({ collections: [
    { name: 'users', type: 'auth', createRule: '', listRule: 'id = @request.auth.id', viewRule: 'id = @request.auth.id' },
    { name: 'items', fields: [{ name: 'title', type: 'text' }, { name: 'owner', type: 'relation', collection: 'users', maxSelect: 1 }, ...extra],
      listRule: 'owner = @request.auth.id', viewRule: 'owner = @request.auth.id', createRule: '@request.auth.id != "" && @request.body.owner = @request.auth.id' },
  ] });
  assert.equal((await alice('PUT', '/api/projects/shop/schema', { body: schema() })).status, 200);
  assert.equal((await bob('PUT', '/api/projects/other/schema', { body: schema() })).status, 200);
  shop = app(srv, 'shop');
  other = app(srv, 'other');
});
after(() => srv?.stop());

describe('deploys', () => {
  test('a deploy goes live at <app>.<domain> with SPA fallback and runtime config', async () => {
    const d = await deployTo(alice, 'shop', { 'index.html': '<h1>v1</h1>', 'assets/app.js': 'js()' }, '?message=first', { 'x-cubby-client': 'claude-code' });
    assert.equal(d.status, 200);
    assert.deepEqual([d.data.files, d.data.client, d.data.url], [2, 'claude-code', `http://shop.localhost:${srv.port}`]);
    assert.equal((await shop('GET', '/')).text, '<h1>v1</h1>');
    assert.equal((await shop('GET', '/orders/42')).text, '<h1>v1</h1>');
    assert.equal((await shop('GET', '/assets/app.js')).headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal((await shop('GET', '/assets/missing.js')).status, 404);
    assert.equal((await shop('POST', '/')).status, 405);
    const cfg = await shop('GET', '/__cubby/config.js');
    assert.equal(cfg.text, 'window.__CUBBY__={"project":"shop","prefix":"shop__","pbUrl":"/pb"};');
    const dev = await api(srv.url)('GET', '/__cubby/config.js', { headers: { 'x-cubby-project': 'shop' } });
    assert.equal(dev.text, cfg.text, 'vite dev proxy header gets the same config');
  });
  test('unknown apps and apps without deploys explain themselves', async () => {
    assert.equal((await app(srv, 'ghost')('GET', '/')).status, 404);
    const r = await other('GET', '/');
    assert.equal(r.status, 404);
    assert.match(r.text, /no deploys yet/);
  });
  test('rejects bad uploads: no index.html, not a tarball, over the size limit', async () => {
    assert.equal((await deployTo(alice, 'shop', { 'dist/index.html': 'x' })).status, 400);
    assert.equal((await alice('POST', '/api/projects/shop/deploys', { raw: Buffer.from('nope') })).status, 400);
    const big = Buffer.alloc(1024 * 1024 + 10, 1);
    assert.equal((await alice('POST', '/api/projects/shop/deploys', { raw: big })).status, 413);
    assert.equal((await shop('GET', '/')).text, '<h1>v1</h1>', 'failed deploys leave the live version alone');
  });
  test('keeps the last 10 deploys; rollback switches instantly; unlisted/description apply', async () => {
    for (let i = 2; i <= 12; i++) await deployTo(alice, 'shop', { 'index.html': `<h1>v${i}</h1>` }, `?message=v${i}`);
    const list = (await alice('GET', '/api/projects/shop/deploys')).data;
    assert.equal(list.length, 10);
    assert.equal(list[0].message, 'v12');
    assert.ok(list[0].current);
    assert.ok(!list.some((d) => d.message === 'first' || d.message === 'v2'), 'oldest deploys pruned');
    assert.equal((await shop('GET', '/')).text, '<h1>v12</h1>');
    const v5 = list.find((d) => d.message === 'v5');
    assert.equal((await alice('POST', '/api/projects/shop/rollback', { body: { deploy: v5.id } })).status, 200);
    assert.equal((await shop('GET', '/')).text, '<h1>v5</h1>');
    assert.equal((await alice('POST', '/api/projects/shop/rollback', { body: { deploy: 'nope' } })).status, 404);
    await deployTo(alice, 'shop', { 'index.html': '<h1>v13</h1>' }, '?unlisted=1&description=Shop+app');
    const p = (await alice('GET', '/api/projects/shop')).data;
    assert.deepEqual([p.unlisted, p.description], [true, 'Shop app']);
  });
});

describe('PocketBase proxy', () => {
  let shopUser, otherUser;
  const signupAppUser = async (call, col, email) => {
    const body = { email, password: 'password1234', passwordConfirm: 'password1234' };
    assert.equal((await call('POST', `/pb/api/collections/${col}/records`, { body, headers: { 'content-type': 'application/json' } })).status, 200);
    const r = await call('POST', `/pb/api/collections/${col}/auth-with-password`, { body: { identity: email, password: 'password1234' }, headers: { 'content-type': 'application/json' } });
    return r.data;
  };
  before(async () => {
    shopUser = await signupAppUser(shop, 'shop__users', 'buyer@app.dev');
    otherUser = await signupAppUser(other, 'other__users', 'mallory@app.dev');
  });
  const json = { 'content-type': 'application/json' };

  test('app users can use their own collections, and rules apply', async () => {
    const auth = { authorization: shopUser.token, ...json };
    assert.equal((await shop('POST', '/pb/api/collections/shop__items/records', { headers: auth, body: { title: 'mine', owner: shopUser.record.id } })).status, 200);
    assert.equal((await shop('POST', '/pb/api/collections/shop__items/records', { headers: auth, body: { title: 'spoof', owner: 'aaaaaaaaaaaaaaa' } })).status, 400);
    assert.deepEqual((await shop('GET', '/pb/api/collections/shop__items/records', { headers: auth })).data.items.map((i) => i.title), ['mine']);
    assert.equal((await shop('GET', '/pb/api/collections/shop__items/records')).data.items.length, 0, 'anonymous sees nothing');
    assert.equal((await shop('GET', '/pb/api/health')).status, 200);
  });
  test('isolation: other apps\' collections, other apps\' tokens, platform data, admin UI', async () => {
    assert.equal((await other('GET', '/pb/api/collections/shop__items/records')).status, 403);
    assert.equal((await shop('GET', '/pb/api/collections/shop__items/records', { headers: { authorization: otherUser.token } })).status, 401);
    assert.equal((await shop('GET', '/pb/api/collections/users/records')).status, 403);
    assert.equal((await shop('GET', '/pb/api/collections/cubby_api_keys/records')).status, 403);
    assert.equal((await shop('GET', '/pb/_/')).status, 403);
    assert.equal((await shop('GET', '/pb/api/collections')).status, 403);
    const filter = encodeURIComponent('@collection.other__users.email != ""');
    assert.equal((await shop('GET', `/pb/api/collections/shop__items/records?filter=${filter}`)).status, 403);
  });
  test('realtime: subscribe through the proxy and receive events; foreign topics are refused', async () => {
    const base = `${srv.url}/pb`;
    const h = { 'x-cubby-project': 'shop' };
    const ctrl = new AbortController();
    const sse = await fetch(`${base}/api/realtime`, { headers: h, signal: ctrl.signal });
    const reader = sse.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const next = async (pred) => {
      for (;;) {
        const hit = buf.split('\n\n').find(pred);
        if (hit) { buf = ''; return hit; }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buf += dec.decode(value);
      }
    };
    try {
      const connect = await next((e) => e.includes('PB_CONNECT'));
      const clientId = JSON.parse(connect.match(/data:(.*)/)[1]).clientId;
      const sub = (subscriptions) => fetch(`${base}/api/realtime`, { method: 'POST', headers: { ...h, ...json, authorization: shopUser.token }, body: JSON.stringify({ clientId, subscriptions }) });
      const opts = encodeURIComponent(JSON.stringify({ query: { filter: '@collection.other__users.id != ""' } }));
      assert.equal((await sub([`shop__items/*?options=${opts}`])).status, 403);
      assert.equal((await sub(['shop__items/*'])).status, 204);
      await shop('POST', '/pb/api/collections/shop__items/records', { headers: { authorization: shopUser.token, ...json }, body: { title: 'live', owner: shopUser.record.id } });
      const ev = await Promise.race([next((e) => e.includes('shop__items')), new Promise((_, rej) => setTimeout(() => rej(new Error('no realtime event within 5s')), 5000))]);
      assert.match(ev, /"action":"create"/);
      assert.match(ev, /"title":"live"/);
    } finally {
      ctrl.abort();
    }
  });
  test('realtime: topics naming another app\'s collection are refused and deliver nothing', async () => {
    // "other" gets a collection any signed-in user may read: PocketBase would accept a shop user for it.
    const members = { name: 'members', fields: [{ name: 'msg', type: 'text' }], listRule: '@request.auth.id != ""', viewRule: '@request.auth.id != ""', createRule: '@request.auth.id != ""' };
    assert.equal((await bob('PUT', '/api/projects/other/schema', { body: { collections: [members] } })).status, 200);
    const oAuth = { authorization: otherUser.token, ...json };
    const seed = await other('POST', '/pb/api/collections/other__members/records', { headers: oAuth, body: { msg: 'seed' } });
    assert.equal(seed.status, 200);
    const membersId = seed.data.collectionId;
    const mine = await shop('POST', '/pb/api/collections/shop__items/records', { headers: { authorization: shopUser.token, ...json }, body: { title: 'seed', owner: shopUser.record.id } });
    const itemsId = mine.data.collectionId;

    const base = `${srv.url}/pb`;
    const h = { 'x-cubby-project': 'shop' };
    const ctrl = new AbortController();
    const sse = await fetch(`${base}/api/realtime`, { headers: h, signal: ctrl.signal });
    const reader = sse.body.getReader();
    const dec = new TextDecoder();
    let seen = '';
    const next = async (pred) => {
      for (;;) {
        const hit = seen.split('\n\n').find(pred);
        if (hit) return hit;
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        seen += dec.decode(value);
      }
    };
    const within = (p, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`no ${what} within 5s`)), 5000))]);
    try {
      const clientId = JSON.parse((await next((e) => e.includes('PB_CONNECT'))).match(/data:(.*)/)[1]).clientId;
      const post = (body, type = 'application/json') => fetch(`${base}/api/realtime`, { method: 'POST', headers: { ...h, 'content-type': type, authorization: shopUser.token }, body });
      const sub = (subscriptions) => post(JSON.stringify({ clientId, subscriptions }));
      assert.equal((await sub(['other__members/*'])).status, 403, 'by name');
      assert.equal((await sub([`${membersId}/*`])).status, 403, 'by id');
      assert.equal((await sub(['other__members'])).status, 403, 'legacy form without a record part');
      assert.equal((await sub(['shop__items/*', 'other__members/*'])).status, 403, 'one foreign topic refuses all');
      assert.equal((await sub(['users/*'])).status, 403, 'platform collection');
      const refused = await sub(['cubby_projects/*']);
      assert.equal(refused.status, 403);
      assert.match((await refused.json()).message, /this project's collections/);
      assert.equal((await post(`{"x":"&clientId=${clientId}&subscriptions=other__members/*&"}`, 'application/x-www-form-urlencoded')).status, 400, 'JSON that is also a form body');
      assert.equal((await post(`clientId=${clientId}&subscriptions=other__members/*`, 'application/x-www-form-urlencoded')).status, 400, 'form body');
      assert.equal((await post(JSON.stringify({ clientId, subscriptions: [], Subscriptions: ['other__members/*'] }))).status, 204, 'case-variant keys are dropped');
      assert.equal((await post('{')).status, 400);
      assert.equal((await post(JSON.stringify({ clientId, subscriptions: ['x'.repeat(300 * 1024)] }))).status, 413);

      assert.equal((await other('POST', '/pb/api/collections/other__members/records', { headers: oAuth, body: { msg: 'SECRET' } })).status, 200);
      assert.equal((await sub(['shop__items/*', `${itemsId}/*`])).status, 204, 'own collection by name and by id');
      await shop('POST', '/pb/api/collections/shop__items/records', { headers: { authorization: shopUser.token, ...json }, body: { title: 'live2', owner: shopUser.record.id } });
      await within(next((e) => e.includes('"title":"live2"')), 'own realtime event');
      await new Promise((r) => setTimeout(r, 300));
      assert.doesNotMatch(seen, /other__members|SECRET/);
    } finally {
      ctrl.abort();
    }
  });
});
