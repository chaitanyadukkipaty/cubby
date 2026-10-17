// Admin storage breakdown and backup management (API ↔ PocketBase backups ↔ disk).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import PocketBase from 'pocketbase';
import { startServer, ADMIN } from '../helpers/server.js';
import { api, signup, adminToken, deployTo, app } from '../helpers/integration.js';

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

    // How much a different retention would save (the setting is 7 here), without changing anything.
    const preview = (await adminCall('GET', '/api/admin/backups?keep=1')).data;
    assert.equal(preview.keep, 7, 'the setting is unchanged');
    assert.deepEqual(preview.estimate, { keep: 1, backups: 2, delete: ['2000-01-01'], frees_bytes: preview.backups[1].total_bytes, adds_bytes: 0 });
    assert.equal((await adminCall('GET', '/api/admin/backups')).data.estimate.keep, 7, 'defaults to the current setting');
    assert.equal((await adminCall('GET', '/api/admin/backups?keep=0')).status, 400);

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
  test('admins delete older deploys of any app, oldest first, with their jobs folders; never the current one', async () => {
    await user('POST', '/api/projects', { body: { slug: 'pruned-app' } });
    for (const v of ['v1', 'v2', 'v3', 'v4']) await deployTo(user, 'pruned-app', { 'index.html': v.repeat(50) }, `?message=${v}`);
    const before = (await adminCall('GET', '/api/admin/apps/pruned-app/deploys')).data;
    const id = (m) => before.find((d) => d.message === m).id;
    // Roll back to v3: v4 is newer but no longer current.
    assert.equal((await user('POST', '/api/projects/pruned-app/rollback', { body: { deploy: id('v3') } })).status, 200);
    const site = join(srv.dataDir, 'sites', 'pruned-app');
    mkdirSync(join(site, `jobs-${id('v1')}`));
    writeFileSync(join(site, `jobs-${id('v1')}`, 'job.mjs'), 'x');
    assert.ok((await adminCall('GET', '/api/admin/storage')).data.breakdown.sites_older_bytes > 0, 'caches a breakdown with older deploys');

    const current = await adminCall('DELETE', `/api/admin/apps/pruned-app/deploys/${id('v3')}`);
    assert.equal(current.status, 409);
    assert.match(current.data.error, /current deploy/);

    const pruned = await adminCall('POST', '/api/admin/apps/pruned-app/deploys/prune', { body: { keep: 1 } });
    assert.equal(pruned.status, 200, JSON.stringify(pruned.data));
    assert.deepEqual(pruned.data.deleted, [id('v1'), id('v2')]);
    assert.equal(pruned.data.freed_bytes, 2 * 100 + 1);
    assert.deepEqual(pruned.data.deploys.map((d) => [d.message, d.current]), [['v4', false], ['v3', true]]);
    assert.ok(!existsSync(join(site, id('v1'))) && !existsSync(join(site, `jobs-${id('v1')}`)));
    const rollback = (await user('GET', '/api/projects/pruned-app/deploys')).data;
    assert.deepEqual(rollback.map((d) => d.message), ['v4', 'v3'], 'the owner\'s rollback list shows it too');

    const one = await adminCall('DELETE', `/api/admin/apps/pruned-app/deploys/${id('v4')}`);
    assert.equal(one.status, 200, JSON.stringify(one.data));
    assert.deepEqual(one.data.deleted, [id('v4')]);
    assert.deepEqual(one.data.deploys.map((d) => d.message), ['v3']);
    const s = (await adminCall('GET', '/api/admin/storage')).data;
    assert.equal(s.apps.find((a) => a.slug === 'pruned-app').older_deploys_bytes, 0, 'the storage cache is cleared');
    assert.equal((await app(srv, 'pruned-app')('GET', '/')).text, 'v3'.repeat(50), 'the app still serves its current deploy');

    assert.equal((await adminCall('POST', '/api/admin/apps/pruned-app/deploys/prune', { body: {} })).data.deleted.length, 0);
    assert.equal((await adminCall('POST', '/api/admin/apps/pruned-app/deploys/prune', { body: { keep: -1 } })).status, 400);
    assert.equal((await adminCall('GET', '/api/admin/apps/no-such-app/deploys')).status, 404);
    for (const [m, p] of [['GET', '/api/admin/apps/pruned-app/deploys'], ['POST', '/api/admin/apps/pruned-app/deploys/prune'], ['DELETE', `/api/admin/apps/pruned-app/deploys/${id('v3')}`]]) {
      assert.equal((await user(m, p)).status, 403, `${m} ${p}`);
    }
  });
});
