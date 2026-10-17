// Admin storage breakdown and backup management (API ↔ PocketBase backups ↔ disk).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import PocketBase from 'pocketbase';
import { startServer, ADMIN } from '../helpers/server.js';
import { api, signup, adminToken, deployTo } from '../helpers/integration.js';

let srv, adminCall, user;

before(async () => {
  srv = await startServer();
  adminCall = api(srv.url, await adminToken(srv.url, ADMIN));
  user = api(srv.url, await signup(srv.url, 'storage-user@test.dev'));
});
after(() => srv?.stop());

// Polls the backup list until no backup is running.
async function waitForBackup() {
  for (let i = 0; i < 200; i++) {
    const r = (await adminCall('GET', '/api/admin/backups')).data;
    if (!r.running) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('backup did not finish');
}

describe('admin storage and backups', () => {
  test('non-admins get 403 on every storage and backup route', async () => {
    for (const [m, p] of [['GET', '/api/admin/storage'], ['GET', '/api/admin/backups'], ['POST', '/api/admin/backups'], ['DELETE', '/api/admin/backups/2026-10-01']]) {
      assert.equal((await user(m, p)).status, 403, `${m} ${p}`);
    }
  });
  test('storage shows the database, current and older deploys per app, and the disk', async () => {
    await user('POST', '/api/projects', { body: { slug: 'sized-app' } });
    await deployTo(user, 'sized-app', { 'index.html': 'old'.repeat(100) });
    await deployTo(user, 'sized-app', { 'index.html': 'new'.repeat(1000) });
    const s = (await adminCall('GET', '/api/admin/storage')).data;
    assert.ok(s.breakdown.database_bytes > 0, 'pb_data');
    assert.equal(s.breakdown.sites_current_bytes, 3000);
    assert.equal(s.breakdown.sites_older_bytes, 300);
    assert.ok(s.disk.total_bytes > 0 && s.disk.free_bytes > 0);
    assert.ok(s.data_bytes >= s.breakdown.database_bytes + 3300);
    assert.deepEqual(s.apps.find((a) => a.slug === 'sized-app'), {
      slug: 'sized-app', owner: 'storage-user@test.dev', total_bytes: 3300, current_deploy_bytes: 3000, older_deploys_bytes: 300, uploads_bytes: 0,
    });
    assert.match(s.computed_at, /^\d{4}-\d{2}-\d{2}T/);
  });
  test('back up now runs in the background and adds a pair named the way cubby-server expects', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const started = await adminCall('POST', '/api/admin/backups');
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.equal(started.data.started, true);
    assert.equal(started.data.date, today);
    const r = await waitForBackup();
    assert.equal(r.last.ok, true, r.last.error);
    const b = r.backups.find((x) => x.date === today);
    assert.ok(b?.complete, JSON.stringify(r.backups));
    assert.ok(b.db_bytes > 0 && b.sites_bytes > 0);
    assert.equal(b.total_bytes, b.db_bytes + b.sites_bytes);
    assert.ok(existsSync(join(srv.dataDir, 'pb_data', 'backups', `cubby-${today}.zip`)));
    assert.ok(existsSync(join(srv.dataDir, 'backups', `sites-${today}.tar.gz`)));
    const s = (await adminCall('GET', '/api/admin/storage')).data;
    assert.ok(s.breakdown.backups_bytes >= b.total_bytes, 'the storage cache is refreshed after a backup');
  });
  test('delete removes both files of a pair, warns about the newest, and refuses the only backup without leave_none', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const pb = new PocketBase(srv.pbUrl);
    await pb.collection('_superusers').authWithPassword(srv.env.PB_SUPERUSER_EMAIL, srv.env.PB_SUPERUSER_PASSWORD);
    for (const d of ['2000-01-01', '2000-01-02']) {
      await pb.backups.create(`cubby-${d}.zip`);
      writeFileSync(join(srv.dataDir, 'backups', `sites-${d}.tar.gz`), 'old');
    }
    const dates = async () => (await adminCall('GET', '/api/admin/backups')).data.backups.map((b) => b.date);
    assert.deepEqual(await dates(), [today, '2000-01-02', '2000-01-01']);

    const newest = await adminCall('DELETE', `/api/admin/backups/${today}`);
    assert.equal(newest.status, 200, JSON.stringify(newest.data));
    assert.deepEqual(newest.data.files, [`cubby-${today}.zip`, `sites-${today}.tar.gz`]);
    assert.match(newest.data.warning, /newest backup.*2000-01-02/);
    assert.ok(!existsSync(join(srv.dataDir, 'pb_data', 'backups', `cubby-${today}.zip`)));
    assert.ok(!existsSync(join(srv.dataDir, 'backups', `sites-${today}.tar.gz`)));

    const older = await adminCall('DELETE', '/api/admin/backups/2000-01-01');
    assert.equal(older.data.warning, null);
    assert.deepEqual(await dates(), ['2000-01-02']);

    const only = await adminCall('DELETE', '/api/admin/backups/2000-01-02');
    assert.equal(only.status, 409);
    assert.match(only.data.error, /only backup/);
    assert.deepEqual(await dates(), ['2000-01-02'], 'nothing was deleted');
    const confirmed = await adminCall('DELETE', '/api/admin/backups/2000-01-02?leave_none=1');
    assert.equal(confirmed.status, 200);
    assert.match(confirmed.data.warning, /no backups left/);
    assert.deepEqual(await dates(), []);
    assert.equal((await adminCall('DELETE', '/api/admin/backups/2000-01-02')).status, 404);
    assert.equal((await adminCall('DELETE', '/api/admin/backups/latest')).status, 400);
  });
});
