// Unit tests for the dashboard's date and number formatting (server/public/js/helpers.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as f from '../../server/public/js/helpers.js';

describe('parseDate()', () => {
  test('reads PocketBase dates, ISO strings and Date objects alike', () => {
    const iso = '2026-10-17T09:30:00.000Z';
    assert.equal(f.parseDate('2026-10-17 09:30:00.000Z').toISOString(), iso);
    assert.equal(f.parseDate(iso).toISOString(), iso);
    const d = new Date(iso);
    assert.equal(f.parseDate(d), d);
  });
});

describe('shortDate()', () => {
  const now = new Date(2026, 9, 17, 12);
  test('month and day in local time; the year only when it differs from now', () => {
    assert.equal(f.shortDate(new Date(2026, 0, 3, 8), now), 'Jan 3');
    assert.equal(f.shortDate(new Date(2025, 11, 30, 8), now), 'Dec 30, 2025');
  });
});

describe('fmtCount()', () => {
  test('thousands get separators', () => {
    assert.equal(f.fmtCount(0), '0');
    assert.equal(f.fmtCount(5063), '5,063');
    assert.equal(f.fmtCount(1234567), '1,234,567');
  });
  test('missing numbers show a dash', () => {
    assert.equal(f.fmtCount(undefined), '–');
    assert.equal(f.fmtCount(null), '–');
  });
});

describe('fmtPct()', () => {
  test('a rate as a percentage: one decimal under 10%, whole numbers above', () => {
    assert.equal(f.fmtPct(0), '0%');
    assert.equal(f.fmtPct(0.0042), '0.4%');
    assert.equal(f.fmtPct(0.05), '5.0%');
    assert.equal(f.fmtPct(0.257), '26%');
    assert.equal(f.fmtPct(1), '100%');
  });
  test('a tiny but nonzero rate never rounds down to 0%', () => assert.equal(f.fmtPct(0.0001), '<0.1%'));
  test('missing rates show a dash', () => assert.equal(f.fmtPct(undefined), '–'));
});
