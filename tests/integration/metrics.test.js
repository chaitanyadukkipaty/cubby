// App metrics: page loads on an app host → in-memory counters → cubby_metrics → the metrics API.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startServer, hostRequest, ADMIN, ROOT } from '../helpers/server.js';
import { api, signup, adminToken, deployTo, app } from '../helpers/integration.js';

const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';
let srv, alice, aliceToken, bob;
// A page load as a person's browser makes it, from a given client IP (trusted from loopback, like behind Caddy).
const load = (slug, path, ip, ua = BROWSER) => app(srv, slug)('GET', path, { headers: { 'user-agent': ua, 'x-forwarded-for': ip } });

before(async () => {
  srv = await startServer();
  aliceToken = await signup(srv.url, 'alice-metrics@test.dev');
  alice = api(srv.url, aliceToken);
  bob = api(srv.url, await signup(srv.url, 'bob-metrics@test.dev'));
  assert.equal((await alice('POST', '/api/projects', { body: { slug: 'counted' } })).status, 200);
  const d = await deployTo(alice, 'counted', { 'index.html': '<h1>hi</h1>', 'assets/app.js': 'console.log(1)' });
  assert.equal(d.status, 200);
});
after(() => srv?.stop());

describe('counting', () => {
  test('page loads count as views, assets do not', async () => {
    assert.equal((await load('counted', '/', '203.0.113.1')).status, 200);
    assert.equal((await load('counted', '/polls/7', '203.0.113.1')).status, 200); // SPA route
    assert.equal((await load('counted', '/assets/app.js', '203.0.113.1')).status, 200);
    const r = await alice('GET', '/api/projects/counted/metrics');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.app, 'counted');
    assert.equal(r.data.range, '24h');
    assert.equal(r.data.views, 2);
    assert.equal(r.data.hours.length, 24);
  });
  test('the same visitor counts once a day; bots and HEAD requests are not counted', async () => {
    await load('counted', '/', '203.0.113.1');
    await load('counted', '/', '203.0.113.2');
    await load('counted', '/', '203.0.113.3', 'Mozilla/5.0 (compatible; Googlebot/2.1)');
    await load('counted', '/', '203.0.113.4', 'curl/8.7.1');
    await app(srv, 'counted')('HEAD', '/', { headers: { 'user-agent': BROWSER, 'x-forwarded-for': '203.0.113.5' } });
    const r = await alice('GET', '/api/projects/counted/metrics');
    assert.deepEqual([r.data.views, r.data.visitors], [4, 2]);
    assert.equal(r.data.days.at(-1).visitors, 2);
  });
});

describe('cubby metrics', () => {
  // The real CLI entry point, logged in through CUBBY_TOKEN, run from an empty folder (no cubby.json).
  const cubby = (args, token = aliceToken) => new Promise((resolve) => {
    const home = mkdtempSync(join(tmpdir(), 'cubby-metrics-home-'));
    const child = spawn(process.execPath, [join(ROOT, 'cli/src/launcher.js'), ...args], {
      cwd: home, env: { ...process.env, HOME: home, CUBBY_TOKEN: token, CUBBY_SERVER: srv.url, CUBBY_CLIENT: '' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch { return null; } })() });
    });
  });

  test('`cubby metrics <app> --json` returns views and visitors', async () => {
    const r = await cubby(['metrics', 'counted', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.json.app, r.json.range, r.json.views, r.json.visitors], ['counted', '24h', 4, 2]);
    // The page loads above were the only traffic: two people (bots aren't), no API calls, no auth collection.
    assert.deepEqual([r.json.active_now, r.json.peak_active, r.json.api_requests, r.json.api_errors, r.json.accounts.total], [2, 2, 0, 0, 0]);
    const week = await cubby(['metrics', 'counted', '--range', '7d', '--json']);
    assert.equal(week.json.hours.length, 168);
  });
  test('without an app it lists all your apps; text output is readable', async () => {
    const r = await cubby(['metrics', '--json']);
    assert.deepEqual(r.json.map((a) => [a.app, a.views, a.visitors]), [['counted', 4, 2]]);
    assert.match((await cubby(['metrics'])).stdout, /counted\s+4 views\s+2 visitors/);
    const text = (await cubby(['metrics', 'counted'])).stdout;
    assert.match(text, /^counted: 4 views, 2 visitors in the last 24h\n {2}Active now 2, peak 2\n {2}API: 0 requests, 0 errors \(0\.0%\)\n {2}Accounts: 0, 0 new\n/);
  });
  test('`--all` is for admins: totals across every app and the busiest apps', async () => {
    const refused = await cubby(['metrics', '--all', '--json']);
    assert.equal(refused.code, 1);
    assert.match(refused.json.error, /admins only/i);
    const token = await adminToken(srv.url, ADMIN);
    const r = await cubby(['metrics', '--all', '--json'], token);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.json.range, r.json.views, r.json.visitors, r.json.apps], ['24h', 4, 2, 1]);
    assert.deepEqual(r.json.top_apps.map((a) => [a.app, a.owner, a.views]), [['counted', 'alice-metrics@test.dev', 4]]);
    assert.match((await cubby(['metrics', '--all'], token)).stdout, /All apps: 4 views, 2 visitors in the last 24h[\s\S]*counted\s+4 views/);
  });
  test('errors are clear: someone else\'s app, a bad range', async () => {
    const r = await cubby(['metrics', 'bobs-app', '--json']);
    assert.equal(r.code, 1);
    assert.match(r.json.error, /not found in your account/);
    assert.match((await cubby(['metrics', '--range', 'week'])).stderr, /like 1h, 24h, 7d/);
  });
});

describe('persistence', () => {
  test('counts survive a restart: a clean shutdown flushes them, and no IP is stored', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cubby-metrics-'));
    try {
      let s = await startServer({ DATA_DIR: dataDir });
      const token = await signup(s.url, 'restart-metrics@test.dev');
      const owner = api(s.url, token);
      await owner('POST', '/api/projects', { body: { slug: 'durable' } });
      await deployTo(owner, 'durable', { 'index.html': '<h1>hi</h1>' });
      await hostRequest(s.port, `durable.localhost:${s.port}`, 'GET', '/', { headers: { 'user-agent': BROWSER, 'x-forwarded-for': '198.51.100.77' } });
      await s.stop(); // well within the 60s flush interval
      s = await startServer({ DATA_DIR: dataDir });
      try {
        const r = await api(s.url, token)('GET', '/api/projects/durable/metrics');
        assert.deepEqual([r.data.views, r.data.visitors], [1, 1]);
        const db = readFileSync(join(dataDir, 'pb_data', 'data.db'));
        assert.ok(!db.includes('198.51.100.77'), 'raw IP stored');
      } finally {
        await s.stop();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('who sees metrics', () => {
  test('owners only: another user gets a 404, an admin can look', async () => {
    assert.equal((await bob('GET', '/api/projects/counted/metrics')).status, 404);
    assert.equal((await api(srv.url)('GET', '/api/projects/counted/metrics')).status, 401);
    const admin = api(srv.url, await adminToken(srv.url, ADMIN));
    const r = await admin('GET', '/api/projects/counted/metrics?range=7d');
    assert.equal(r.status, 200);
    assert.deepEqual([r.data.range, r.data.hours.length, r.data.views], ['7d', 168, 4]);
    assert.equal((await admin('GET', '/api/projects/nope/metrics')).status, 404);
  });
  test('/api/admin/metrics is for admins only', async () => {
    assert.equal((await bob('GET', '/api/admin/metrics')).status, 403);
    const admin = api(srv.url, await adminToken(srv.url, ADMIN));
    const r = await admin('GET', '/api/admin/metrics?range=7d');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.range, '7d');
    assert.ok(r.data.top_apps.length <= 10);
  });
  test('/api/metrics lists your own apps only', async () => {
    assert.equal((await bob('POST', '/api/projects', { body: { slug: 'bobs-app' } })).status, 200);
    const mine = await alice('GET', '/api/metrics');
    assert.deepEqual(mine.data.map((a) => [a.app, a.views, a.visitors]), [['counted', 4, 2]]);
    assert.deepEqual((await bob('GET', '/api/metrics')).data.map((a) => [a.app, a.views]), [['bobs-app', 0]]);
    assert.equal((await alice('GET', '/api/metrics?range=week')).status, 400);
  });
  test("/api/metrics has each app's views and visitors per UTC day, matching its own report", async () => {
    const [list, own] = await Promise.all([alice('GET', '/api/metrics?range=7d'), alice('GET', '/api/projects/counted/metrics?range=7d')]);
    const row = list.data.find((a) => a.app === 'counted');
    assert.deepEqual(row.days, own.data.days.map(({ start, views, visitors }) => ({ start, views, visitors })));
    assert.ok(row.days.length >= 7);
    assert.equal(row.days.reduce((n, d) => n + d.views, 0), 4);
    assert.equal(row.hours, undefined, 'the list stays compact');
  });
});

// Active now, API health and accounts, on a server of their own: its clock can be moved forward, and a PocketBase
// hook gives the app a route that fails with a 500.
describe('active now, API health and accounts', () => {
  let live, dataDir, clockFile, owner, liveApp;
  const json = { 'content-type': 'application/json' };
  const report = async () => {
    const r = await owner('GET', '/api/projects/live/metrics');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cubby-metrics-live-'));
    mkdirSync(join(dataDir, 'pb_hooks'));
    writeFileSync(join(dataDir, 'pb_hooks', 'fail.pb.js'), 'routerAdd("GET", "/api/collections/live__boom/fail", (e) => e.json(500, { message: "boom" }));\n');
    clockFile = join(dataDir, 'clock-offset');
    writeFileSync(clockFile, '0');
    live = await startServer({ DATA_DIR: dataDir, CUBBY_TEST_CLOCK_FILE: clockFile });
    owner = api(live.url, await signup(live.url, 'live-owner@test.dev'));
    assert.equal((await owner('POST', '/api/projects', { body: { slug: 'live' } })).status, 200);
    assert.equal((await owner('PUT', '/api/projects/live/schema', { body: { collections: [{ name: 'users', type: 'auth', createRule: '' }] } })).status, 200);
    assert.equal((await deployTo(owner, 'live', { 'index.html': '<h1>live</h1>' })).status, 200);
    liveApp = app(live, 'live');
  });
  after(async () => {
    await live?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('every /pb response counts as an API request, and a 5xx from PocketBase as an error', async () => {
    assert.equal((await liveApp('GET', '/pb/api/health')).status, 200);
    assert.equal((await liveApp('GET', '/pb/api/collections/live__boom/fail')).status, 500);
    assert.equal((await liveApp('GET', '/pb/api/collections/users/records')).status, 403); // refused by the proxy
    const r = await report();
    assert.deepEqual([r.api_requests, r.api_errors], [3, 1]);
    assert.ok(Math.abs(r.api_error_rate - 1 / 3) < 1e-9);
    assert.deepEqual([r.hours.at(-1).api_requests, r.hours.at(-1).api_errors], [3, 1]);
  });
  test('accounts are the app\'s own users, with new signups in the range', async () => {
    for (const email of ['ann@live.test', 'ben@live.test']) {
      const body = { email, password: 'password1234', passwordConfirm: 'password1234' };
      assert.equal((await liveApp('POST', '/pb/api/collections/live__users/records', { body, headers: json })).status, 200);
    }
    const { accounts } = await report();
    assert.deepEqual([accounts.total, accounts.new, accounts.days.at(-1).signups], [2, 2, 2]);
  });
  test('active now counts people on pages and on /pb, then drops to 0 after 5 minutes without traffic', async () => {
    await liveApp('GET', '/', { headers: { 'user-agent': BROWSER, 'x-forwarded-for': '203.0.113.20' } });
    await liveApp('GET', '/pb/api/health', { headers: { 'user-agent': BROWSER, 'x-forwarded-for': '203.0.113.21' } });
    await liveApp('GET', '/pb/api/health', { headers: { 'user-agent': 'curl/8.7.1', 'x-forwarded-for': '203.0.113.22' } }); // not a person
    let r = await report();
    assert.deepEqual([r.active_now, r.peak_active], [2, 2]);
    writeFileSync(clockFile, String(5 * 60_000));
    r = await report();
    assert.deepEqual([r.active_now, r.peak_active], [0, 2], 'the peak stays');
  });
  test('a report lists the most viewed paths (without query strings) and the deploys in its range', async () => {
    const page = (path) => liveApp('GET', path, { headers: { 'user-agent': BROWSER, 'x-forwarded-for': '203.0.113.30' } });
    await page('/polls/7?ref=mail');
    await page('/polls/7');
    const r = await report();
    assert.deepEqual(r.top_paths.find((p) => p.path === '/polls/7'), { path: '/polls/7', views: 2 });
    assert.ok(r.top_paths.every((p) => !p.path.includes('?')));
    assert.equal(r.deploys.length, 1);
    assert.deepEqual(Object.keys(r.deploys[0]).sort(), ['created', 'id', 'message']);
  });
  test('deleting the app deletes its metrics', async () => {
    const { default: PocketBase } = await import('pocketbase');
    const pb = new PocketBase(live.pbUrl);
    await pb.collection('_superusers').authWithPassword(live.env.PB_SUPERUSER_EMAIL, live.env.PB_SUPERUSER_PASSWORD);
    assert.equal((await owner('POST', '/api/projects', { body: { slug: 'doomed' } })).status, 200);
    await deployTo(owner, 'doomed', { 'index.html': 'x' });
    await app(live, 'doomed')('GET', '/', { headers: { 'user-agent': BROWSER, 'x-forwarded-for': '203.0.113.31' } });
    const id = (await owner('GET', '/api/projects/doomed')).data.id;
    await owner('GET', '/api/projects/doomed/metrics'); // flushes
    const rows = () => pb.collection('cubby_metrics').getFullList({ filter: pb.filter('project = {:id}', { id }) });
    assert.ok((await rows()).length > 0);
    assert.equal((await owner('DELETE', '/api/projects/doomed')).status, 200);
    assert.equal((await rows()).length, 0);
  });
  test('only the owner sees them', async () => {
    const stranger = api(live.url, await signup(live.url, 'live-stranger@test.dev'));
    assert.equal((await stranger('GET', '/api/projects/live/metrics')).status, 404);
  });
});
