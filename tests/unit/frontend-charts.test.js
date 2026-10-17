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
