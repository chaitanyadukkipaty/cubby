import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createMetrics, countsAsView, parseRange, pocketbaseStore } from '../../server/src/metrics.js';

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
  test('a recorded view lands in its hourly bucket when flushed', async () => {
    const { m, store } = setup();
    m.record('p1', visit());
    await m.flush();
    assert.deepEqual(
      { ...bucket(store, 'hour', '2026-10-17T10:00:00.000Z'), id: undefined },
      { id: undefined, project: 'p1', period: 'hour', start: '2026-10-17T10:00:00.000Z', views: 1, visitors: 1 },
    );
  });
  test('the same visitor counts once; a different IP or browser is another visitor', async () => {
    const { m, store } = setup();
    m.record('p1', visit());
    m.record('p1', visit());
    m.record('p1', visit('198.51.100.1'));
    m.record('p1', visit('203.0.113.7', 'Mozilla/5.0 (Windows NT 10.0) Firefox/130'));
    await m.flush();
    const h = bucket(store, 'hour', '2026-10-17T10:00:00.000Z');
    assert.deepEqual([h.views, h.visitors], [4, 3]);
  });
  test('daily unique visitors are kept separately: a visitor in two hours counts in each hour but once that day', async () => {
    const { m, store, clock } = setup();
    m.record('p1', visit());
    clock.t += 3_600_000;
    m.record('p1', visit());
    m.record('p1', visit('198.51.100.1'));
    await m.flush();
    assert.equal(bucket(store, 'hour', '2026-10-17T10:00:00.000Z').visitors, 1);
    assert.equal(bucket(store, 'hour', '2026-10-17T11:00:00.000Z').visitors, 2);
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
    for (const period of ['hour', 'day']) {
      const b = store.rows.find((r) => r.project === 'p1' && r.period === period);
      assert.deepEqual([b.views, b.visitors], [4, 2], period);
    }
    assert.equal(store.rows.find((r) => r.project === 'p2' && r.period === 'day').visitors, 1);
  });
  test('stored buckets never contain the IP or user agent', async () => {
    const { m, store } = setup();
    m.record('p1', visit('203.0.113.7'));
    await m.flush();
    const stored = JSON.stringify(store.rows);
    assert.doesNotMatch(stored, /203\.0\.113\.7|Safari/);
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
    const h = bucket(store, 'hour', '2026-10-17T10:00:00.000Z');
    assert.deepEqual([h.views, h.visitors], [3, 2]);
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
    assert.deepEqual([h.views, h.visitors], [2, 2]);
    assert.equal(bucket(store, 'day', '2026-10-17T00:00:00.000Z').views, 2);
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
    assert.deepEqual(p1.hours[1], { start: '2026-10-16T12:00:00.000Z', views: 1, visitors: 1 });
    assert.deepEqual(p1.hours[0], { start: '2026-10-16T11:00:00.000Z', views: 0, visitors: 0 });
    assert.deepEqual(p1.hours[23], { start: '2026-10-17T10:00:00.000Z', views: 3, visitors: 2 });
    assert.deepEqual(p1.days, [
      { start: '2026-10-16T00:00:00.000Z', views: 2, visitors: 1 },
      { start: '2026-10-17T00:00:00.000Z', views: 3, visitors: 2 },
    ]);
    // Views in the range; visitors are unique per day, summed over the days the range touches.
    assert.deepEqual([p1.views, p1.visitors], [4, 3]);
  });
  test('an app with no traffic reports zeros', async () => {
    const { m } = setup();
    const { p9 } = await m.report(['p9'], 1);
    assert.deepEqual(p9, { from: '2026-10-17T10:00:00.000Z', to: new Date(T0).toISOString(), views: 0, visitors: 0,
      hours: [{ start: '2026-10-17T10:00:00.000Z', views: 0, visitors: 0 }], days: [{ start: '2026-10-17T00:00:00.000Z', views: 0, visitors: 0 }] });
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
});

describe('ranges', () => {
  test('hours or days, 24h by default, at most 90 days', () => {
    assert.equal(parseRange(undefined), 24);
    assert.equal(parseRange(''), 24);
    assert.equal(parseRange('1h'), 1);
    assert.equal(parseRange('48h'), 48);
    assert.equal(parseRange('7d'), 168);
    assert.equal(parseRange('90d'), 2160);
  });
  test('anything else is a 400 that says what is accepted', () => {
    for (const r of ['0h', '91d', '2161h', 'week', '7', '-1d', '1.5h']) {
      assert.throws(() => parseRange(r), (err) => err.status === 400 && /like 24h or 7d/.test(err.message), r);
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
});
