import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pairBackups, checkBackupDelete, createTtlCache, scanStorage, planRetention } from '../../server/src/storage.js';

describe('scanStorage', () => {
  // Writes { 'relative/path': byteCount } under a fresh dir.
  function dataDir(files) {
    const dir = mkdtempSync(join(tmpdir(), 'cubby-storage-'));
    for (const [p, n] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), 'x'.repeat(n));
    }
    return dir;
  }
  test('splits the data dir into database, uploads, current and older deploys, backups, snapshots and other, plus per app', async () => {
    const dir = dataDir({
      'pb_data/data.db': 1000,
      'pb_data/auxiliary.db': 100,
      'pb_data/backups/cubby-2026-10-01.zip': 500,
      'pb_data/storage/colA/rec1/photo.png': 40,
      'pb_data/storage/colB/rec2/doc.pdf': 30,
      'pb_data/storage/platformCol/rec3/x': 7,
      'sites/blog/d2/index.html': 20,
      'sites/blog/jobs-d2/job.mjs': 5,
      'sites/blog/d1/index.html': 10,
      'sites/blog/jobs-d1/job.mjs': 3,
      'sites/gone/d9/index.html': 2,
      'backups/sites-2026-10-01.tar.gz': 50,
      'secrets/env.key': 32,
      'tmp/upload': 1,
      'snapshots/blog/20261017T101500-a1b2c3/records/posts.jsonl': 60,
      'snapshots/gone/20261017T101500-ffffff/meta.json': 4,
    });
    try {
      const s = await scanStorage(dir, [
        { slug: 'blog', owner: 'a@x.dev', current_deploy: 'd2', collectionIds: ['colA', 'colB'] },
        { slug: 'empty', owner: 'b@x.dev', current_deploy: null, collectionIds: [] },
      ]);
      assert.deepEqual(s.breakdown, {
        database_bytes: 1100, uploads_bytes: 77, sites_current_bytes: 25, sites_older_bytes: 15, backups_bytes: 550, snapshots_bytes: 64, other_bytes: 33,
      });
      assert.equal(s.data_bytes, 1100 + 77 + 25 + 15 + 550 + 64 + 33);
      assert.deepEqual(s.apps, [
        { slug: 'blog', owner: 'a@x.dev', total_bytes: 168, current_deploy_bytes: 25, older_deploys_bytes: 13, uploads_bytes: 70, snapshots_bytes: 60 },
        { slug: 'empty', owner: 'b@x.dev', total_bytes: 0, current_deploy_bytes: 0, older_deploys_bytes: 0, uploads_bytes: 0, snapshots_bytes: 0 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('a data dir that does not exist yet scans to zeros, biggest apps first', async () => {
    const s = await scanStorage(join(tmpdir(), 'cubby-storage-missing-' + process.pid), [
      { slug: 'b', owner: null, current_deploy: null, collectionIds: [] },
      { slug: 'a', owner: null, current_deploy: null, collectionIds: [] },
    ]);
    assert.equal(s.data_bytes, 0);
    assert.deepEqual(s.apps.map((a) => a.slug), ['a', 'b']);
  });
});

describe('createTtlCache', () => {
  test('computes once, serves the result until the TTL passes, then computes again', async () => {
    let clock = 0;
    let calls = 0;
    const cache = createTtlCache(1000, () => clock);
    const compute = async () => ++calls;
    assert.equal(await cache.get(compute), 1);
    clock = 999;
    assert.equal(await cache.get(compute), 1);
    clock = 1000;
    assert.equal(await cache.get(compute), 2);
  });
  test('clear() forces the next get to compute again', async () => {
    let calls = 0;
    const cache = createTtlCache(1000, () => 0);
    await cache.get(async () => ++calls);
    cache.clear();
    assert.equal(await cache.get(async () => ++calls), 2);
  });
  test('a failed computation is not cached', async () => {
    const cache = createTtlCache(1000, () => 0);
    await assert.rejects(cache.get(async () => { throw new Error('disk gone'); }), /disk gone/);
    assert.equal(await cache.get(async () => 'ok'), 'ok');
  });
});

const b = (date) => ({ date, db_bytes: 1, sites_bytes: 1, total_bytes: 2, complete: true });

describe('checkBackupDelete', () => {
  test('refuses to delete the only backup without leaveNone', () => {
    assert.throws(() => checkBackupDelete([b('2026-10-01')], '2026-10-01'), (e) => e.status === 409 && /only backup/.test(e.message) && /--leave-none/.test(e.message));
    assert.match(checkBackupDelete([b('2026-10-01')], '2026-10-01', { leaveNone: true }).warning, /no backups left/);
  });
  test('deleting the newest backup warns and names the new latest one; older ones need no warning', () => {
    const list = [b('2026-10-03'), b('2026-10-02'), b('2026-10-01')];
    assert.match(checkBackupDelete(list, '2026-10-03').warning, /newest backup.*2026-10-02/);
    assert.equal(checkBackupDelete(list, '2026-10-02').warning, null);
  });
  test('a date with no backup is 404; anything that is not a date is 400', () => {
    const list = [b('2026-10-02'), b('2026-10-01')];
    assert.throws(() => checkBackupDelete(list, '2026-09-30'), (e) => e.status === 404 && /No backup for 2026-09-30/.test(e.message));
    for (const bad of ['../etc', '2026-10-1', 'latest', '']) assert.throws(() => checkBackupDelete(list, bad), (e) => e.status === 400, bad);
  });
  test('nothing is deleted while a backup is running', () => {
    assert.throws(() => checkBackupDelete([b('2026-10-02'), b('2026-10-01')], '2026-10-01', { running: true }), (e) => e.status === 409 && /running/.test(e.message));
  });
});

describe('pairBackups', () => {
  test('pairs the database zip and the sites tarball of each date, newest first', () => {
    const list = pairBackups(
      [{ key: 'cubby-2026-10-01.zip', size: 100 }, { key: 'cubby-2026-10-02.zip', size: 200 }],
      [{ name: 'sites-2026-10-02.tar.gz', size: 20 }, { name: 'sites-2026-10-01.tar.gz', size: 10 }],
    );
    assert.deepEqual(list, [
      { date: '2026-10-02', db_bytes: 200, sites_bytes: 20, total_bytes: 220, complete: true },
      { date: '2026-10-01', db_bytes: 100, sites_bytes: 10, total_bytes: 110, complete: true },
    ]);
  });
  test('lists a half pair (one file missing) and ignores files that are not backups', () => {
    const list = pairBackups(
      [{ key: 'cubby-2026-10-03.zip', size: 300 }, { key: 'pb_manual.zip', size: 1 }],
      [{ name: 'sites-2026-10-01.tar.gz', size: 10 }, { name: 'notes.txt', size: 1 }],
    );
    assert.deepEqual(list, [
      { date: '2026-10-03', db_bytes: 300, sites_bytes: null, total_bytes: 300, complete: false },
      { date: '2026-10-01', db_bytes: null, sites_bytes: 10, total_bytes: 10, complete: false },
    ]);
  });
});

describe('planRetention', () => {
  const pair = (date, db, sites) => ({ date, db_bytes: db, sites_bytes: sites, total_bytes: (db ?? 0) + (sites ?? 0), complete: db !== null && sites !== null });
  // Newest first, as listBackups returns them. The 10-02 database zip is missing.
  const list = [pair('2026-10-04', 400, 40), pair('2026-10-03', 300, 30), pair('2026-10-02', null, 20), pair('2026-10-01', 100, 10)];
  test('deletes whole pairs by date beyond the newest N, and says how much that frees', () => {
    assert.deepEqual(planRetention(list, 2), { keep: 2, backups: 4, delete: ['2026-10-02', '2026-10-01'], frees_bytes: 130, adds_bytes: 0 });
    assert.deepEqual(planRetention(list, 4).delete, []);
  });
  test('keeping more than exist frees nothing and estimates the growth from the average backup', () => {
    // Average backup: (440 + 330 + 20 + 110) / 4 = 225; two more of them.
    assert.deepEqual(planRetention(list, 6), { keep: 6, backups: 4, delete: [], frees_bytes: 0, adds_bytes: 450 });
    assert.deepEqual(planRetention([], 7), { keep: 7, backups: 0, delete: [], frees_bytes: 0, adds_bytes: 0 });
  });
});
