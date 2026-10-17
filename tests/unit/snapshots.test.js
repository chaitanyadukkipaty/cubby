import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSnapshot, newSnapshotId, listSnapshots, findSnapshot, pruneSnapshots, removeAppSnapshots, SNAPSHOT_ID_RE } from '../../server/src/snapshots.js';

let dataDir;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'cubby-snap-')); });
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const T = Date.parse('2026-10-17T10:15:00Z');
async function make(slug, id, meta = {}) {
  const s = await startSnapshot(dataDir, slug, id);
  await s.finish({ id, app: slug, created: '2026-10-17T10:15:00.000Z', expires: '2026-10-24T10:15:00.000Z', ...meta });
  return s;
}

describe('snapshot ids', () => {
  test('a UTC timestamp and 6 random hex digits, which sort by time', () => {
    const id = newSnapshotId(T, () => 'a1b2c3');
    assert.equal(id, '20261017T101500-a1b2c3');
    assert.match(newSnapshotId(T), SNAPSHOT_ID_RE);
    for (const bad of ['../etc', '20261017T101500-a1b2c3/..', '20261017T101500', '']) assert.doesNotMatch(bad, SNAPSHOT_ID_RE);
  });
});

describe('listing and finding', () => {
  test('lists complete snapshots of the given apps, newest first; a folder without meta.json is still being written', async () => {
    await make('shop', '20261015T090000-aaaaaa');
    await make('shop', '20261017T090000-bbbbbb');
    await make('blog', '20261016T090000-cccccc');
    await startSnapshot(dataDir, 'shop', '20261017T100000-dddddd'); // unfinished
    assert.deepEqual((await listSnapshots(dataDir, ['shop', 'blog'])).map((s) => s.id), ['20261017T090000-bbbbbb', '20261016T090000-cccccc', '20261015T090000-aaaaaa']);
    assert.deepEqual((await listSnapshots(dataDir, ['blog'])).map((s) => s.id), ['20261016T090000-cccccc']);
    assert.deepEqual(await listSnapshots(dataDir, ['nothing-here']), []);
  });
  test('finds a snapshot by id in any app; unknown ids are 404, malformed ones 400', async () => {
    await make('blog', '20261016T090000-cccccc');
    const found = await findSnapshot(dataDir, '20261016T090000-cccccc');
    assert.equal(found.meta.app, 'blog');
    assert.equal(found.dir, join(dataDir, 'snapshots', 'blog', '20261016T090000-cccccc'));
    await assert.rejects(findSnapshot(dataDir, '20261016T090000-ffffff'), (e) => e.status === 404 && /No snapshot/.test(e.message));
    await assert.rejects(findSnapshot(dataDir, '../../etc'), (e) => e.status === 400);
  });
});

describe('pruning', () => {
  test('deletes snapshots past their expiry and unfinished ones older than a day; keeps the rest', async () => {
    await make('shop', '20261001T090000-aaaaaa', { expires: '2026-10-08T09:00:00.000Z' });
    await make('shop', '20261016T090000-bbbbbb', { expires: '2026-10-23T09:00:00.000Z' });
    const stale = await startSnapshot(dataDir, 'shop', '20261010T090000-cccccc');
    const old = (T - 2 * 86_400_000) / 1000;
    utimesSync(stale.dir, old, old);
    await startSnapshot(dataDir, 'shop', '20261017T100000-dddddd'); // being written right now
    mkdirSync(join(dataDir, 'snapshots', 'empty-app'));
    assert.equal(await pruneSnapshots(dataDir, T), 2);
    assert.deepEqual((await listSnapshots(dataDir, ['shop'])).map((s) => s.id), ['20261016T090000-bbbbbb']);
    assert.ok(existsSync(join(dataDir, 'snapshots', 'shop', '20261017T100000-dddddd')));
    assert.equal(await pruneSnapshots(join(dataDir, 'missing'), T), 0);
  });
  test('deleting an app deletes all its snapshots', async () => {
    await make('shop', '20261016T090000-bbbbbb');
    await make('blog', '20261016T090000-cccccc');
    await removeAppSnapshots(dataDir, 'shop');
    assert.ok(!existsSync(join(dataDir, 'snapshots', 'shop')));
    assert.equal((await listSnapshots(dataDir, ['blog'])).length, 1);
  });
});
