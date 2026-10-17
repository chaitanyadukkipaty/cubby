// App metrics: page loads on an app host → in-memory counters → cubby_metrics → the metrics API.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  const cubby = (args) => new Promise((resolve) => {
    const home = mkdtempSync(join(tmpdir(), 'cubby-metrics-home-'));
    const child = spawn(process.execPath, [join(ROOT, 'cli/src/launcher.js'), ...args], {
      cwd: home, env: { ...process.env, HOME: home, CUBBY_TOKEN: aliceToken, CUBBY_SERVER: srv.url, CUBBY_CLIENT: '' },
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
    const week = await cubby(['metrics', 'counted', '--range', '7d', '--json']);
    assert.equal(week.json.hours.length, 168);
  });
  test('without an app it lists all your apps; text output is readable', async () => {
    const r = await cubby(['metrics', '--json']);
    assert.deepEqual(r.json.map((a) => [a.app, a.views, a.visitors]), [['counted', 4, 2]]);
    assert.match((await cubby(['metrics'])).stdout, /counted\s+4 views\s+2 visitors/);
    assert.match((await cubby(['metrics', 'counted'])).stdout, /^counted: 4 views, 2 visitors in the last 24h/);
  });
  test('errors are clear: someone else\'s app, a bad range', async () => {
    const r = await cubby(['metrics', 'bobs-app', '--json']);
    assert.equal(r.code, 1);
    assert.match(r.json.error, /not found in your account/);
    assert.match((await cubby(['metrics', '--range', 'week'])).stderr, /like 24h or 7d/);
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
  test('/api/metrics lists your own apps only', async () => {
    assert.equal((await bob('POST', '/api/projects', { body: { slug: 'bobs-app' } })).status, 200);
    const mine = await alice('GET', '/api/metrics');
    assert.deepEqual(mine.data.map((a) => [a.app, a.views, a.visitors]), [['counted', 4, 2]]);
    assert.deepEqual((await bob('GET', '/api/metrics')).data.map((a) => [a.app, a.views]), [['bobs-app', 0]]);
    assert.equal((await alice('GET', '/api/metrics?range=week')).status, 400);
  });
});
