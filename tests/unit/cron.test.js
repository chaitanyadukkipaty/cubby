import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, isValidCron, cronMatches, nextRun } from '../../server/src/cron.js';

const at = (iso) => new Date(`${iso}Z`);
const sorted = (set) => [...set].sort((a, b) => a - b);

describe('parseCron', () => {
  test('stars, numbers, lists, ranges and steps', () => {
    const c = parseCron('*/15 9-17/4 1,15 * 1-5');
    assert.deepEqual(sorted(c.minute), [0, 15, 30, 45]);
    assert.deepEqual(sorted(c.hour), [9, 13, 17]);
    assert.deepEqual(sorted(c.dom), [1, 15]);
    assert.equal(c.month.size, 12);
    assert.deepEqual(sorted(c.dow), [1, 2, 3, 4, 5]);
    assert.equal(c.domAny, false);
    assert.equal(c.dowAny, false);
  });
  test('a number with a step runs from there to the end of the range', () => {
    assert.deepEqual(sorted(parseCron('50/5 * * * *').minute), [50, 55]);
  });
  test('day of week 7 is Sunday', () => {
    assert.deepEqual(sorted(parseCron('0 0 * * 7').dow), [0]);
    assert.deepEqual(sorted(parseCron('0 0 * * 5-7').dow), [0, 5, 6]);
  });
  test('extra whitespace is fine', () => assert.ok(parseCron('  0   9 * *  1 ')));
  test('rejects the wrong number of fields', () => {
    for (const bad of ['', '* * * *', '* * * * * *', null, undefined]) assert.throws(() => parseCron(bad), /5 fields/, String(bad));
  });
  test('rejects out-of-range values, inverted ranges, zero steps and junk', () => {
    const cases = [['60 * * * *', /minute "60"/], ['* 24 * * *', /hour/], ['* * 0 * *', /day of month/], ['* * * 13 *', /month/],
      ['* * * * 8', /day of week/], ['5-1 * * * *', /minute/], ['*/0 * * * *', /minute/], ['mon * * * *', /minute "mon"/], ['1,,2 * * * *', /minute ""/]];
    for (const [expr, msg] of cases) assert.throws(() => parseCron(expr), msg, expr);
  });
  test('isValidCron', () => {
    assert.equal(isValidCron('0 9 * * 1'), true);
    assert.equal(isValidCron('0 9 * *'), false);
  });
});

describe('cronMatches (UTC)', () => {
  test('matches minute, hour and month', () => {
    const c = parseCron('30 9 * 10 *');
    assert.equal(cronMatches(c, at('2026-10-13T09:30:00')), true);
    assert.equal(cronMatches(c, at('2026-10-13T09:31:00')), false);
    assert.equal(cronMatches(c, at('2026-10-13T10:30:00')), false);
    assert.equal(cronMatches(c, at('2026-11-13T09:30:00')), false);
  });
  test('only one day field restricted: that one decides', () => {
    const monday = parseCron('0 0 * * 1');
    assert.equal(cronMatches(monday, at('2026-10-12T00:00:00')), true); // a Monday
    assert.equal(cronMatches(monday, at('2026-10-13T00:00:00')), false);
    const first = parseCron('0 0 1 * *');
    assert.equal(cronMatches(first, at('2026-10-01T00:00:00')), true);
    assert.equal(cronMatches(first, at('2026-10-02T00:00:00')), false);
  });
  test('both day fields restricted: either matches (Vixie cron)', () => {
    const c = parseCron('0 0 13 * 1');
    assert.equal(cronMatches(c, at('2026-10-13T00:00:00')), true, 'the 13th (a Tuesday)');
    assert.equal(cronMatches(c, at('2026-10-12T00:00:00')), true, 'a Monday');
    assert.equal(cronMatches(c, at('2026-10-14T00:00:00')), false);
  });
});

describe('nextRun', () => {
  test('the next matching minute, strictly after now', () => {
    const c = parseCron('*/15 * * * *');
    assert.equal(nextRun(c, at('2026-10-13T09:00:00')).toISOString(), '2026-10-13T09:15:00.000Z');
    assert.equal(nextRun(c, at('2026-10-13T09:07:42')).toISOString(), '2026-10-13T09:15:00.000Z');
  });
  test('skips whole days and hours', () => {
    assert.equal(nextRun(parseCron('0 9 * * 1'), at('2026-10-13T10:00:00')).toISOString(), '2026-10-19T09:00:00.000Z');
    assert.equal(nextRun(parseCron('5 3 1 1 *'), at('2026-10-13T10:00:00')).toISOString(), '2027-01-01T03:05:00.000Z');
  });
  test('null when the schedule can never run', () => assert.equal(nextRun(parseCron('0 0 30 2 *'), at('2026-10-13T00:00:00')), null));
});
