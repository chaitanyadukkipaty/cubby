import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMetrics, countsAsView, parseRange, pocketbaseStore, visitorId, metricsClock, appAccounts, isPerson, rollupMetrics, summarizeMetrics, appMetricsRow } from '../../server/src/metrics.js';

// In-memory stand-in for the cubby_metrics collection.
function memoryStore() {
  const rows = [];
  let n = 0;
  return {
    rows,
    find: async ({ project, period, start }) => rows.find((r) => r.project === project && r.period === period && r.start === start) ?? null,
    create: async (row) => { rows.push({ id: `r${++n}`, ...row }); },
    update: async (id, patch) => { Object.assign(rows.find((r) => r.id === id), patch); },
    list: async ({ projects, from }) => rows.filter((r) => projects.includes(r.project) && r.start >= from),
    older: async ({ period, before, limit }) => rows.filter((r) => r.period === period && r.start < before).sort((a, b) => a.start.localeCompare(b.start)).slice(0, limit),
    remove: async (id) => { rows.splice(rows.findIndex((r) => r.id === id), 1); },
  };
}

const T0 = Date.parse('2026-10-17T10:15:00Z');
const BROWSER = 'Mozilla/5.0 (Macintosh) AppleWebKit/605 Safari/605';
const visit = (ip = '203.0.113.7', ua = BROWSER) => ({ ip, ua });

function setup({ at = T0, ...opts } = {}) {
  const clock = { t: at };
  const store = memoryStore();
  let salt = 0;
  const m = createMetrics({ store, now: () => clock.t, newSalt: () => `salt-${salt++}`, ...opts });
  return { m, store, clock };
}

const bucket = (store, period, start) => store.rows.find((r) => r.period === period && r.start === start);

describe('counting page views', () => {
  test('a recorded view lands in its hourly bucket (no visitors) and its daily bucket when flushed', async () => {
    const { m, store } = setup();
    m.record('p1', visit());
    await m.flush();
    assert.deepEqual(
      { ...bucket(store, 'hour', '2026-10-17T10:00:00.000Z'), id: undefined },
      { id: undefined, project: 'p1', period: 'hour', start: '2026-10-17T10:00:00.000Z', views: 1, peak_active: 1, api_requests: 0, api_errors: 0 },
    );
    assert.deepEqual(
      { ...bucket(store, 'day', '2026-10-17T00:00:00.000Z'), id: undefined },
      { id: undefined, project: 'p1', period: 'day', start: '2026-10-17T00:00:00.000Z', views: 1, visitors: 1, paths: { '/': 1 } },
    );
  });
  test('the same visitor counts once a day; a different IP or browser is another visitor', async () => {
    const { m, store } = setup();
    m.record('p1', visit());
    m.record('p1', visit());
    m.record('p1', visit('198.51.100.1'));
    m.record('p1', visit('203.0.113.7', 'Mozilla/5.0 (Windows NT 10.0) Firefox/130'));
    await m.flush();
    const d = bucket(store, 'day', '2026-10-17T00:00:00.000Z');
    assert.deepEqual([d.views, d.visitors], [4, 3]);
    assert.equal(bucket(store, 'hour', '2026-10-17T10:00:00.000Z').views, 4);
  });
  test('views are counted per hour, unique visitors only per day', async () => {
    const { m, store, clock } = setup();
    m.record('p1', visit());
    clock.t += 3_600_000;
    m.record('p1', visit());
    m.record('p1', visit('198.51.100.1'));
    await m.flush();
    assert.equal(bucket(store, 'hour', '2026-10-17T10:00:00.000Z').views, 1);
    assert.equal(bucket(store, 'hour', '2026-10-17T11:00:00.000Z').views, 2);
    assert.ok(store.rows.filter((r) => r.period === 'hour').every((r) => !('visitors' in r)));
    const day = bucket(store, 'day', '2026-10-17T00:00:00.000Z');
    assert.deepEqual([day.views, day.visitors], [3, 2]);
  });
  test('a new UTC day draws a new salt and counts returning visitors again', async () => {
    const salts = [];
    const { m, store, clock } = setup({ newSalt: () => { salts.push(`s${salts.length}`); return salts.at(-1); } });
    m.record('p1', visit());
    m.record('p1', visit());
    clock.t = Date.parse('2026-10-18T00:05:00Z');
    m.record('p1', visit());
    m.record('p1', visit());
    await m.flush();
    assert.equal(salts.length, 2);
    assert.equal(bucket(store, 'day', '2026-10-17T00:00:00.000Z').visitors, 1);
    assert.equal(bucket(store, 'day', '2026-10-18T00:00:00.000Z').visitors, 1);
  });
  test('past the cap of remembered visitors per app and day, views still count but new visitors stop counting', async () => {
    const { m, store } = setup({ cap: 2 });
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.1']) m.record('p1', visit(ip));
    m.record('p2', visit('10.0.0.3')); // the cap is per app
    await m.flush();
    const day = store.rows.find((r) => r.project === 'p1' && r.period === 'day');
    assert.deepEqual([day.views, day.visitors], [4, 2]);
    assert.equal(store.rows.find((r) => r.project === 'p2' && r.period === 'day').visitors, 1);
  });
  test('stored buckets never contain the IP or user agent', async () => {
    const { m, store } = setup();
    m.record('p1', visit('203.0.113.7'));
    await m.flush();
    const stored = JSON.stringify(store.rows);
    assert.doesNotMatch(stored, /203\.0\.113\.7|Safari/);
  });
  test('a visitor id is the first 6 bytes of the salted sha256, as a number', () => {
    const id = visitorId('salt', '203.0.113.7', BROWSER);
    const expected = createHash('sha256').update(`salt\n203.0.113.7\n${BROWSER}`).digest().readUIntBE(0, 6);
    assert.equal(id, expected);
    assert.ok(Number.isSafeInteger(id) && id >= 0 && id < 2 ** 48);
    assert.notEqual(visitorId('other-salt', '203.0.113.7', BROWSER), id);
  });
  test('the default cap is 200k visitors per app and day', async () => {
    const { VISITOR_CAP } = await import('../../server/src/metrics.js');
    assert.equal(VISITOR_CAP, 200_000);
  });
});

describe('flushing', () => {
  test('each flush adds to the stored bucket, and a visitor seen before a flush is not counted again', async () => {
    const { m, store } = setup();
    m.record('p1', visit());
    await m.flush();
    m.record('p1', visit());
    m.record('p1', visit('198.51.100.1'));
    await m.flush();
    await m.flush(); // nothing new: no writes
    assert.equal(store.rows.length, 2);
    assert.equal(bucket(store, 'hour', '2026-10-17T10:00:00.000Z').views, 3);
    const d = bucket(store, 'day', '2026-10-17T00:00:00.000Z');
    assert.deepEqual([d.views, d.visitors], [3, 2]);
  });
  test('a started counter flushes on its own every interval (60s by default), and a failure is logged, not thrown', async (t) => {
    const { FLUSH_MS } = await import('../../server/src/metrics.js');
    assert.equal(FLUSH_MS, 60_000);
    const { m, store } = setup();
    const errors = t.mock.method(console, 'error', () => {});
    const timer = m.start(5);
    try {
      m.record('p1', visit());
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(bucket(store, 'hour', '2026-10-17T10:00:00.000Z').views, 1);
      store.find = async () => { throw new Error('db down'); };
      m.record('p1', visit());
      await new Promise((r) => setTimeout(r, 30));
      assert.match(String(errors.mock.calls[0]?.arguments.join(' ')), /metrics: db down/);
    } finally {
      clearInterval(timer);
    }
  });
  test('counts from a failed write are kept and written by the next flush', async () => {
    const { m, store } = setup();
    const create = store.create;
    store.create = async () => { throw new Error('db down'); };
    m.record('p1', visit());
    await assert.rejects(m.flush(), /db down/);
    m.record('p1', visit('198.51.100.1'));
    store.create = create;
    await m.flush();
    const h = bucket(store, 'hour', '2026-10-17T10:00:00.000Z');
    assert.equal(h.views, 2);
    const d = bucket(store, 'day', '2026-10-17T00:00:00.000Z');
    assert.deepEqual([d.views, d.visitors], [2, 2]);
  });
  test('overlapping flushes run one after the other, so a bucket is never created twice', async () => {
    const { m, store } = setup();
    const create = store.create;
    store.create = async (b) => { await new Promise((r) => setTimeout(r, 5)); return create(b); };
    m.record('p1', visit());
    const first = m.flush();
    m.record('p1', visit('198.51.100.1'));
    await Promise.all([first, m.flush()]);
    assert.equal(store.rows.length, 2);
    assert.equal(bucket(store, 'hour', '2026-10-17T10:00:00.000Z').views, 2);
  });
});

describe('reports', () => {
  test('a report includes unflushed counts, every hour of the range and the days it touches', async () => {
    const { m, clock } = setup({ at: Date.parse('2026-10-16T08:30:00Z') });
    m.record('p1', visit()); // before the 24h window
    clock.t = Date.parse('2026-10-16T12:10:00Z');
    m.record('p1', visit());
    clock.t = T0;
    m.record('p1', visit());
    m.record('p1', visit());
    m.record('p1', visit('198.51.100.1'));
    m.record('p2', visit()); // another app
    const { p1 } = await m.report(['p1'], 24);
    assert.equal(p1.from, '2026-10-16T11:00:00.000Z');
    assert.equal(p1.to, new Date(T0).toISOString());
    assert.equal(p1.hours.length, 24);
    assert.equal(p1.hours[1].views, 1);
    assert.equal(p1.hours[0].views, 0);
    assert.equal(p1.hours[23].views, 3);
    assert.deepEqual(p1.days, [
      { start: '2026-10-16T00:00:00.000Z', views: 2, visitors: 1, api_requests: 0, api_errors: 0, peak_active: 1 },
      { start: '2026-10-17T00:00:00.000Z', views: 3, visitors: 2, api_requests: 0, api_errors: 0, peak_active: 2 },
    ]);
    // Views in the range; visitors are unique per day, summed over the days the range touches.
    assert.deepEqual([p1.views, p1.visitors], [4, 3]);
  });
  test('an app with no traffic reports zeros', async () => {
    const { m } = setup();
    const { p9 } = await m.report(['p9'], 1);
    assert.deepEqual(p9, { from: '2026-10-17T10:00:00.000Z', to: new Date(T0).toISOString(), views: 0, visitors: 0,
      active_now: 0, peak_active: 0, api_requests: 0, api_errors: 0, api_error_rate: 0, top_paths: [],
      hours: [{ start: '2026-10-17T10:00:00.000Z', views: 0, peak_active: 0, api_requests: 0, api_errors: 0 }],
      days: [{ start: '2026-10-17T00:00:00.000Z', views: 0, visitors: 0, api_requests: 0, api_errors: 0, peak_active: 0 }] });
  });
  test('a report has active now, the peak in the range and API requests, errors and error rate', async () => {
    const { m, clock } = setup({ at: Date.parse('2026-10-16T08:30:00Z') });
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']) m.seen('p1', visit(ip)); // before the window
    m.apiResponse('p1', 500);
    clock.t = Date.parse('2026-10-17T09:20:00Z');
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) m.seen('p1', visit(ip));
    for (const status of [200, 200, 500]) m.apiResponse('p1', status);
    clock.t = T0; // 10:15: the 09:20 visitors are gone
    m.seen('p1', visit('10.0.0.9'));
    m.apiResponse('p1', 200);
    const { p1 } = await m.report(['p1'], 24);
    assert.deepEqual(
      [p1.active_now, p1.peak_active, p1.api_requests, p1.api_errors, p1.api_error_rate],
      [1, 3, 4, 1, 0.25],
    );
    assert.deepEqual(p1.hours.at(-2), { start: '2026-10-17T09:00:00.000Z', views: 0, peak_active: 3, api_requests: 3, api_errors: 1 });
    assert.deepEqual(p1.hours.at(-1), { start: '2026-10-17T10:00:00.000Z', views: 0, peak_active: 1, api_requests: 1, api_errors: 0 });
  });
});

describe('the PocketBase store', () => {
  // Just enough of the SDK: records by filter, and the filter binder.
  function fakeAdmin({ fail } = {}) {
    const calls = [];
    const admin = {
      calls,
      filter: (expr, params) => `${expr} ${JSON.stringify(params)}`,
      collection: (name) => ({
        getFirstListItem: async (filter) => { calls.push([name, 'first', filter]); throw fail ?? Object.assign(new Error('no'), { status: 404 }); },
        getFullList: async (opts) => { calls.push([name, 'list', opts.filter]); return []; },
        getList: async (page, perPage, opts) => { calls.push([name, 'page', opts.filter, perPage, opts.sort]); return { items: [{ id: 'x' }] }; },
        delete: async (id) => { calls.push([name, 'delete', id]); },
      }),
    };
    return admin;
  }
  test('a missing bucket is null; other errors are passed on', async () => {
    const b = { project: 'p1', period: 'hour', start: '2026-10-17T10:00:00.000Z' };
    assert.equal(await pocketbaseStore(fakeAdmin()).find(b), null);
    await assert.rejects(pocketbaseStore(fakeAdmin({ fail: Object.assign(new Error('down'), { status: 0 }) })).find(b), /down/);
  });
  test('listing asks for the given apps only, and asks nothing for no apps', async () => {
    const admin = fakeAdmin();
    const store = pocketbaseStore(admin);
    assert.deepEqual(await store.list({ projects: [], from: '2026-10-17T00:00:00.000Z' }), []);
    assert.equal(admin.calls.length, 0);
    await store.list({ projects: ['p1', 'p2'], from: '2026-10-17T00:00:00.000Z' });
    assert.match(admin.calls[0][2], /^\(project = \{:p0\} \|\| project = \{:p1\}\) && start >= \{:from\}/);
    assert.match(admin.calls[0][2], /"p0":"p1","p1":"p2"/);
    assert.equal(admin.calls[0][0], 'cubby_metrics');
  });
  test('the rollup reads the oldest buckets of a period before a date, a page at a time, and deletes by id', async () => {
    const admin = fakeAdmin();
    const store = pocketbaseStore(admin);
    assert.deepEqual(await store.older({ period: 'hour', before: '2026-09-17T00:00:00.000Z', limit: 500 }), [{ id: 'x' }]);
    await store.remove('x');
    assert.deepEqual(admin.calls[0].slice(0, 2), ['cubby_metrics', 'page']);
    assert.match(admin.calls[0][2], /^period = \{:period\} && start < \{:before\} \{"period":"hour","before":"2026-09-17T00:00:00.000Z"\}/);
    assert.deepEqual(admin.calls[0].slice(3), [500, 'start']);
    assert.deepEqual(admin.calls[1], ['cubby_metrics', 'delete', 'x']);
  });
});

describe('long ranges', () => {
  test('past 30 days a report is by day only: each day has its views and visitors, API counts and peak', async () => {
    const { m, store } = setup();
    // A day 40 days back, its hours already rolled up into it; and today's traffic, still hourly.
    store.rows.push({ id: 'old', project: 'p1', period: 'day', start: '2026-09-07T00:00:00.000Z', views: 10, visitors: 3, api_requests: 5, api_errors: 1, peak_active: 4, paths: { '/': 10 } });
    m.record('p1', visit());
    m.apiResponse('p1', 500);
    m.apiResponse('p1', 200);
    const { p1 } = await m.report(['p1'], 60 * 24);
    assert.deepEqual(p1.hours, []);
    assert.equal(p1.days.length, 60);
    assert.deepEqual(p1.days[0], { start: '2026-08-19T00:00:00.000Z', views: 0, visitors: 0, api_requests: 0, api_errors: 0, peak_active: 0 });
    assert.deepEqual(p1.days.find((d) => d.start === '2026-09-07T00:00:00.000Z'), { start: '2026-09-07T00:00:00.000Z', views: 10, visitors: 3, api_requests: 5, api_errors: 1, peak_active: 4 });
    assert.deepEqual(p1.days.at(-1), { start: '2026-10-17T00:00:00.000Z', views: 1, visitors: 1, api_requests: 2, api_errors: 1, peak_active: 1 });
    assert.deepEqual([p1.from, p1.views, p1.visitors, p1.api_requests, p1.api_errors, p1.peak_active], ['2026-08-19T00:00:00.000Z', 11, 4, 7, 2, 4]);
    assert.deepEqual(p1.top_paths, [{ path: '/', views: 11 }]);
  });
  test('up to 30 days a report has every hour too', async () => {
    const { m } = setup();
    const { p1 } = await m.report(['p1'], 30 * 24);
    assert.equal(p1.hours.length, 720);
  });
});

describe('ranges', () => {
  test('hours, days or 1y, 24h by default, at most a year', () => {
    assert.equal(parseRange(undefined), 24);
    assert.equal(parseRange(''), 24);
    assert.equal(parseRange('1h'), 1);
    assert.equal(parseRange('48h'), 48);
    assert.equal(parseRange('7d'), 168);
    assert.equal(parseRange('90d'), 2160);
    assert.equal(parseRange('1y'), 8760);
    assert.equal(parseRange('365d'), 8760);
  });
  test('anything else is a 400 that says what is accepted', () => {
    for (const r of ['0h', '366d', '8761h', '2y', 'week', '7', '-1d', '1.5h']) {
      assert.throws(() => parseRange(r), (err) => err.status === 400 && /like 1h, 24h, 7d/.test(err.message), r);
    }
  });
});

describe('which requests count as a page view', () => {
  const req = (headers = {}, method = 'GET') => ({ method, headers: { 'user-agent': BROWSER, ...headers } });
  test('a browser loading a page counts', () => {
    assert.equal(countsAsView(req()), true);
    assert.equal(countsAsView(req({ 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile/15E148' })), true);
  });
  test('HEAD requests and prefetches do not', () => {
    assert.equal(countsAsView(req({}, 'HEAD')), false);
    assert.equal(countsAsView(req({ 'sec-purpose': 'prefetch' })), false);
    assert.equal(countsAsView(req({ purpose: 'prefetch' })), false);
  });
  test('obvious bots, scripts and requests without a user agent do not', () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Slackbot-LinkExpanding 1.0',
      'facebookexternalhit/1.1', 'curl/8.7.1', 'Wget/1.21', 'python-requests/2.32', 'node-fetch/1.0', 'Go-http-client/2.0',
      'Mozilla/5.0 HeadlessChrome/120.0', 'Chrome-Lighthouse', 'UptimeRobot/2.0', 'Bingbot', 'AhrefsSpider', 'axios/1.7',
    ]) assert.equal(countsAsView(req({ 'user-agent': ua })), false, ua);
    assert.equal(countsAsView({ method: 'GET', headers: {} }), false);
  });
  test('for active now, any request from a browser is a person (a POST to /pb too); bots and scripts are not', () => {
    assert.equal(isPerson({ 'user-agent': BROWSER }), true);
    assert.equal(isPerson({ 'user-agent': 'curl/8.7.1' }), false);
    assert.equal(isPerson({}), false);
  });
});

describe('API health', () => {
  test('every /pb response counts as a request per hour; 5xx responses also count as errors', async () => {
    const { m, store, clock } = setup();
    for (const status of [200, 204, 400, 401, 403, 404, 499, 500, 502]) m.apiResponse('p1', status);
    m.apiResponse('p2', 503);
    await m.flush();
    const h = bucket(store, 'hour', '2026-10-17T10:00:00.000Z');
    assert.deepEqual([h.api_requests, h.api_errors], [9, 2]);
    clock.t += 10 * 60_000;
    m.apiResponse('p1', 500);
    await m.flush();
    assert.deepEqual([h.api_requests, h.api_errors], [10, 3], 'added up across flushes');
    const p2 = store.rows.find((r) => r.project === 'p2' && r.period === 'hour');
    assert.deepEqual([p2.api_requests, p2.api_errors], [1, 1]);
    assert.ok(!store.rows.some((r) => r.period === 'day' && 'api_requests' in r), 'API counts are hourly only');
  });
  test('an hourly row stored before these counters existed is added to, not broken', async () => {
    const { m, store } = setup();
    store.rows.push({ id: 'old', project: 'p1', period: 'hour', start: '2026-10-17T10:00:00.000Z', views: 5 });
    m.apiResponse('p1', 500);
    m.seen('p1', visit());
    await m.flush();
    assert.deepEqual({ ...store.rows[0] }, { id: 'old', project: 'p1', period: 'hour', start: '2026-10-17T10:00:00.000Z', views: 5, api_requests: 1, api_errors: 1, peak_active: 1 });
  });
});

describe('active now', () => {
  test('distinct visitors seen in the last 5 minutes, across page views and /pb requests', () => {
    const { m } = setup();
    m.record('p1', visit('10.0.0.1'));
    m.seen('p1', visit('10.0.0.1')); // the same person calling the API
    m.seen('p1', visit('10.0.0.2'));
    m.seen('p2', visit('10.0.0.3')); // another app
    assert.equal(m.activeNow('p1'), 2);
    assert.equal(m.activeNow('p2'), 1);
    assert.equal(m.activeNow('p9'), 0);
  });
  test('a visitor drops out 5 minutes after they were last seen; seeing them again keeps them in', () => {
    const { m, clock } = setup();
    m.seen('p1', visit('10.0.0.1'));
    m.seen('p1', visit('10.0.0.2'));
    clock.t += 3 * 60_000;
    m.seen('p1', visit('10.0.0.1'));
    clock.t += 2 * 60_000; // 10.0.0.2 was seen exactly 5 minutes ago
    assert.equal(m.activeNow('p1'), 1);
    clock.t += 3 * 60_000 - 1;
    assert.equal(m.activeNow('p1'), 1);
    clock.t += 1;
    assert.equal(m.activeNow('p1'), 0);
  });
  test('the most visitors active at once in an hour is its peak, kept as a max across flushes', async () => {
    const { m, store, clock } = setup();
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) m.seen('p1', visit(ip));
    await m.flush();
    const hour = () => bucket(store, 'hour', '2026-10-17T10:00:00.000Z');
    assert.equal(hour().peak_active, 3);
    clock.t += 10 * 60_000; // everyone left; one comes back
    m.seen('p1', visit('10.0.0.1'));
    await m.flush();
    assert.equal(hour().peak_active, 3, 'a lower peak never lowers the stored one');
    for (const ip of ['10.0.0.2', '10.0.0.3', '10.0.0.4']) m.seen('p1', visit(ip));
    await m.flush();
    assert.equal(hour().peak_active, 4);
    clock.t = Date.parse('2026-10-17T10:58:00Z');
    m.seen('p1', visit('10.0.0.1'));
    m.seen('p1', visit('10.0.0.2'));
    clock.t = Date.parse('2026-10-17T11:01:00Z'); // still active as the next hour starts
    m.seen('p1', visit('10.0.0.9'));
    await m.flush();
    assert.equal(hour().peak_active, 4);
    assert.equal(bucket(store, 'hour', '2026-10-17T11:00:00.000Z').peak_active, 3);
  });
  test('past the cap of active visitors per app, newcomers are not tracked until someone drops out', async () => {
    const { ACTIVE_CAP } = await import('../../server/src/metrics.js');
    assert.equal(ACTIVE_CAP, 50_000);
    const { m, clock } = setup({ activeCap: 2 });
    m.seen('p1', visit('10.0.0.1'));
    clock.t += 60_000;
    m.seen('p1', visit('10.0.0.2'));
    m.seen('p1', visit('10.0.0.3'));
    m.seen('p2', visit('10.0.0.3')); // the cap is per app
    assert.equal(m.activeNow('p1'), 2);
    assert.equal(m.activeNow('p2'), 1);
    clock.t += 4 * 60_000; // 10.0.0.1 drops out, making room
    m.seen('p1', visit('10.0.0.3'));
    assert.equal(m.activeNow('p1'), 2);
    clock.t += 60_000;
    assert.equal(m.activeNow('p1'), 1, '10.0.0.3 is the one left');
  });
});

describe('the metrics clock', () => {
  test('is Date.now unless a test points CUBBY_TEST_CLOCK_FILE at a file holding an offset in ms', (t) => {
    assert.equal(metricsClock(undefined), Date.now);
    const dir = mkdtempSync(join(tmpdir(), 'cubby-clock-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'offset');
    const clock = metricsClock(file);
    const close = (a, b) => Math.abs(a - b) < 1000;
    assert.ok(close(clock(), Date.now()), 'no file yet: no offset');
    writeFileSync(file, '300000\n');
    assert.ok(close(clock(), Date.now() + 300_000));
    writeFileSync(file, 'nonsense');
    assert.ok(close(clock(), Date.now()));
  });
});

describe('app accounts', () => {
  // Collections and auth records as the SDK returns them (PocketBase dates have a space, not a T).
  function fakePb(collections, records) {
    const calls = [];
    return {
      calls,
      filter: (expr, params) => `${expr} ${JSON.stringify(params)}`,
      collections: { getFullList: async () => collections },
      collection: (name) => ({
        getList: async () => { calls.push([name, 'count']); return { totalItems: (records[name] ?? []).length, items: [] }; },
        getFullList: async (opts) => {
          calls.push([name, 'list', opts.filter]);
          const { from } = JSON.parse(opts.filter.slice(opts.filter.indexOf('{"')));
          return (records[name] ?? []).filter((r) => r.created >= from.replace('T', ' ')).map((r) => ({ created: r.created }));
        },
      }),
    };
  }
  test('counts every auth collection of the app, with signups in the range and per UTC day', async () => {
    const pb = fakePb(
      [
        { name: 'shop__users', type: 'auth' }, { name: 'shop__staff', type: 'auth' }, { name: 'shop__orders', type: 'base' },
        { name: 'other__users', type: 'auth' }, { name: 'users', type: 'auth' },
      ],
      {
        shop__users: [{ created: '2026-10-01 09:00:00.000Z' }, { created: '2026-10-16 08:00:00.000Z' }, { created: '2026-10-16 12:00:00.000Z' }, { created: '2026-10-17 10:00:00.000Z' }],
        shop__staff: [{ created: '2026-10-17 09:30:00.000Z' }],
        other__users: [{ created: '2026-10-17 09:30:00.000Z' }],
      },
    );
    const accounts = await appAccounts(pb, 'shop__', Date.parse('2026-10-16T11:00:00Z'), T0);
    assert.deepEqual(accounts, {
      total: 5,
      new: 3, // since 11:00 on the 16th
      days: [{ start: '2026-10-16T00:00:00.000Z', signups: 2 }, { start: '2026-10-17T00:00:00.000Z', signups: 2 }],
    });
    assert.ok(pb.calls.every(([name]) => name.startsWith('shop__')), 'only this app\'s collections are read');
  });
  test('an app without auth collections has no accounts', async () => {
    const accounts = await appAccounts(fakePb([{ name: 'shop__orders', type: 'base' }], {}), 'shop__', Date.parse('2026-10-17T10:00:00Z'), T0);
    assert.deepEqual(accounts, { total: 0, new: 0, days: [{ start: '2026-10-17T00:00:00.000Z', signups: 0 }] });
  });
});

describe('top paths', () => {
  const view = (m, path, ip = '203.0.113.7') => m.record('p1', { ip, ua: BROWSER, path });
  test('a day keeps its 10 most viewed paths, and the rest add up as "other"', async () => {
    const { m, store } = setup();
    for (let i = 0; i < 12; i++) for (let n = 0; n <= i; n++) view(m, `/p${i}`);
    await m.flush();
    const { paths } = bucket(store, 'day', '2026-10-17T00:00:00.000Z');
    assert.deepEqual(Object.keys(paths).filter((p) => p !== 'other').sort(), ['/p10', '/p11', '/p2', '/p3', '/p4', '/p5', '/p6', '/p7', '/p8', '/p9']);
    assert.equal(paths['/p11'], 12);
    assert.equal(paths.other, 1 + 2); // /p0 and /p1
  });
  test('query strings are dropped and paths are cut at 200 characters', async () => {
    const { m, store } = setup();
    view(m, '/search?q=secret');
    view(m, '/search');
    view(m, `/${'x'.repeat(300)}`);
    await m.flush();
    const { paths } = bucket(store, 'day', '2026-10-17T00:00:00.000Z');
    assert.deepEqual(paths, { '/search': 2, [`/${'x'.repeat(199)}`]: 1 });
  });
  test('flushes merge into the stored top 10, and a new day starts its own list', async () => {
    const { m, store, clock } = setup();
    for (let i = 0; i < 10; i++) view(m, `/p${i}`);
    await m.flush();
    view(m, '/new');
    view(m, '/new');
    view(m, '/p3');
    await m.flush();
    const { paths } = bucket(store, 'day', '2026-10-17T00:00:00.000Z');
    assert.equal(paths['/new'], 2);
    assert.equal(paths['/p3'], 2);
    assert.equal(Object.keys(paths).filter((p) => p !== 'other').length, 10);
    assert.equal(Object.values(paths).reduce((a, b) => a + b, 0), 13, 'nothing is lost: what drops out counts as other');
    clock.t = Date.parse('2026-10-18T01:00:00Z');
    view(m, '/tomorrow');
    await m.flush();
    assert.deepEqual(bucket(store, 'day', '2026-10-18T00:00:00.000Z').paths, { '/tomorrow': 1 });
  });
  test('between flushes at most 1000 distinct paths are counted per app; more count as other', async () => {
    const { m, store } = setup();
    for (let i = 0; i < 1000; i++) view(m, `/p${i}`);
    for (let i = 0; i < 5; i++) view(m, '/late'); // a path past the cap: not tracked until the next flush
    view(m, '/p0');
    await m.flush();
    const { paths } = bucket(store, 'day', '2026-10-17T00:00:00.000Z');
    assert.equal(paths['/p0'], 2);
    assert.equal(paths['/late'], undefined);
    assert.equal(paths.other, 1000 - 10 + 5);
  });
  test('a report lists the top paths of the days in its range, most viewed first', async () => {
    const { m, clock } = setup({ at: Date.parse('2026-10-16T12:00:00Z') });
    view(m, '/a');
    view(m, '/b');
    clock.t = T0;
    view(m, '/b');
    view(m, '/c');
    view(m, '/b');
    const { p1 } = await m.report(['p1'], 24);
    assert.deepEqual(p1.top_paths, [{ path: '/b', views: 3 }, { path: '/a', views: 1 }, { path: '/c', views: 1 }]);
    const { p9 } = await m.report(['p9'], 24);
    assert.deepEqual(p9.top_paths, []);
    for (let i = 0; i < 11; i++) view(m, `/x${i}`);
    const { p1: more } = await m.report(['p1'], 24);
    assert.deepEqual(more.top_paths.at(-1), { path: 'other', views: 4 }, 'what falls out of the top 10 comes last, as other');
  });
});

describe('rollup (nightly maintenance)', () => {
  const hour = (project, start, f) => ({ id: `h-${project}-${start}`, project, period: 'hour', start, views: 0, peak_active: 0, api_requests: 0, api_errors: 0, ...f });
  test('hours older than 30 days are added to their day (API counts summed, peak kept as the max) and deleted', async () => {
    const store = memoryStore();
    store.rows.push(
      { id: 'd1', project: 'p1', period: 'day', start: '2026-09-10T00:00:00.000Z', views: 7, visitors: 2, paths: { '/': 7 } },
      hour('p1', '2026-09-10T08:00:00.000Z', { views: 3, peak_active: 2, api_requests: 10, api_errors: 1 }),
      hour('p1', '2026-09-10T09:00:00.000Z', { views: 4, peak_active: 5, api_requests: 6, api_errors: 0 }),
      hour('p2', '2026-09-10T09:00:00.000Z', { views: 2, peak_active: 1, api_requests: 3, api_errors: 3 }), // no day row
      hour('p1', '2026-09-17T09:00:00.000Z', { views: 1 }), // exactly 30 days back: kept
    );
    const r = await rollupMetrics({ store, now: () => T0 });
    assert.deepEqual(r, { rolled: 3, deleted: 0 });
    assert.deepEqual(store.rows.filter((x) => x.period === 'hour').map((x) => x.start), ['2026-09-17T09:00:00.000Z']);
    const day = (p) => { const { id, ...rest } = store.rows.find((x) => x.project === p && x.period === 'day'); return rest; };
    // Views were already counted per day; they're only taken from the hours when the day has no row.
    assert.deepEqual(day('p1'), { project: 'p1', period: 'day', start: '2026-09-10T00:00:00.000Z', views: 7, visitors: 2, paths: { '/': 7 }, api_requests: 16, api_errors: 1, peak_active: 5 });
    assert.deepEqual(day('p2'), { project: 'p2', period: 'day', start: '2026-09-10T00:00:00.000Z', views: 2, visitors: 0, api_requests: 3, api_errors: 3, peak_active: 1 });
  });
  test('day buckets more than a year back are deleted; work goes in batches until nothing is left', async () => {
    const store = memoryStore();
    for (const start of ['2025-10-01T00:00:00.000Z', '2025-10-16T00:00:00.000Z', '2025-10-17T00:00:00.000Z', '2026-10-01T00:00:00.000Z']) {
      store.rows.push({ id: start, project: 'p1', period: 'day', start, views: 1, visitors: 1 });
    }
    for (let h = 0; h < 5; h++) store.rows.push(hour('p1', `2026-08-01T0${h}:00:00.000Z`, { api_requests: 1 }));
    const r = await rollupMetrics({ store, now: () => T0, batch: 2 });
    assert.deepEqual(r, { rolled: 5, deleted: 2 });
    assert.deepEqual(store.rows.map((x) => x.start).sort(), ['2025-10-17T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
    assert.equal(store.rows.find((x) => x.start === '2026-08-01T00:00:00.000Z').api_requests, 5);
  });
});

describe('admin totals', () => {
  const rep = (views, visitors, api_requests, api_errors, active_now = 0) => ({ from: 'F', to: 'T', views, visitors, api_requests, api_errors, active_now });
  test('sums every app and lists the busiest 10 by views, with their owners', () => {
    const projects = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, slug: `app-${i}`, expand: { owner: { email: `o${i}@x.dev` } } }));
    const report = Object.fromEntries(projects.map((p, i) => [p.id, rep(i, 1, 10, i === 11 ? 5 : 0, 1)]));
    const s = summarizeMetrics(projects, report);
    assert.deepEqual([s.from, s.to, s.apps, s.views, s.visitors, s.active_now, s.api_requests, s.api_errors], ['F', 'T', 12, 66, 12, 12, 120, 5]);
    assert.ok(Math.abs(s.api_error_rate - 5 / 120) < 1e-9);
    assert.equal(s.top_apps.length, 10);
    assert.deepEqual(s.top_apps[0], { app: 'app-11', owner: 'o11@x.dev', views: 11, visitors: 1, api_requests: 10, api_errors: 5, active_now: 1 });
    assert.equal(s.top_apps.at(-1).app, 'app-2');
  });
  test('apps with the same views are listed by name; an app without an owner shows null', () => {
    const projects = [{ id: 'b', slug: 'bee' }, { id: 'a', slug: 'ant' }];
    const s = summarizeMetrics(projects, { a: rep(1, 1, 0, 0), b: rep(1, 1, 0, 0) });
    assert.deepEqual(s.top_apps.map((x) => [x.app, x.owner]), [['ant', null], ['bee', null]]);
    assert.equal(s.api_error_rate, 0);
  });
  test('no apps: zeros', () => {
    assert.deepEqual(summarizeMetrics([], {}), { from: null, to: null, apps: 0, views: 0, visitors: 0, active_now: 0, api_requests: 0, api_errors: 0, api_error_rate: 0, top_apps: [], hours: [], days: [] });
  });
  test("every app's hours and days added up by bucket, for the server-wide chart", () => {
    const projects = [{ id: 'a', slug: 'ant' }, { id: 'b', slug: 'bee' }];
    const day = (start, views, visitors) => ({ start, views, visitors, api_requests: 1, api_errors: 0, peak_active: 2 });
    const hour = (start, views) => ({ start, views, peak_active: 1, api_requests: 2, api_errors: 1 });
    const report = {
      a: { ...rep(3, 2, 0, 0), days: [day('D1', 1, 1), day('D2', 2, 1)], hours: [hour('H1', 3)] },
      b: { ...rep(5, 2, 0, 0), days: [day('D1', 4, 2), day('D2', 1, 0)], hours: [hour('H1', 5)] },
    };
    const s = summarizeMetrics(projects, report);
    assert.deepEqual(s.days, [
      { start: 'D1', views: 5, visitors: 3, api_requests: 2, api_errors: 0, peak_active: 4 },
      { start: 'D2', views: 3, visitors: 1, api_requests: 2, api_errors: 0, peak_active: 4 },
    ]);
    assert.deepEqual(s.hours, [{ start: 'H1', views: 8, peak_active: 2, api_requests: 4, api_errors: 2 }]);
  });
});

// GET /api/metrics: one row per app, with a compact daily series so the dashboard needs no per-app request.
describe('the per-app list row', () => {
  test('has the totals and each day as { start, views, visitors } only, without hours, paths or API counts', () => {
    const report = {
      from: 'F', to: 'T', views: 7, visitors: 3, active_now: 1, peak_active: 2, api_requests: 10, api_errors: 1, api_error_rate: 0.1,
      top_paths: [{ path: '/', views: 7 }], hours: [{ start: 'H1', views: 7 }],
      days: [{ start: 'D1', views: 3, visitors: 1, api_requests: 4, api_errors: 0, peak_active: 1 }, { start: 'D2', views: 4, visitors: 2, api_requests: 6, api_errors: 1, peak_active: 2 }],
    };
    assert.deepEqual(appMetricsRow({ slug: 'polls', name: 'Polls' }, '7d', report), {
      app: 'polls', name: 'Polls', range: '7d', from: 'F', to: 'T', views: 7, visitors: 3, active_now: 1, peak_active: 2,
      api_requests: 10, api_errors: 1, api_error_rate: 0.1,
      days: [{ start: 'D1', views: 3, visitors: 1 }, { start: 'D2', views: 4, visitors: 2 }],
    });
  });
  test('days without traffic count zero', () => {
    const row = appMetricsRow({ slug: 'a', name: 'A' }, '24h', { views: 0, visitors: 0, days: [{ start: 'D1' }] });
    assert.deepEqual(row.days, [{ start: 'D1', views: 0, visitors: 0 }]);
  });
});
