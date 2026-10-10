// Raises coverage thresholds in .c8rc.json (unit + integration) and .c8rc.unit.json (unit only) to the latest
// measured values, minus a small margin for run-to-run noise. Thresholds only ever go up.
//   npm run coverage && npm run coverage:unit && npm run coverage:ratchet
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const METRICS = ['lines', 'statements', 'functions', 'branches'];
export const MARGIN = 0.2;

// Round the measured % down to one decimal, minus the margin; never below the current threshold.
export function nextThreshold(current, measured, margin = MARGIN) {
  const candidate = Math.round((Math.floor(measured * 10) / 10 - margin) * 10) / 10;
  return Math.max(current ?? 0, candidate);
}

export function ratchet(config, summaryTotal, margin = MARGIN) {
  const next = { ...config };
  const changes = [];
  for (const m of METRICS) {
    const measured = summaryTotal?.[m]?.pct;
    if (typeof measured !== 'number') continue;
    const value = nextThreshold(config[m], measured, margin);
    if (value !== config[m]) changes.push(`${m} ${config[m] ?? 0} → ${value}`);
    next[m] = value;
  }
  return { config: next, changes };
}

function run(root) {
  const pairs = [
    ['.c8rc.json', 'coverage/coverage-summary.json'],
    ['.c8rc.unit.json', 'coverage/unit/coverage-summary.json'],
  ];
  for (const [rc, summary] of pairs) {
    const summaryPath = join(root, summary);
    if (!existsSync(summaryPath)) {
      console.log(`${rc}: skipped (no ${summary}; run the matching coverage command first)`);
      continue;
    }
    const rcPath = join(root, rc);
    const { config, changes } = ratchet(JSON.parse(readFileSync(rcPath, 'utf8')), JSON.parse(readFileSync(summaryPath, 'utf8')).total);
    if (changes.length) writeFileSync(rcPath, JSON.stringify(config, null, 2) + '\n');
    console.log(`${rc}: ${changes.length ? changes.join(', ') : 'no change'}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run(resolve(import.meta.dirname, '..'));
