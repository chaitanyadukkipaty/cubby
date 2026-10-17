// Unit tests for the app page's view model (server/public/js/app-view.js): the range in the URL, the KPI strip,
// top paths and the text that describes each chart to screen readers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as v from '../../server/public/js/app-view.js';

test('the app-view module has no DOM state, network access or imports beyond pure modules', () => {
  const src = readFileSync(new URL('../../server/public/js/app-view.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bfetch\(|localStorage|location\.|document\.|window\./);
  for (const m of src.matchAll(/^import .* from '(.*)';$/gm)) assert.match(m[1], /^\.\/(helpers|charts|routes)\.js$/);
});

describe('kpis()', () => {
  const r = { active_now: 14, peak_active: 31, views: 5045, visitors: 1546, api_requests: 900, api_errors: 9, api_error_rate: 0.01, accounts: { total: 64, new: 9 } };
  test('active now, views, visitors, API error rate and accounts, formatted', () => {
    assert.deepEqual(v.kpis(r, '7d'), [
      { label: 'Active now', value: '14', sub: 'peak 31' },
      { label: 'Views', value: '5,045', sub: 'last 7 days' },
      { label: 'Visitors', value: '1,546', sub: 'unique per day, summed' },
      { label: 'API error rate', value: '1.0%', sub: '9 of 900 requests', alert: false },
      { label: 'Accounts', value: '64', sub: '+9 new' },
    ]);
  });
  test('an error rate that needs a look is flagged; no requests means no rate', () => {
    assert.equal(v.kpis({ ...r, api_errors: 50, api_error_rate: 0.2 }, '24h')[3].alert, true);
    assert.deepEqual(v.kpis({ ...r, api_requests: 0, api_errors: 0, api_error_rate: 0 }, '24h')[3], { label: 'API error rate', value: '–', sub: 'no API requests', alert: false });
  });
  test('accounts may be missing (an older server); the KPI then shows a dash', () => {
    assert.deepEqual(v.kpis({ ...r, accounts: undefined }, '24h')[4], { label: 'Accounts', value: '–', sub: '' });
  });
});

describe('topPathRows()', () => {
  test("null when the server doesn't report top paths", () => {
    assert.equal(v.topPathRows({}), null);
    assert.equal(v.topPathRows({ top_paths: 'nope' }), null);
  });
  test('rows with each path\'s share of the busiest, accepting { path, views } or [path, views]', () => {
    assert.deepEqual(v.topPathRows({ top_paths: [{ path: '/', views: 200 }, ['/p/:id', 50]] }), [
      { path: '/', views: 200, share: 1 },
      { path: '/p/:id', views: 50, share: 0.25 },
    ]);
  });
  test('an empty list is still a list (the table says nothing yet)', () => assert.deepEqual(v.topPathRows({ top_paths: [] }), []));
});

describe('chartSummary()', () => {
  const buckets = [
    { start: Date.parse('2026-10-14T00:00:00Z'), views: 12 },
    { start: Date.parse('2026-10-15T00:00:00Z'), views: 610 },
  ];
  test('the total and the busiest bucket, for screen readers and as the table fallback caption', () => {
    assert.equal(v.chartSummary('Views', buckets, 'views', '7d'), 'Views: 622 in total, most on Oct 15 (610).');
  });
  test('peaks are not summed', () => {
    assert.equal(v.chartSummary('Peak active', buckets, 'views', '7d', { total: false }), 'Peak active: highest on Oct 15 (610).');
  });
  test('nothing counted yet', () => assert.equal(v.chartSummary('Views', [{ start: 0, views: 0 }], 'views', '7d'), 'Views: none yet.'));
});

describe('rangeFrom()', () => {
  test('reads ?range= from the URL; 7 days by default and for anything unknown', () => {
    assert.equal(v.rangeFrom('?range=24h'), '24h');
    assert.equal(v.rangeFrom('?range=30d'), '30d');
    assert.equal(v.rangeFrom(''), '7d');
    assert.equal(v.rangeFrom('?range=90d'), '7d');
  });
});

// Home's "Views · 7 days" and each sparkline on /apps come from the GET /api/metrics?range=7d list rows alone.
describe('weekViews()', () => {
  const days = (...views) => views.map((n, i) => ({ start: `2026-10-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`, views: n, visitors: 0 }));
  test("adds every app's views up by day and keeps the last 7 days", () => {
    const rows = [{ app: 'a', days: days(9, 1, 2, 3, 4, 5, 6, 7) }, { app: 'b', days: days(9, 0, 0, 0, 0, 0, 1, 1) }];
    assert.deepEqual(v.weekViews(rows), { total: 30, values: [1, 2, 3, 4, 5, 7, 8] });
  });
  test('one app is its own series; no apps or no days is nothing', () => {
    assert.deepEqual(v.weekViews([{ days: days(2, 3) }]), { total: 5, values: [2, 3] });
    assert.deepEqual(v.weekViews([]), { total: 0, values: [] });
    assert.deepEqual(v.weekViews([{ app: 'old-server' }]), { total: 0, values: [] }, 'rows without days (an older server)');
  });
});
