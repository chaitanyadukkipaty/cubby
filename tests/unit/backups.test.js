import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { backupDue, scheduleBackups, createBackupRunner, runMaintenance } from '../../server/src/backups.js';

describe('createBackupRunner', () => {
  test('shows the backup as running, refuses a second one meanwhile, and records how it ended', async () => {
    let finish;
    const runner = createBackupRunner({ run: () => new Promise((r) => (finish = r)), now: () => new Date('2026-10-17T09:00:00Z') });
    assert.deepEqual(runner.state(), { running: null, last: null });
    const started = runner.start();
    assert.deepEqual(runner.state().running, { date: '2026-10-17', started_at: '2026-10-17T09:00:00.000Z' });
    assert.throws(() => runner.start(), (e) => e.status === 409 && /already running/.test(e.message));
    await new Promise((r) => setImmediate(r));
    finish();
    await started.promise;
    assert.equal(runner.state().running, null);
    assert.deepEqual(runner.state().last, { date: '2026-10-17', started_at: '2026-10-17T09:00:00.000Z', finished_at: '2026-10-17T09:00:00.000Z', ok: true, error: null });
  });
  test('a failed backup is recorded with its error, and the next one can start', async () => {
    let fail = true;
    const runner = createBackupRunner({ run: async () => { if (fail) throw new Error('disk full'); } });
    await assert.rejects(runner.start().promise, /disk full/);
    assert.equal(runner.state().running, null);
    assert.equal(runner.state().last.ok, false);
    assert.equal(runner.state().last.error, 'disk full');
    fail = false;
    await runner.start().promise;
    assert.equal(runner.state().last.ok, true);
  });
});

const at = (iso) => new Date(iso);

describe('backupDue', () => {
  // Local-time hour, so build dates from local components.
  const local = (h, day = 10) => new Date(2026, 9, day, h, 30);
  test('due during the configured hour if not yet run today', () => {
    const now = local(3);
    assert.equal(backupDue(now, '', 3), now.toISOString().slice(0, 10));
  });
  test('not due outside the hour', () => {
    for (const h of [0, 2, 4, 23]) assert.equal(backupDue(local(h), '', 3), null);
  });
  test('not due twice on the same day', () => {
    const now = local(3);
    assert.equal(backupDue(now, now.toISOString().slice(0, 10), 3), null);
  });
  test('due again the next day', () => {
    const today = local(3).toISOString().slice(0, 10);
    assert.ok(backupDue(local(3, 11), today, 3));
  });
  test('uses the ISO date as the stamp', () => assert.match(backupDue(at('2026-10-10T03:00:00'), '', at('2026-10-10T03:00:00').getHours()), /^\d{4}-\d{2}-\d{2}$/));
});

describe('scheduleBackups', () => {
  test('checks every minute and runs once per day in the backup hour', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      let clock = new Date(2026, 9, 10, 2, 59);
      const runs = [];
      scheduleBackups({ run: async () => runs.push(clock.getHours()), now: () => clock, hour: 3 });
      mock.timers.tick(60_000);
      assert.equal(runs.length, 0, 'not yet 3am');
      clock = new Date(2026, 9, 10, 3, 0);
      mock.timers.tick(60_000);
      clock = new Date(2026, 9, 10, 3, 1);
      mock.timers.tick(60_000);
      assert.equal(runs.length, 1, 'only once in the hour');
      clock = new Date(2026, 9, 11, 3, 0);
      mock.timers.tick(60_000);
      assert.equal(runs.length, 2, 'again the next night');
    } finally {
      mock.timers.reset();
    }
  });
  test('a failing backup is logged, not thrown', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const errors = mock.method(console, 'error', () => {});
    try {
      scheduleBackups({ run: async () => { throw new Error('disk full'); }, now: () => new Date(2026, 9, 10, 3, 0), hour: 3 });
      mock.timers.tick(60_000);
      await new Promise((r) => setImmediate(r));
      assert.match(errors.mock.calls[0].arguments.join(' '), /backup failed: disk full/);
    } finally {
      errors.mock.restore();
      mock.timers.reset();
    }
  });
});

describe('runMaintenance', () => {
  test('runs every cleanup in order (activity, metrics rollup, …), logs what each did, then backs up', async () => {
    const order = [];
    const logs = [];
    await runMaintenance({
      cleanups: [
        ['activity prune', async () => (order.push('activity'), 'pruned 3 activity rows')],
        ['metrics rollup', async () => (order.push('metrics'), null)],
      ],
      backup: async () => order.push('backup'),
      log: (m) => logs.push(m),
    });
    assert.deepEqual(order, ['activity', 'metrics', 'backup']);
    assert.deepEqual(logs, ['pruned 3 activity rows']);
  });
  test('a failed cleanup never stops the others or the backup', async () => {
    const errors = [];
    const order = [];
    await runMaintenance({
      cleanups: [['activity prune', async () => { throw new Error('db busy'); }], ['metrics rollup', async () => { order.push('metrics'); }]],
      backup: async () => { order.push('backup'); }, log: () => {}, error: (...a) => errors.push(a.join(' ')),
    });
    assert.deepEqual(order, ['metrics', 'backup']);
    assert.match(errors.join('\n'), /activity prune failed: db busy/);
  });
  test('the nightly cleanups are the activity prune and the metrics rollup', async () => {
    const { MAINTENANCE } = await import('../../server/src/backups.js');
    assert.deepEqual(MAINTENANCE.map(([name]) => name), ['activity prune', 'metrics rollup']);
  });
});
