import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nextThreshold, ratchet, METRICS } from '../../scripts/coverage-ratchet.mjs';

const root = resolve(import.meta.dirname, '../..');

test('nextThreshold floors to one decimal and subtracts the margin', () => {
  assert.equal(nextThreshold(0, 99.5), 99.3);
  assert.equal(nextThreshold(0, 84.33), 84.1);
  assert.equal(nextThreshold(0, 95.27), 95);
  assert.equal(nextThreshold(0, 100), 99.8);
});

test('nextThreshold never lowers an existing threshold', () => {
  assert.equal(nextThreshold(99.3, 98), 99.3);
  assert.equal(nextThreshold(99.3, 99.5), 99.3);
  assert.equal(nextThreshold(99.3, 99.9), 99.7);
});

test('ratchet reports only real increases and ignores missing metrics', () => {
  const { config, changes } = ratchet({ lines: 90, branches: 80, 'check-coverage': true }, { lines: { pct: 95.06 }, branches: { pct: 79 } });
  assert.equal(config.lines, 94.8);
  assert.equal(config.branches, 80);
  assert.equal(config['check-coverage'], true);
  assert.deepEqual(changes, ['lines 90 → 94.8']);
});

test('both coverage configs enforce every metric', () => {
  for (const rc of ['.c8rc.json', '.c8rc.unit.json']) {
    const cfg = JSON.parse(readFileSync(resolve(root, rc), 'utf8'));
    assert.equal(cfg['check-coverage'], true, `${rc} must enable check-coverage`);
    for (const m of METRICS) assert.ok(typeof cfg[m] === 'number' && cfg[m] > 0, `${rc} needs a ${m} threshold`);
  }
});
