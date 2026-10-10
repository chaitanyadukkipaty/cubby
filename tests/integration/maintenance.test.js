// `cubby-server` maintenance tasks (server/src/admin-tasks.js) against a live PocketBase:
// backups with retention, showing the signup code, resetting a password.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import PocketBase from 'pocketbase';
import { startServer, ROOT, SIGNUP_CODE } from '../helpers/server.js';
import { api, signup, deployTo } from '../helpers/integration.js';

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
    assert.ok(existsSync(join(srv.dataDir, 'pb_data', 'backups', `cubby-${today}.zip`)));
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
