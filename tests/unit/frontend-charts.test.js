// Unit tests for the dashboard's chart geometry (server/public/js/charts.js): scales, SVG paths, buckets and
// deploy markers. Pure, so it's imported directly; the views only turn its numbers into SVG elements.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as c from '../../server/public/js/charts.js';

test('the charts module has no DOM state, network access or imports beyond pure modules', () => {
  const src = readFileSync(new URL('../../server/public/js/charts.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bfetch\(|localStorage|location\.|document\.|window\./);
  for (const m of src.matchAll(/^import .* from '(.*)';$/gm)) assert.match(m[1], /^\.\/helpers\.js$/);
});

describe('niceMax()', () => {
  test('rounds up to a round number for the top gridline', () => {
    assert.equal(c.niceMax(7), 8);
    assert.equal(c.niceMax(12), 15);
    assert.equal(c.niceMax(610), 800);
    assert.equal(c.niceMax(1000), 1000);
    assert.equal(c.niceMax(0.3), 1);
  });
  test('an empty series still gets a scale', () => assert.equal(c.niceMax(0), 1));
});

const H = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse('2026-10-15T00:00:00Z');
// A GET /api/projects/:slug/metrics report: `hours` buckets plus `days` (UTC) buckets.
const report = (hours, days) => ({ hours, days });

describe('chartBuckets()', () => {
  test('24h: one bucket per hour, with views, peak active and API errors; visitors are only counted per day', () => {
    const r = report([
      { start: iso(T0), views: 3, peak_active: 2, api_requests: 10, api_errors: 1 },
      { start: iso(T0 + H), views: 5, peak_active: 4, api_requests: 20, api_errors: 0 },
    ], [{ start: iso(T0), views: 8, visitors: 3 }]);
    const c24 = c.chartBuckets(r, '24h');
    assert.deepEqual(c24.domain, [T0, T0 + 2 * H]);
    assert.deepEqual(c24.buckets, [
      { start: T0, end: T0 + H, views: 3, visitors: null, peak: 2, requests: 10, errors: 1 },
      { start: T0 + H, end: T0 + 2 * H, views: 5, visitors: null, peak: 4, requests: 20, errors: 0 },
    ]);
  });
  test('7d and 30d: one bucket per UTC day; peak is the day\'s busiest hour and errors add up', () => {
    const D = 24 * H;
    const r = report([
      { start: iso(T0 + 5 * H), views: 1, peak_active: 2, api_requests: 4, api_errors: 1 },
      { start: iso(T0 + 9 * H), views: 2, peak_active: 7, api_requests: 6, api_errors: 2 },
      { start: iso(T0 + D + H), views: 4, peak_active: 1, api_requests: 1, api_errors: 0 },
    ], [{ start: iso(T0), views: 3, visitors: 2 }, { start: iso(T0 + D), views: 4, visitors: 1 }]);
    const c7 = c.chartBuckets(r, '7d');
    assert.deepEqual(c7.domain, [T0, T0 + 2 * D]);
    assert.deepEqual(c7.buckets, [
      { start: T0, end: T0 + D, views: 3, visitors: 2, peak: 7, requests: 10, errors: 3 },
      { start: T0 + D, end: T0 + 2 * D, views: 4, visitors: 1, peak: 1, requests: 1, errors: 0 },
    ]);
  });
});

describe('shared time axis', () => {
  const domain = [0, 400];
  const buckets = [0, 100, 200, 300].map((start, i) => ({ start, end: start + 100, views: [0, 4, 8, 2][i], visitors: null, errors: [0, 3, 0, 1][i] }));

  test('xScale maps a time in the domain onto the width', () => {
    const x = c.xScale(domain, 200);
    assert.equal(x(0), 0);
    assert.equal(x(200), 100);
    assert.equal(x(400), 200);
  });
  test('a line goes through the middle of each bucket, scaled to a round top value', () => {
    const p = c.linePath(buckets, 'views', domain, 400, 100);
    assert.equal(p.max, 8);
    assert.equal(p.line, 'M50,100L150,50L250,0L350,75');
    assert.equal(p.area, 'M50,100L150,50L250,0L350,75L350,100L50,100Z');
  });
  test('a series that has no values (visitors per hour) draws nothing', () => {
    assert.deepEqual(c.linePath(buckets, 'visitors', domain, 400, 100), { line: '', area: '', max: 1 });
  });
  test('bars fill each bucket with a small gap; zero-height bars are left out', () => {
    const bars = c.barRects(buckets, 'errors', domain, 400, 60);
    assert.equal(bars.length, 2);
    assert.deepEqual(bars[0], { x: 101, y: 0, width: 98, height: 60, value: 3, start: 100 });
    assert.deepEqual(bars[1], { x: 301, y: 40, width: 98, height: 20, value: 1, start: 300 });
  });
});

describe('deployMarkers()', () => {
  const deploys = [ // newest first, as GET /deploys returns them
    { id: 'd3', created: '2026-10-15 12:00:00.000Z', current: true },
    { id: 'd2', created: '2026-10-15 06:00:00.000Z' },
    { id: 'd1', created: '2026-10-01 00:00:00.000Z' },
  ];
  test('a vertical line per deploy in range, numbered from the oldest deploy kept', () => {
    const marks = c.deployMarkers(deploys, [T0, T0 + 24 * H], 240);
    assert.deepEqual(marks, [
      { id: 'd2', label: 'v2', x: 60, at: Date.parse('2026-10-15T06:00:00Z'), current: false },
      { id: 'd3', label: 'v3', x: 120, at: Date.parse('2026-10-15T12:00:00Z'), current: true },
    ]);
  });
});

describe('markerLabels()', () => {
  const m = (label, x, current = false) => ({ id: label, label, x, at: x, current });
  test('deploys far enough apart keep a label each', () => {
    assert.deepEqual(c.markerLabels([m('v1', 100), m('v2', 300, true)], 80), [
      { x: 100, label: 'v1', title: 'Deploy v1', current: false },
      { x: 300, label: 'v2', title: 'Deploy v2', current: true },
    ]);
  });
  test('deploys closer than the gap share one label, centred on them, naming the first and last', () => {
    assert.deepEqual(c.markerLabels([m('v1', 900), m('v2', 905), m('v3', 910), m('v4', 920, true)], 80), [
      { x: 910, label: 'v1–v4', title: 'Deploys v1, v2, v3, v4', current: true },
    ]);
  });
  test('a cluster only reaches as far as the gap from its first deploy, so a long run splits', () => {
    assert.deepEqual(c.markerLabels([m('v1', 0), m('v2', 50), m('v3', 100), m('v4', 150)], 80).map((l) => l.label), ['v1–v2', 'v3–v4']);
  });
  test('no markers, no labels', () => assert.deepEqual(c.markerLabels([], 80), []));
});

describe('timeTicks()', () => {
  test('24h: a label every 6 hours, as local times', () => {
    const start = new Date(2026, 9, 15, 0).getTime();
    const ticks = c.timeTicks([start, start + 24 * H], '24h', 240);
    assert.deepEqual(ticks.map((t) => t.label), ['00:00', '06:00', '12:00', '18:00']);
    assert.deepEqual(ticks.map((t) => t.x), [0, 60, 120, 180]);
  });
  test('7d: a label per day; 30d: one a week', () => {
    const start = Date.parse('2026-10-08T00:00:00Z');
    assert.equal(c.timeTicks([start, start + 7 * 24 * H], '7d', 700).length, 7);
    assert.equal(c.timeTicks([start, start + 30 * 24 * H], '30d', 700).length, 5);
    assert.match(c.timeTicks([start, start + 7 * 24 * H], '7d', 700)[0].label, /^Oct \d+$/);
  });
});

describe('sumSeries()', () => {
  test("adds up several apps' daily views by day", () => {
    const a = [{ start: 'd1', views: 1 }, { start: 'd2', views: 2 }];
    const b = [{ start: 'd1', views: 10 }, { start: 'd2', views: 20 }];
    assert.deepEqual(c.sumSeries([a, b], 'views'), [{ start: 'd1', value: 11 }, { start: 'd2', value: 22 }]);
  });
  test('days missing from one series count as 0, and the result stays in time order', () => {
    assert.deepEqual(c.sumSeries([[{ start: 'd2', views: 2 }], [{ start: 'd1', views: 1 }, { start: 'd2', views: 1 }]], 'views'),
      [{ start: 'd1', value: 1 }, { start: 'd2', value: 3 }]);
  });
  test('no apps, no days', () => assert.deepEqual(c.sumSeries([], 'views'), []));
});

describe('sparkline()', () => {
  test('a line through every value, scaled to fill the box (0 at the bottom), plus the area under it', () => {
    const s = c.sparkline([0, 5, 10], 100, 20);
    assert.equal(s.line, 'M0,20L50,10L100,0');
    assert.equal(s.area, 'M0,20L50,10L100,0L100,20L0,20Z');
  });
  test('all zeros lie flat on the bottom; one value spans the width', () => {
    assert.equal(c.sparkline([0, 0], 100, 20).line, 'M0,20L100,20');
    assert.equal(c.sparkline([4], 100, 20).line, 'M0,0L100,0');
  });
  test('no values, no path', () => assert.deepEqual(c.sparkline([], 100, 20), { line: '', area: '' }));
});
