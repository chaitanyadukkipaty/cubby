// Control API ↔ PocketBase: accounts, tokens, projects, ownership, schema, gallery, admin, device login.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, ADMIN, SIGNUP_CODE, ROOT } from '../helpers/server.js';
import { api, signup, adminToken, deployTo } from '../helpers/integration.js';

let srv, anon, adminCall, alice, aliceToken, bob, bobToken;
before(async () => {
  srv = await startServer({ CUBBY_SERVER_NAME: '  Test   Cubby ' });
  anon = api(srv.url);
  adminCall = api(srv.url, await adminToken(srv.url, ADMIN));
  aliceToken = await signup(srv.url, 'alice@test.dev');
  alice = api(srv.url, aliceToken);
  bobToken = await signup(srv.url, 'bob@test.dev');
  bob = api(srv.url, bobToken);
});
after(() => srv?.stop());

describe('bootstrap', () => {
  test('first boot creates the admin and settings; every response carries the version', async () => {
    const info = await anon('GET', '/api/info');
    assert.equal(info.status, 200);
    // Built without git info (tests/helpers/server.js), so the plain package.json version and no commit.
    const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    assert.equal(info.data.version, pkgVersion);
    assert.deepEqual(info.data, { name: 'Test Cubby', version: pkgVersion, commit: null, open_signup: false, https: false, base_domain: `localhost:${srv.port}`, features: ['jobs'] });
    assert.equal(info.headers.get('x-cubby-version'), info.data.version);
    const me = await adminCall('GET', '/api/me');
    assert.equal(me.data.email, ADMIN.email);
    assert.equal(me.data.is_admin, true);
  });
});

describe('accounts and tokens', () => {
  test('signup enforces the code; login returns the same token; /api/me shows it', async () => {
    assert.equal((await anon('POST', '/api/signup', { body: { email: 'x@test.dev', password: 'password1234', code: 'wrong' } })).status, 403);
    const s = await anon('POST', '/api/signup', { body: { email: 'carol@test.dev', password: 'password1234', code: ` ${SIGNUP_CODE.toUpperCase()} ` } });
    assert.equal(s.status, 200);
    assert.match(s.data.key, /^hk_/);
    assert.equal((await anon('POST', '/api/signup', { body: { email: 'carol@test.dev', password: 'password1234', code: SIGNUP_CODE } })).status, 409);
    const l = await anon('POST', '/api/login', { body: { email: 'carol@test.dev', password: 'password1234' } });
    assert.equal(l.data.key, s.data.key);
    assert.equal((await api(srv.url, s.data.key)('GET', '/api/me')).data.token, s.data.key);
    assert.equal((await anon('POST', '/api/login', { body: { email: 'carol@test.dev', password: 'wrong-pass' } })).status, 401);
  });
  test('regenerating revokes the old token immediately', async () => {
    const old = await signup(srv.url, 'dave@test.dev');
    const r = await api(srv.url, old)('POST', '/api/token/regenerate');
    assert.notEqual(r.data.token, old);
    assert.equal((await api(srv.url, old)('GET', '/api/me')).status, 401);
    assert.equal((await api(srv.url, r.data.token)('GET', '/api/me')).status, 200);
  });
  test('unknown and missing tokens are 401', async () => {
    assert.equal((await anon('GET', '/api/me')).status, 401);
    assert.equal((await api(srv.url, 'hk_not_a_real_token')('GET', '/api/me')).status, 401);
  });
  test('rate limit: the 11th login attempt from one client in a minute is 429', async () => {
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await anon('POST', '/api/login', { body: { email: 'nobody@test.dev', password: 'x' }, ip: '192.0.2.77' })).status);
    assert.deepEqual(statuses, [...Array(10).fill(401), 429]);
  });
});

describe('projects and ownership', () => {
  test('create, list, patch, and name rules', async () => {
    const c = await alice('POST', '/api/projects', { body: { slug: 'alice-app', name: 'Alice App', description: 'hi' } });
    assert.equal(c.status, 200);
    assert.equal(c.data.url, `http://alice-app.localhost:${srv.port}`);
    assert.equal(c.data.prefix, 'alice_app__');
    assert.equal((await bob('POST', '/api/projects', { body: { slug: 'alice-app' } })).status, 409);
    assert.equal((await alice('POST', '/api/projects', { body: { slug: 'Bad Name' } })).status, 400);
    assert.equal((await alice('POST', '/api/projects', { body: { slug: 'admin' } })).status, 409);
    assert.deepEqual((await alice('GET', '/api/projects')).data.map((p) => p.slug), ['alice-app']);
    const p = await alice('PATCH', '/api/projects/alice-app', { body: { unlisted: true, name: 'Renamed' } });
    assert.equal(p.data.unlisted, true);
    assert.equal(p.data.name, 'Renamed');
  });
  test('nobody else can read, change, deploy to, or delete it, including the admin', async () => {
    for (const who of [bob, adminCall]) {
      assert.equal((await who('GET', '/api/projects/alice-app')).status, 404);
      assert.equal((await who('PATCH', '/api/projects/alice-app', { body: { name: 'x' } })).status, 404);
      assert.equal((await who('PUT', '/api/projects/alice-app/schema', { body: { collections: [] } })).status, 404);
      assert.equal((await deployTo(who, 'alice-app', { 'index.html': 'pwned' })).status, 404);
      assert.equal((await who('DELETE', '/api/projects/alice-app')).status, 404);
    }
    assert.equal((await alice('GET', '/api/projects/alice-app')).status, 200);
  });
  test('per-user app limit comes from settings', async () => {
    await adminCall('PATCH', '/api/admin/settings', { body: { max_apps_per_user: 1 } });
    const r = await alice('POST', '/api/projects', { body: { slug: 'alice-two' } });
    assert.equal(r.status, 403);
    assert.match(r.data.error, /limit of 1 apps/);
    await adminCall('PATCH', '/api/admin/settings', { body: { max_apps_per_user: 10 } });
  });
});

describe('schema push against real PocketBase', () => {
  const schema = { collections: [
    { name: 'users', type: 'auth', createRule: '' },
    { name: 'posts', fields: [{ name: 'title', type: 'text' }, { name: 'color', type: 'text' }, { name: 'author', type: 'relation', collection: 'users', maxSelect: 1 }],
      listRule: '@collection.users.id ?= author', indexes: [{ columns: ['author'] }] },
  ] };
  test('creates, reads back, keeps removed fields, rejects type changes, drops explicitly', async () => {
    await bob('POST', '/api/projects', { body: { slug: 'bob-blog' } });
    const first = await bob('PUT', '/api/projects/bob-blog/schema', { body: { ...schema, hash: 'h1' } });
    assert.deepEqual(first.data, { created: ['users', 'posts'], updated: [], kept: [] });
    assert.equal((await bob('GET', '/api/projects/bob-blog')).data.schema_hash, 'h1');

    const read = (await bob('GET', '/api/projects/bob-blog/schema')).data;
    const posts = read.collections.find((c) => c.name === 'posts');
    assert.equal(posts.fields.find((f) => f.name === 'author').collection, 'users');
    assert.equal(posts.listRule, '@collection.users.id ?= author');
    assert.deepEqual(posts.indexes, [{ columns: ['author'], unique: false }]);

    const without = structuredClone(schema);
    without.collections[1].fields = without.collections[1].fields.filter((f) => f.name !== 'color');
    assert.deepEqual((await bob('PUT', '/api/projects/bob-blog/schema', { body: without })).data.kept, ['posts.color']);

    const retyped = structuredClone(schema);
    retyped.collections[1].fields[1].type = 'number';
    assert.equal((await bob('PUT', '/api/projects/bob-blog/schema', { body: retyped })).status, 400);

    assert.equal((await bob('DELETE', '/api/projects/bob-blog/schema/posts.color')).status, 200);
    assert.equal((await bob('GET', '/api/projects/bob-blog')).data.schema_hash, null, 'drop clears the hash so the next deploy re-pushes');
    const after = (await bob('GET', '/api/projects/bob-blog/schema')).data.collections.find((c) => c.name === 'posts');
    assert.ok(!after.fields.some((f) => f.name === 'color'));
  });
  test('PocketBase validation errors come back as 400 with details', async () => {
    const r = await bob('PUT', '/api/projects/bob-blog/schema', { body: { collections: [{ name: 'bad', fields: [{ name: 'n', type: 'number', min: 'abc' }] }] } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /PocketBase rejected collection "bad"|Invalid/);
  });
});

describe('gallery', () => {
  test('requires login, lists deployed listed apps with owners, hides internals', async () => {
    assert.equal((await anon('GET', '/api/gallery')).status, 401);
    await bob('POST', '/api/projects', { body: { slug: 'bob-hidden' } });
    await deployTo(bob, 'bob-blog', { 'index.html': 'blog' }, '?description=My+blog');
    await deployTo(bob, 'bob-hidden', { 'index.html': 'x' }, '?unlisted=1');
    const g = (await alice('GET', '/api/gallery')).data;
    assert.deepEqual(g.map((a) => a.slug), ['bob-blog'], 'alice-app is unlisted, undeployed apps are excluded');
    assert.equal(g[0].owner, 'bob@test.dev');
    assert.equal(g[0].description, 'My blog');
    for (const k of ['prefix', 'schema_hash', 'current_deploy']) assert.ok(!(k in g[0]), k);
  });
});

describe('admin', () => {
  test('non-admins get 403 on every admin route', async () => {
    for (const [m, p] of [['GET', '/api/admin/overview'], ['PATCH', '/api/admin/settings'], ['GET', '/api/admin/users'], ['GET', '/api/admin/apps'], ['DELETE', '/api/admin/apps/bob-blog']])
      assert.equal((await alice(m, p, { body: m === 'PATCH' ? {} : undefined })).status, 403, `${m} ${p}`);
  });
  test('overview, invite settings and validation', async () => {
    const o = (await adminCall('GET', '/api/admin/overview')).data;
    assert.equal(o.settings.signup_code, SIGNUP_CODE);
    assert.ok(o.server.users >= 3 && o.server.apps >= 1 && o.server.disk_total_bytes > 0);
    const rotated = (await adminCall('PATCH', '/api/admin/settings', { body: { rotate_code: true, open_signup: true } })).data;
    assert.notEqual(rotated.signup_code, SIGNUP_CODE);
    assert.equal((await anon('POST', '/api/signup', { body: { email: 'open@test.dev', password: 'password1234' } })).status, 200, 'open signup needs no code');
    assert.equal((await anon('GET', '/api/info')).data.open_signup, true);
    await adminCall('PATCH', '/api/admin/settings', { body: { open_signup: false } });
    assert.equal((await anon('POST', '/api/signup', { body: { email: 'late@test.dev', password: 'password1234', code: SIGNUP_CODE } })).status, 403, 'old code stops working');
    assert.equal((await adminCall('PATCH', '/api/admin/settings', { body: { max_deploy_mb: 0 } })).status, 400);
  });
  test('server name: rename shows up in /api/info and /docs.md; invalid names are refused', async () => {
    assert.equal((await adminCall('GET', '/api/admin/overview')).data.settings.server_name, 'Test Cubby', 'set from CUBBY_SERVER_NAME on first boot');
    const r = await adminCall('PATCH', '/api/admin/settings', { body: { server_name: "  Priya's   Cubby " } });
    assert.equal(r.status, 200);
    assert.equal(r.data.server_name, "Priya's Cubby");
    assert.equal((await anon('GET', '/api/info')).data.name, "Priya's Cubby");
    assert.match((await anon('GET', '/docs.md')).text, /^# Priya's Cubby: Cubby server docs/);
    for (const bad of ['', 'x'.repeat(61)]) assert.equal((await adminCall('PATCH', '/api/admin/settings', { body: { server_name: bad } })).status, 400);
    assert.equal((await alice('PATCH', '/api/admin/settings', { body: { server_name: 'Mine' } })).status, 403);
    assert.equal((await anon('GET', '/api/info')).data.name, "Priya's Cubby", 'unchanged by rejected requests');
  });
  test('users: list with app counts, disable blocks token and login, delete removes their apps', async () => {
    const users = (await adminCall('GET', '/api/admin/users')).data;
    const b = users.find((u) => u.email === 'bob@test.dev');
    assert.equal(b.apps, 2);
    assert.ok(b.disk_bytes > 0);
    const me = users.find((u) => u.email === ADMIN.email);
    assert.equal((await adminCall('PATCH', `/api/admin/users/${me.id}`, { body: { disabled: true } })).status, 400, 'cannot disable yourself');
    assert.equal((await adminCall('PATCH', '/api/admin/users/doesnotexist123', { body: { disabled: true } })).status, 404);
    assert.equal((await adminCall('DELETE', '/api/admin/users/doesnotexist123')).status, 404);

    await adminCall('PATCH', `/api/admin/users/${b.id}`, { body: { disabled: true } });
    assert.equal((await bob('GET', '/api/me')).status, 403);
    assert.equal((await anon('POST', '/api/login', { body: { email: 'bob@test.dev', password: 'password1234' } })).status, 403);
    await adminCall('PATCH', `/api/admin/users/${b.id}`, { body: { disabled: false } });
    assert.equal((await bob('GET', '/api/me')).status, 200);

    const d = await adminCall('DELETE', `/api/admin/users/${b.id}`);
    assert.deepEqual(d.data.deleted_apps.sort(), ['bob-blog', 'bob-hidden']);
    assert.equal((await bob('GET', '/api/me')).status, 401);
    assert.ok(!(await adminCall('GET', '/api/admin/apps')).data.some((a) => a.owner === 'bob@test.dev'));
  });
  test('apps: list everyone\'s apps with disk use, delete any app', async () => {
    const apps = (await adminCall('GET', '/api/admin/apps')).data;
    assert.ok(apps.some((a) => a.slug === 'alice-app' && a.owner === 'alice@test.dev' && typeof a.disk_bytes === 'number'));
    assert.equal((await adminCall('DELETE', '/api/admin/apps/alice-app')).status, 200);
    assert.equal((await alice('GET', '/api/projects/alice-app')).status, 404);
    assert.equal((await adminCall('DELETE', '/api/admin/apps/alice-app')).status, 404);
  });
});

describe('browser-approval login', () => {
  test('start → approve as a user → poll returns that user\'s token, once', async () => {
    const d = (await anon('POST', '/api/device/start')).data;
    assert.match(d.verify_url, new RegExp(`^${srv.url}/connect\\?code=`));
    assert.equal((await anon('GET', `/api/device/${d.user_code}`)).status, 200);
    assert.equal((await anon('POST', '/api/device/poll', { body: { device_id: d.device_id } })).data.status, 'pending');
    assert.equal((await anon('POST', '/api/device/approve', { body: { code: d.user_code } })).status, 401, 'approval needs a logged-in user');
    assert.equal((await alice('POST', '/api/device/approve', { body: { code: d.user_code } })).status, 200);
    const p = (await anon('POST', '/api/device/poll', { body: { device_id: d.device_id } })).data;
    assert.deepEqual(p, { status: 'approved', token: aliceToken });
    assert.equal((await anon('POST', '/api/device/poll', { body: { device_id: d.device_id } })).status, 410);
    assert.equal((await anon('GET', '/api/device/ZZZZ-ZZZZ')).status, 404);
  });
});

describe('public pages and files', () => {
  const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  test('agents and curl get the setup steps as plain text at /; browsers get the dashboard', async () => {
    const r = await anon('GET', '/', { headers: { 'user-agent': 'curl/8.7.1' } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/plain/);
    assert.equal(r.headers.get('vary'), 'User-Agent');
    const { name } = (await anon('GET', '/api/info')).data;
    assert.ok(r.text.startsWith(`${name} is a Cubby server`));
    assert.ok(r.text.includes('npx skills add chaitanyadukkipaty/cubby --skill cubby -g'));
    assert.ok(r.text.includes(`curl -fsSL ${srv.url}/skill.sh | sh`));
    assert.ok(r.text.includes(`Docs:  ${srv.url}/docs.md`));
    assert.match((await anon('GET', '/connect', { headers: { 'user-agent': 'curl/8.7.1' } })).headers.get('content-type'), /text\/html/, '/connect is only ever opened in a browser');
  });
  test('dashboard, connect page, docs, skill, CLI tarball', async () => {
    for (const p of ['/', '/connect']) {
      const r = await anon('GET', p, { headers: { 'user-agent': BROWSER_UA } });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /text\/html/);
      assert.ok(r.text.includes(srv.url), 'server URL is filled in');
      assert.doesNotMatch(r.text, /\{\{PUBLIC_URL\}\}|\{\{VERSION\}\}/);
    }
    const docs = await anon('GET', '/docs.md');
    assert.match(docs.text, new RegExp(`Server: ${srv.url}`));
    assert.doesNotMatch(docs.text, /\{\{/);
    const skill = (await anon('GET', '/skill.md')).text;
    assert.match(skill, /^---\nname: cubby/);
    assert.doesNotMatch(skill, /\{\{/);
    const sh = (await anon('GET', '/skill.sh')).text;
    assert.match(sh, new RegExp(`SERVER="${srv.url}"`));
    const { name } = (await anon('GET', '/api/info')).data;
    assert.ok(sh.includes(`const name = ${JSON.stringify(name)};`), 'the server name is embedded as a JSON literal');
    assert.doesNotMatch(sh, /\{\{/);
    const tgz = await anon('GET', '/cli.tgz');
    assert.equal(tgz.status, 200);
    assert.equal(tgz.headers.get('content-type'), 'application/gzip');
    assert.equal((await anon('GET', '/nope')).status, 404);
    assert.equal((await anon('GET', '/api/nope')).status, 404);
  });
  test('TLS check (from loopback): root domain and real apps only', async () => {
    await alice('POST', '/api/projects', { body: { slug: 'alice-tls' } });
    const check = async (d) => (await anon('GET', `/_internal/tls-check?domain=${encodeURIComponent(d)}`)).status;
    assert.equal(await check(`localhost:${srv.port}`), 200);
    assert.equal(await check(`alice-tls.localhost:${srv.port}`), 200);
    assert.equal(await check(`ghost.localhost:${srv.port}`), 404);
    assert.equal(await check('evil.com'), 404);
  });
});
