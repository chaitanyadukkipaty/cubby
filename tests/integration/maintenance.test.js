// `cubby-server` maintenance tasks (server/src/admin-tasks.js) against a live PocketBase:
// backups with retention, showing the signup code, resetting a password.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import PocketBase from 'pocketbase';
import * as tar from 'tar';
import { startServer, ROOT, SIGNUP_CODE, ADMIN } from '../helpers/server.js';
import { api, signup, deployTo, adminToken } from '../helpers/integration.js';

let srv;
const task = (args, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(ROOT, 'server/src/admin-tasks.js'), ...args], { env: { ...srv.env, ...env } });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});

before(async () => {
  srv = await startServer({ BACKUP_KEEP: '2' });
  const t = await signup(srv.url, 'owner@test.dev');
  await api(srv.url, t)('POST', '/api/projects', { body: { slug: 'kept-app' } });
  await deployTo(api(srv.url, t), 'kept-app', { 'index.html': 'hi' });
  // Creates the key that decrypts app secrets, which has to be backed up with the data.
  await api(srv.url, t)('PUT', '/api/projects/kept-app/env/API_KEY', { body: { value: 'x' } });
});
after(() => srv?.stop());

describe('admin tasks', () => {
  test('code prints the current signup code', async () => {
    const r = await task(['code']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), SIGNUP_CODE);
  });
  test('backup writes a PocketBase backup and a sites tarball, replaces same-day runs, and prunes old ones', async () => {
    const pb = new PocketBase(srv.pbUrl);
    await pb.collection('_superusers').authWithPassword(srv.env.PB_SUPERUSER_EMAIL, srv.env.PB_SUPERUSER_PASSWORD);
    for (const old of ['cubby-2000-01-01.zip', 'cubby-2000-01-02.zip']) await pb.backups.create(old);
    const siteBackups = join(srv.dataDir, 'backups');
    mkdirSync(siteBackups, { recursive: true });
    for (const d of ['2000-01-01', '2000-01-02']) writeFileSync(join(siteBackups, `sites-${d}.tar.gz`), 'old');

    for (let i = 0; i < 2; i++) {
      const r = await task(['backup']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /backup \d{4}-\d{2}-\d{2} done/);
    }
    const today = new Date().toISOString().slice(0, 10);
    const keys = (await pb.backups.getFullList()).map((b) => b.key).filter((k) => k.startsWith('cubby-')).sort();
    assert.deepEqual(keys, ['cubby-2000-01-02.zip', `cubby-${today}.zip`], 'keeps the newest 2, one per day');
    assert.deepEqual(readdirSync(siteBackups).sort(), ['sites-2000-01-02.tar.gz', `sites-${today}.tar.gz`]);
    const entries = [];
    await tar.t({ file: join(siteBackups, `sites-${today}.tar.gz`), onReadEntry: (e) => entries.push(e.path) });
    assert.ok(entries.some((p) => p.startsWith('sites/kept-app/')), 'deployed sites');
    assert.ok(entries.includes('secrets/env.key'), 'the secrets key');
    assert.ok(existsSync(join(srv.dataDir, 'pb_data', 'backups', `cubby-${today}.zip`)));
  });
  test('BACKUP_KEEP seeds the retention setting; changing it decides the next prune, which removes whole pairs by date', async () => {
    const adminCall = api(srv.url, await adminToken(srv.url, ADMIN));
    assert.equal((await adminCall('GET', '/api/admin/overview')).data.settings.backup_keep, 2, 'seeded from BACKUP_KEEP on first boot');
    const patched = await adminCall('PATCH', '/api/admin/settings', { body: { backup_keep: 3 } });
    assert.equal(patched.status, 200, JSON.stringify(patched.data));
    assert.equal(patched.data.backup_keep, 3);

    // Half pairs on purpose: zips and tarballs pruned separately would keep a different set of dates.
    const pb = new PocketBase(srv.pbUrl);
    await pb.collection('_superusers').authWithPassword(srv.env.PB_SUPERUSER_EMAIL, srv.env.PB_SUPERUSER_PASSWORD);
    for (const old of ['cubby-2000-01-04.zip', 'cubby-2000-01-05.zip']) await pb.backups.create(old);
    const siteBackups = join(srv.dataDir, 'backups');
    writeFileSync(join(siteBackups, 'sites-2000-01-06.tar.gz'), 'old');

    const r = await task(['backup']);
    assert.equal(r.code, 0, r.stderr);
    const today = new Date().toISOString().slice(0, 10);
    const keys = (await pb.backups.getFullList()).map((b) => b.key).filter((k) => k.startsWith('cubby-')).sort();
    assert.deepEqual(keys, ['cubby-2000-01-05.zip', `cubby-${today}.zip`]);
    assert.deepEqual(readdirSync(siteBackups).sort(), ['sites-2000-01-06.tar.gz', `sites-${today}.tar.gz`]);
    const listed = (await adminCall('GET', '/api/admin/backups')).data;
    assert.equal(listed.keep, 3);
    assert.deepEqual(listed.backups.map((b) => b.date), [today, '2000-01-06', '2000-01-05']);
  });

  test('the nightly maintenance (backup) prunes activity older than 30 days and keeps the rest', async () => {
    const pb = new PocketBase(srv.pbUrl);
    await pb.collection('_superusers').authWithPassword(srv.env.PB_SUPERUSER_EMAIL, srv.env.PB_SUPERUSER_PASSWORD);
    const owner = await pb.collection('users').getFirstListItem('email = "owner@test.dev"');
    const day = 24 * 60 * 60 * 1000;
    const row = (summary, ago) => pb.collection('cubby_activity').create({ user: owner.id, action: 'deploy', app: 'kept-app', summary, at: new Date(Date.now() - ago).toISOString() });
    await row('ancient', 31 * day);
    await row('recent', 29 * day);
    const r = await task(['backup']);
    assert.equal(r.code, 0, r.stderr);
    const left = (await pb.collection('cubby_activity').getFullList()).map((x) => x.summary);
    assert.ok(!left.includes('ancient'), 'older than 30 days: pruned');
    assert.ok(left.includes('recent'));
    assert.ok(left.some((s) => /^Deployed /.test(s)), 'today\'s rows stay');
  });
  test('the nightly maintenance rolls metrics hours older than 30 days into their day and drops days older than a year', async () => {
    const pb = new PocketBase(srv.pbUrl);
    await pb.collection('_superusers').authWithPassword(srv.env.PB_SUPERUSER_EMAIL, srv.env.PB_SUPERUSER_PASSWORD);
    const project = await pb.collection('cubby_projects').getFirstListItem('slug = "kept-app"');
    const day = 24 * 60 * 60 * 1000;
    const dayAt = (ago) => new Date(Math.floor((Date.now() - ago * day) / day) * day);
    const rows = pb.collection('cubby_metrics');
    const old = dayAt(40);
    await rows.create({ project: project.id, period: 'day', start: old, views: 3, visitors: 2 });
    await rows.create({ project: project.id, period: 'hour', start: new Date(old.getTime() + 9 * 3_600_000), views: 3, peak_active: 2, api_requests: 7, api_errors: 1 });
    await rows.create({ project: project.id, period: 'hour', start: new Date(dayAt(1).getTime() + 3_600_000), views: 1 });
    await rows.create({ project: project.id, period: 'day', start: dayAt(400), views: 9, visitors: 9 });
    const r = await task(['backup']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /metrics: rolled 1 hourly rows into days, deleted 1 daily rows older than a year/);
    const left = await rows.getFullList({ filter: pb.filter('project = {:p}', { p: project.id }), sort: 'start' });
    assert.deepEqual(left.map((x) => [x.period, x.views, x.api_requests, x.api_errors, x.peak_active]), [['day', 3, 7, 1, 2], ['hour', 1, 0, 0, 0]]);
  });
  test('reset-password lets the user log in with the new password', async () => {
    const r = await task(['reset-password', 'owner@test.dev', 'brand-new-pass']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /password updated for owner@test.dev/);
    assert.equal((await api(srv.url)('POST', '/api/login', { body: { email: 'owner@test.dev', password: 'brand-new-pass' } })).status, 200);
    assert.equal((await api(srv.url)('POST', '/api/login', { body: { email: 'owner@test.dev', password: 'password1234' } })).status, 401);
  });
  test('bad usage fails with a message', async () => {
    const r = await task(['frobnicate']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /usage: admin-tasks\.js/);
    const short = await task(['reset-password', 'owner@test.dev', 'short']);
    assert.notEqual(short.code, 0);
    assert.match(short.stderr, /8\+ chars/);
  });
});
