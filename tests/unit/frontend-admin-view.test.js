// Unit tests for the admin page's view model (server/public/js/admin-view.js): the disk bar, backup guards, the
// retention estimate, the most active agents and who may purge a snapshot.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as v from '../../server/public/js/admin-view.js';

test('the admin-view module has no DOM state, network access or imports beyond pure modules', () => {
  const src = readFileSync(new URL('../../server/public/js/admin-view.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bfetch\(|localStorage|location\.|document\.|window\./);
  for (const m of src.matchAll(/^import .* from '(.*)';$/gm)) assert.match(m[1], /^\.\/(helpers|charts|routes)\.js$/);
});

describe('diskBar()', () => {
  const GB = 1024 ** 3;
  const storage = {
    disk: { total_bytes: 100 * GB, free_bytes: 40 * GB },
    data_bytes: 50 * GB,
    breakdown: { database_bytes: 10 * GB, uploads_bytes: 15 * GB, sites_current_bytes: 5 * GB, sites_older_bytes: 5 * GB, backups_bytes: 10 * GB, snapshots_bytes: 4 * GB, other_bytes: 1 * GB },
  };
  test("Cubby's categories, what else is on the disk, then free space, each a share of the whole disk", () => {
    const bar = v.diskBar(storage);
    assert.deepEqual(bar.map((s) => [s.key, s.label, s.bytes, s.share]), [
      ['database', 'Database', 10 * GB, 0.1],
      ['uploads', 'Uploads', 15 * GB, 0.15],
      ['current', 'Current deploys', 5 * GB, 0.05],
      ['older', 'Old deploys', 5 * GB, 0.05],
      ['backups', 'Backups', 10 * GB, 0.1],
      ['snapshots', 'Snapshots', 4 * GB, 0.04],
      ['other', 'Other Cubby files', 1 * GB, 0.01],
      ['system', 'Not Cubby', 10 * GB, 0.1],
      ['free', 'Free', 40 * GB, 0.4],
    ]);
  });
  test('empty categories are left out; Cubby using more than the disk reports (another mount) never goes negative', () => {
    const bar = v.diskBar({ disk: { total_bytes: 10, free_bytes: 5 }, data_bytes: 8, breakdown: { database_bytes: 8 } });
    assert.deepEqual(bar.map((s) => s.key), ['database', 'free']);
    assert.equal(bar[0].share, 0.8);
  });
  test('an unknown disk size: shares of what Cubby uses', () => {
    const bar = v.diskBar({ disk: { total_bytes: 0, free_bytes: 0 }, data_bytes: 4, breakdown: { database_bytes: 1, uploads_bytes: 3 } });
    assert.deepEqual(bar.map((s) => [s.key, s.share]), [['database', 0.25], ['uploads', 0.75]]);
  });
});

describe('backupDelete()', () => {
  const list = [{ date: '2026-10-17', total_bytes: 3 * 1048576 }, { date: '2026-10-16', total_bytes: 2048 }, { date: '2026-10-15', total_bytes: 2048 }];
  test('an older backup: a plain confirmation naming both files and the space it frees', () => {
    assert.deepEqual(v.backupDelete(list, '2026-10-15'), {
      blocked: null, leaveNone: false,
      confirm: 'Delete the backup of 2026-10-15? Both files go (cubby-2026-10-15.zip and sites-2026-10-15.tar.gz), freeing 2 KB.',
    });
  });
  test('the newest backup says which one becomes the latest to restore', () => {
    assert.match(v.backupDelete(list, '2026-10-17').confirm, /^Delete the newest backup \(2026-10-17\)\? The latest one to restore becomes 2026-10-16\. .*freeing 3\.0 MB\.$/);
  });
  test('the only backup needs leave_none and says nothing is left to restore', () => {
    const g = v.backupDelete(list.slice(0, 1), '2026-10-17');
    assert.equal(g.leaveNone, true);
    assert.match(g.confirm, /^Delete 2026-10-17, the only backup\? Nothing is left to restore until the next one runs\./);
  });
  test('while a backup runs, deleting is blocked', () => {
    assert.equal(v.backupDelete(list, '2026-10-15', { running: true }).blocked, 'A backup is running. Try again when it finishes.');
  });
});

describe('restoreCommand()', () => {
  test('the server-side command for a backup date', () => {
    assert.equal(v.restoreCommand('2026-10-17'), 'sudo cubby-server restore 2026-10-17');
  });
});

describe('retentionText()', () => {
  test('keeping fewer: which backups the next nightly run deletes and what that frees', () => {
    assert.deepEqual(v.retentionText({ keep: 2, backups: 4, delete: ['2026-10-14', '2026-10-13'], frees_bytes: 3 * 1048576, adds_bytes: 0 }), {
      kind: 'frees', text: 'Keeping 2 deletes 2 backups at the next nightly run (2026-10-14, 2026-10-13), freeing 3.0 MB.',
    });
    assert.equal(v.retentionText({ keep: 1, backups: 2, delete: ['2026-10-14'], frees_bytes: 2048, adds_bytes: 0 }).text,
      'Keeping 1 deletes 1 backup at the next nightly run (2026-10-14), freeing 2 KB.');
  });
  test('keeping more: roughly how much more disk the extra nightly backups take', () => {
    assert.deepEqual(v.retentionText({ keep: 10, backups: 3, delete: [], frees_bytes: 0, adds_bytes: 7 * 1048576 }), {
      kind: 'adds', text: 'Keeping 10 takes about 7.0 MB more once 7 more nightly backups exist.',
    });
  });
  test('the same number as on disk: nothing changes', () => {
    assert.deepEqual(v.retentionText({ keep: 3, backups: 3, delete: [], frees_bytes: 0, adds_bytes: 0 }), { kind: 'same', text: 'Keeping 3 changes nothing now: there are 3 backups.' });
    assert.equal(v.retentionText({ keep: 1, backups: 1, delete: [], frees_bytes: 0, adds_bytes: 0 }).text, 'Keeping 1 changes nothing now: there is 1 backup.');
  });
});

describe('activeAgents()', () => {
  const row = (agent, user, app, at) => ({ at, user, via: agent ? 'agent' : 'dashboard', agent: agent && { id: agent, name: `Agent ${agent}` }, app, action: 'deploy' });
  const rows = [
    row('a1', 'priya@x.dev', 'polls', '2026-10-17 10:00:00.000Z'),
    row('b2', 'sam@x.dev', 'chores', '2026-10-17 09:00:00.000Z'),
    row(null, 'priya@x.dev', 'polls', '2026-10-17 08:00:00.000Z'),
    row('a1', 'priya@x.dev', 'notes', '2026-10-16 10:00:00.000Z'),
    row('a1', 'priya@x.dev', 'polls', '2026-10-15 10:00:00.000Z'),
    row('b2', 'sam@x.dev', null, '2026-10-14 10:00:00.000Z'),
  ];
  test('agents across every user, busiest first, with their owner, apps (busiest first) and when they were last seen', () => {
    assert.deepEqual(v.activeAgents(rows), [
      { id: 'a1', name: 'Agent a1', user: 'priya@x.dev', actions: 3, apps: ['polls', 'notes'], last: '2026-10-17 10:00:00.000Z' },
      { id: 'b2', name: 'Agent b2', user: 'sam@x.dev', actions: 2, apps: ['chores'], last: '2026-10-17 09:00:00.000Z' },
    ]);
  });
  test('changes made from the dashboard are not an agent; `limit` caps the list', () => {
    assert.deepEqual(v.activeAgents(rows.filter((r) => !r.agent)), []);
    assert.deepEqual(v.activeAgents(rows, { limit: 1 }).map((a) => a.id), ['a1']);
  });
});

describe('purgeRule()', () => {
  test('anyone who sees a snapshot may purge it, except an owner purging one an admin made', () => {
    assert.deepEqual(v.purgeRule({ by_admin: false }, { is_admin: false }), { allowed: true, why: null });
    assert.deepEqual(v.purgeRule({ by_admin: true }, { is_admin: true }), { allowed: true, why: null });
    assert.deepEqual(v.purgeRule({ by_admin: true }, { is_admin: false }), { allowed: false, why: 'Made by an admin: only an admin can purge it. You can still restore it.' });
  });
});

describe('overviewKpis()', () => {
  const metrics = { views: 5063, visitors: 1201, active_now: 14, api_requests: 1000, api_errors: 3, api_error_rate: 0.003 };
  const server = { users: 6, apps: 11, disk_free_bytes: 30 * 1024 ** 3, disk_total_bytes: 40 * 1024 ** 3 };
  test('server-wide numbers for the last 7 days, people and apps, and free disk', () => {
    assert.deepEqual(v.overviewKpis(metrics, server), [
      { label: 'Users', value: '6', sub: '11 apps' },
      { label: 'Views', value: '5,063', sub: 'last 7 days, every app' },
      { label: 'Visitors', value: '1,201', sub: 'per app and day' },
      { label: 'Active now', value: '14', sub: 'last 5 minutes' },
      { label: 'API error rate', value: '0.3%', sub: '3 of 1,000 requests' },
      { label: 'Disk free', value: '30.0 GB', sub: 'of 40.0 GB', alert: false },
    ]);
  });
  test('no API requests: a dash; under 10% of the disk free is flagged', () => {
    const k = v.overviewKpis({ ...metrics, api_requests: 0, api_errors: 0, api_error_rate: 0 }, { ...server, disk_free_bytes: 2 * 1024 ** 3 });
    assert.deepEqual(k[4], { label: 'API error rate', value: '–', sub: 'no API requests' });
    assert.equal(k[5].alert, true);
  });
});

describe('settingsError()', () => {
  test("names a setting by its label, not the server's field key", () => {
    assert.equal(v.settingsError('max_apps_per_user must be a whole number between 1 and 10000'), 'Apps per user must be a whole number between 1 and 10000');
    assert.equal(v.settingsError('max_deploy_mb must be a whole number between 1 and 10000'), 'Max deploy (MB) must be a whole number between 1 and 10000');
    assert.equal(v.settingsError('job_timeout_s must be a whole number between 5 and 290'), 'Time limit per run (seconds) must be a whole number between 5 and 290');
    assert.equal(v.settingsError('backup_keep must be a whole number between 1 and 90'), 'Nightly backups to keep must be a whole number between 1 and 90');
  });
  test('other messages pass through', () => {
    assert.equal(v.settingsError('Server name is required'), 'Server name is required');
    assert.equal(v.settingsError(undefined), 'Saving failed');
  });
});

describe('the Security tab (GET /api/admin/bans rows)', () => {
  const now = Date.parse('2026-10-18T06:00:00Z');
  const ban = { ip: '203.0.113.9', jail: 'cubby-probe', reason: 'Scanning for secret files', banned_at: '2026-10-18T05:58:00.000Z', expires_at: '2026-10-18T06:08:00.000Z',
    unbanned_at: null, unbanned_by: null, hosts: ['todo.example.test', 'chat.example.test'], paths: ['/.env', '/.git/config'], seen_before: 0 };

  test('banExpiry: when a ban lifts by itself', () => {
    assert.equal(v.banExpiry(ban, now), 'lifts in 8 min');
    assert.equal(v.banExpiry({ ...ban, expires_at: '2026-10-18T06:00:30.000Z' }, now), 'lifts in under a minute');
    assert.equal(v.banExpiry({ ...ban, expires_at: '2026-10-18T09:30:00.000Z' }, now), 'lifts in 3 h 30 min');
    assert.equal(v.banExpiry({ ...ban, expires_at: '2026-10-20T07:00:00.000Z' }, now), 'lifts in 2 days');
    assert.equal(v.banExpiry({ ...ban, expires_at: null }, now), 'until unbanned');
  });
  test('banSweep: what a scanner swept, or nothing to say', () => {
    assert.equal(v.banSweep(ban), 'Swept 2 apps: todo.example.test, chat.example.test');
    assert.equal(v.banSweep({ ...ban, hosts: ['todo.example.test'] }), 'Swept todo.example.test');
    assert.equal(v.banSweep({ ...ban, hosts: [], paths: [] }), null);
  });
  test('seenBefore: repeat offenders stand out', () => {
    assert.equal(v.seenBefore(0), null);
    assert.equal(v.seenBefore(1), 'banned once before');
    assert.equal(v.seenBefore(4), 'banned 4 times before');
  });
  test('banOutcome: how a past ban ended', () => {
    assert.equal(v.banOutcome({ ...ban, unbanned_by: 'expired' }), 'Expired');
    assert.equal(v.banOutcome({ ...ban, unbanned_by: 'admin a@b.c' }), 'Unbanned by a@b.c');
    assert.equal(v.banOutcome({ ...ban, unbanned_by: 'on the server (cubby-server or fail2ban)' }), 'Unbanned on the server (cubby-server or fail2ban)');
    assert.equal(v.banOutcome({ ...ban, unbanned_by: null }), 'Expired');
  });
  test('unbanConfirm: says what unbanning does', () => {
    assert.equal(v.unbanConfirm(ban), 'Unban 203.0.113.9 (Scanning for secret files)? It can reach every app on this server again right away.');
  });
  test('the server command that turns it on', () => {
    assert.equal(v.FAIL2BAN_ENABLE, 'sudo cubby-server fail2ban enable');
  });
});
