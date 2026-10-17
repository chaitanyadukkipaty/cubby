// Unit tests for the app Data tab's view model (server/public/js/data-view.js): what's ticked, the request a form
// makes, the mandatory preview, when the destructive button unlocks, restore drift and the admin-clear banner.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as v from '../../server/public/js/data-view.js';

test('the data-view module has no DOM state, network access or imports beyond pure modules', () => {
  const src = readFileSync(new URL('../../server/public/js/data-view.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bfetch\(|localStorage|location\.|document\.|window\./);
  for (const m of src.matchAll(/^import .* from '(.*)';$/gm)) assert.match(m[1], /^\.\/(helpers|routes)\.js$/);
});

describe('defaultSelection()', () => {
  test("every collection is ticked except the app's user accounts", () => {
    const cols = [{ name: 'tasks', type: 'base' }, { name: 'users', type: 'auth' }, { name: 'notes', type: 'base' }];
    assert.deepEqual(v.defaultSelection(cols), ['tasks', 'notes']);
  });
});

describe('createdBefore()', () => {
  test('a date from the date picker becomes a filter on created, at the start of that UTC day', () => {
    assert.equal(v.createdBefore('2026-10-01'), 'created < "2026-10-01 00:00:00.000Z"');
  });
  test('anything else is no filter', () => {
    for (const d of ['', '2026-1-1', 'yesterday', '2026-10-01" || true || "', null]) assert.equal(v.createdBefore(d), null, d);
  });
});

describe('clearRequest()', () => {
  test('whole collections: emptied, or dropped', () => {
    assert.deepEqual(v.clearRequest({ scope: 'collections', names: ['tasks', 'notes'] }), { body: { collections: ['tasks', 'notes'] } });
    assert.deepEqual(v.clearRequest({ scope: 'collections', names: ['tasks'], drop: true }), { body: { collections: ['tasks'], drop: true } });
  });
  test('records of one collection by filter (trimmed) or by the ids ticked in the browser', () => {
    assert.deepEqual(v.clearRequest({ scope: 'filter', collection: 'tasks', filter: '  done = true ' }), { body: { collection: 'tasks', filter: 'done = true' } });
    assert.deepEqual(v.clearRequest({ scope: 'ids', collection: 'tasks', ids: ['a', 'b'] }), { body: { collection: 'tasks', ids: ['a', 'b'] } });
  });
  test('more than 10,000 matches confirmed, and an admin\'s reason, go along', () => {
    assert.deepEqual(v.clearRequest({ scope: 'filter', collection: 'tasks', filter: 'x = 1', allMatching: true, reason: ' spam ' }),
      { body: { collection: 'tasks', filter: 'x = 1', all_matching: true, reason: 'spam' } });
  });
  test('says what is missing instead of making a request', () => {
    assert.deepEqual(v.clearRequest({ scope: 'collections', names: [] }), { error: 'Tick at least one collection.' });
    assert.deepEqual(v.clearRequest({ scope: 'filter', collection: 'tasks', filter: ' ' }), { error: 'Write a filter, or pick a date.' });
    assert.deepEqual(v.clearRequest({ scope: 'filter', filter: 'x = 1' }), { error: 'Pick the collection to delete records from.' });
    assert.deepEqual(v.clearRequest({ scope: 'ids', collection: 'tasks', ids: [] }), { error: 'Tick the records to delete.' });
  });
});

describe('previewModel()', () => {
  const base = { dry_run: true, cascade: [], warnings: [], files: true, files_bytes: 0, samples: [] };
  test('a filter: matches N of M records, in which collection', () => {
    const p = v.previewModel({ ...base, mode: 'filter', collections: [{ name: 'tasks', records: 12 }], matches: 12, total: 40, filter: 'done = true' });
    assert.equal(p.headline, 'Matches 12 of 40 records in tasks.');
    assert.equal(p.nothing, false);
  });
  test('ids that are gone already are counted', () => {
    const p = v.previewModel({ ...base, mode: 'ids', collections: [{ name: 'tasks', records: 2 }], matches: 2, total: 40, missing: ['zz'] });
    assert.equal(p.headline, 'Matches 2 of 40 records in tasks. 1 of the ticked records is gone already.');
  });
  test('whole collections: emptied or dropped, with their record count and uploaded files', () => {
    const cols = [{ name: 'tasks', records: 50 }, { name: 'notes', records: 1 }];
    assert.equal(v.previewModel({ ...base, mode: 'empty', collections: cols, matches: 51, total: 51 }).headline, 'Empties tasks and notes: 51 records.');
    assert.equal(v.previewModel({ ...base, mode: 'drop', collections: cols.slice(1), matches: 1, total: 1, files_bytes: 2048 }).headline,
      'Drops notes (the collection, its fields and rules): 1 record, plus 2 KB of uploaded files.');
    assert.equal(v.previewModel({ ...base, mode: 'drop', wipe: true, collections: cols, matches: 51, total: 51 }).headline,
      'Wipes the database: drops tasks and notes, 51 records.');
  });
  test('records of other collections pointing at what goes: deleted by cascade, or losing the reference', () => {
    const p = v.previewModel({ ...base, mode: 'empty', collections: [{ name: 'tasks', records: 3 }], matches: 3, total: 3, cascade: [
      { collection: 'comments', field: 'task', records: 4, deletes: true },
      { collection: 'tags', field: 'tasks', records: 1, deletes: false },
      { collection: 'logs', field: 'task', records: 0, deletes: true },
    ] });
    assert.deepEqual(p.cascade, [
      '4 records of comments go too: their task relation deletes on cascade.',
      '1 record of tags loses its tasks reference.',
    ]);
  });
  test('nothing matching, and more than 10,000 matches, are called out', () => {
    assert.equal(v.previewModel({ ...base, mode: 'filter', collections: [{ name: 'tasks', records: 0 }], matches: 0, total: 9 }).nothing, true);
    assert.equal(v.previewModel({ ...base, mode: 'empty', collections: [{ name: 'tasks', records: 10001 }], matches: 10001, total: 10001 }).big, true);
    assert.equal(v.previewModel({ ...base, mode: 'empty', collections: [{ name: 'tasks', records: 10000 }], matches: 10000, total: 10000 }).big, false);
  });
});

describe('tooManyMatches()', () => {
  test("reads the count from the server's refusal of over 10,000 matches", () => {
    assert.equal(v.tooManyMatches('The filter matches 12500 records, more than 10000. Narrow it, or confirm with all_matching (--all-matching).'), 12500);
    assert.equal(v.tooManyMatches('PocketBase rejected the filter: bad'), null);
  });
});

describe('requestKey()', () => {
  test('the same request has the same key whatever the reason; any other change makes the preview stale', () => {
    assert.equal(v.requestKey({ collections: ['a'], reason: 'x' }), v.requestKey({ collections: ['a'], reason: 'y' }));
    assert.notEqual(v.requestKey({ collections: ['a'] }), v.requestKey({ collections: ['a'], drop: true }));
    assert.notEqual(v.requestKey({ collection: 'a', filter: 'x = 1' }), v.requestKey({ collection: 'a', filter: 'x = 2' }));
  });
});

describe('clearGate()', () => {
  const preview = { nothing: false, big: false };
  const ready = { preview, previewedKey: 'k', key: 'k', typed: 'polls', slug: 'polls', needsReason: false, reason: '', bigConfirmed: false };
  test('everything in place: the button unlocks', () => {
    assert.deepEqual(v.clearGate(ready), { ok: true, why: null });
  });
  test('the preview is mandatory, and must be of the request as it is now', () => {
    assert.match(v.clearGate({ ...ready, preview: null }).why, /^Preview first/);
    assert.match(v.clearGate({ ...ready, key: 'other' }).why, /^Preview first/);
  });
  test('nothing matching: nothing to delete', () => {
    assert.equal(v.clearGate({ ...ready, preview: { ...preview, nothing: true } }).why, 'Nothing matches, so there is nothing to delete.');
  });
  test('over 10,000 records needs its own tick', () => {
    assert.equal(v.clearGate({ ...ready, preview: { ...preview, big: true } }).why, 'Over 10,000 records: tick the box to confirm.');
    assert.equal(v.clearGate({ ...ready, preview: { ...preview, big: true }, bigConfirmed: true }).ok, true);
  });
  test("an admin clearing someone else's app must give a reason", () => {
    assert.equal(v.clearGate({ ...ready, needsReason: true, reason: '  ' }).why, 'Give a reason: the owner sees it.');
    assert.equal(v.clearGate({ ...ready, needsReason: true, reason: 'spam' }).ok, true);
  });
  test('typing the app name confirms', () => {
    assert.equal(v.clearGate({ ...ready, typed: 'poll' }).why, 'Type polls to confirm.');
    assert.equal(v.clearGate({ ...ready, typed: ' polls ' }).ok, true);
  });
});

describe('recordSummary()', () => {
  test("a sample record's own fields in one line, without PocketBase's", () => {
    const r = { id: 'r1', collectionId: 'c', collectionName: 'polls__tasks', created: 'x', updated: 'y', title: 'Buy milk', done: false, tags: ['a', 'b'], owner: '', meta: { a: 1 } };
    assert.equal(v.recordSummary(r), 'title: Buy milk · done: false · tags: a, b · meta: {"a":1}');
  });
  test('long values are cut short; a record with only system fields says so', () => {
    assert.equal(v.recordSummary({ id: 'x', note: 'a'.repeat(100) }), `note: ${'a'.repeat(39)}…`);
    assert.equal(v.recordSummary({ id: 'x', created: 'y' }), '(no fields)');
  });
});

describe('restoreModel()', () => {
  const dry = (over = {}) => ({ dry_run: true, snapshot: 's1', overwrite: false, recreated: [], skipped_fields: [], refused_fields: [], files: true, warnings: [],
    collections: [{ name: 'tasks', records: 40, existing: 2 }, { name: 'notes', records: 3, existing: 0 }], ...over });
  test('additive: what comes back, and the records that exist again are skipped', () => {
    const m = v.restoreModel(dry());
    assert.equal(m.headline, 'Restores 41 of 43 records into tasks and notes. 2 exist again and are skipped (tick Overwrite to replace them).');
    assert.deepEqual([m.blocked, m.drift], [null, []]);
  });
  test('overwrite: the records that exist again are replaced, after a snapshot of them', () => {
    assert.equal(v.restoreModel(dry({ overwrite: true })).headline, 'Restores 43 records into tasks and notes. 2 that exist again are replaced (saved in a new snapshot first).');
    assert.equal(v.restoreModel(dry({ collections: [{ name: 'tasks', records: 1, existing: 0 }] })).headline, 'Restores 1 record into tasks.');
  });
  test('drift since the snapshot: recreated collections and removed fields', () => {
    assert.deepEqual(v.restoreModel(dry({ recreated: ['notes'], skipped_fields: ['tasks.priority'] })).drift, [
      'notes was dropped: it is created again.',
      'tasks.priority was removed since: its values are skipped.',
    ]);
  });
  test('fields whose type changed block the restore', () => {
    assert.equal(v.restoreModel(dry({ refused_fields: ['tasks.done was bool, is text now'] })).blocked,
      "Can't restore: tasks.done was bool, is text now. Drop or rename those fields, then preview again.");
  });
});

describe('restoreResultText()', () => {
  test('what came back, what was there already, replaced or failed, and accounts with new passwords', () => {
    const r = { snapshot: 's1', collections: [{ name: 'tasks', records: 40, existing: 2, restored: 38, replaced: 0, failed: 0 }], accounts: [] };
    assert.equal(v.restoreResultText(r), 'Restored 38 records from s1 (2 already there).');
    assert.equal(v.restoreResultText({ ...r, collections: [{ name: 'u', records: 3, existing: 1, restored: 1, replaced: 1, failed: 1 }], accounts: [{}] }),
      'Restored 1 record from s1 (1 replaced, 1 failed, 1 account with a new password).');
  });
});

describe('clearResultText()', () => {
  test('what went and the snapshot that can bring it back', () => {
    const r = { mode: 'empty', collections: [{ name: 'tasks', records: 12 }], matches: 12, snapshot: { id: '20261017T101500-abc123', expires: '2026-10-24T10:15:00.000Z' } };
    assert.equal(v.clearResultText(r), 'Deleted 12 records. Snapshot 20261017T101500-abc123 can bring them back until 2026-10-24.');
  });
  test('nothing matched by the time it ran: no snapshot', () => {
    assert.equal(v.clearResultText({ matches: 0, snapshot: null }), 'Nothing matched, so nothing was deleted.');
  });
});

describe('adminClearNotice()', () => {
  test("the owner's banner: who cleared what, why, and the snapshot to restore", () => {
    const flag = { at: '2026-10-17T10:00:00.000Z', by: 'admin@x.dev', reason: 'spam', snapshot: 's1', expires: '2026-10-24T10:00:00.000Z', summary: 'Admin (admin@x.dev) emptied tasks — 3 records · snapshot s1 until 2026-10-24. Reason: spam' };
    assert.deepEqual(v.adminClearNotice(flag), {
      title: 'An admin cleared data of this app',
      text: 'Admin (admin@x.dev) emptied tasks — 3 records · snapshot s1 until 2026-10-24. Reason: spam',
      snapshot: 's1',
    });
    assert.equal(v.adminClearNotice(null), null);
  });
});
