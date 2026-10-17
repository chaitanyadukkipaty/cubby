// Chart geometry for the dashboard's hand-drawn SVG charts: scales, paths, time buckets and deploy markers. Pure
// (no DOM, no network), so tests/unit/frontend-charts.test.js imports it directly; views/chart-ui.js draws the SVG.

const STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** The top of a chart's scale: `n` rounded up to a round number (at least 1). */
export function niceMax(n) {
  if (!(n > 1)) return 1;
  const mag = 10 ** Math.floor(Math.log10(n));
  return STEPS.find((s) => s * mag >= n - 1e-9) * mag;
}

/** Several series of { start, [field] } buckets added up by `start`: [{ start, value }] in time order. */
export function sumSeries(seriesList, field) {
  const totals = new Map();
  for (const series of seriesList) for (const b of series) totals.set(b.start, (totals.get(b.start) ?? 0) + (b[field] ?? 0));
  return [...totals].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([start, value]) => ({ start, value }));
}

// Coordinates with at most one decimal, so paths stay short and tests readable.
const r = (n) => Math.round(n * 10) / 10;

/** A small trend line through `values` in a w×h box (0 at the bottom, the largest value at the top), plus its area. */
export function sparkline(values, w, h) {
  if (!values.length) return { line: '', area: '' };
  const max = Math.max(...values);
  const pts = values.length === 1 ? [[0, values[0]], [w, values[0]]] : values.map((v, i) => [(i / (values.length - 1)) * w, v]);
  const line = pts.map(([x, v], i) => `${i ? 'L' : 'M'}${r(x)},${r(max ? h - (v / max) * h : h)}`).join('');
  return { line, area: `${line}L${r(w)},${h}L0,${h}Z` };
}
