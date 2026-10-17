// Chart geometry for the dashboard's hand-drawn SVG charts: scales, paths, time buckets and deploy markers. Pure
// (no DOM, no network), so tests/unit/frontend-charts.test.js imports it directly; views/chart-ui.js draws the SVG.

const STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** The top of a chart's scale: `n` rounded up to a round number (at least 1). */
export function niceMax(n) {
  if (!(n > 1)) return 1;
  const mag = 10 ** Math.floor(Math.log10(n));
  return STEPS.find((s) => s * mag >= n - 1e-9) * mag;
}

const HOUR = 3600000;
const DAY = 24 * HOUR;

/**
 * The buckets every chart of an app's report shares, so they line up on one time axis: hours for 24h, UTC days for
 * longer ranges. `domain` is [start of the first bucket, end of the last] in ms. Visitors are counted per day only.
 */
export function chartBuckets(report, range) {
  const hours = report.hours.map((b) => ({ ...b, t: Date.parse(b.start) }));
  let buckets;
  if (range === '24h') {
    buckets = hours.map((b) => ({ start: b.t, end: b.t + HOUR, views: b.views, visitors: null, peak: b.peak_active, requests: b.api_requests, errors: b.api_errors }));
  } else {
    buckets = report.days.map((d) => {
      const start = Date.parse(d.start);
      const inDay = hours.filter((b) => b.t >= start && b.t < start + DAY);
      return { start, end: start + DAY, views: d.views, visitors: d.visitors, peak: Math.max(0, ...inDay.map((b) => b.peak_active)),
        requests: inDay.reduce((n, b) => n + b.api_requests, 0), errors: inDay.reduce((n, b) => n + b.api_errors, 0) };
    });
  }
  return { buckets, domain: buckets.length ? [buckets[0].start, buckets.at(-1).end] : [0, 1] };
}

/** A function from a time (ms) in `domain` to an x coordinate in [0, w]. */
export const xScale = ([from, to], w) => (t) => r(((t - from) / (to - from || 1)) * w);

/** A line (and the area under it) through the middle of each bucket's `field`, under a round top value `max`. */
export function linePath(buckets, field, domain, w, h) {
  const pts = buckets.filter((b) => b[field] != null);
  const max = niceMax(Math.max(0, ...pts.map((b) => b[field])));
  if (!pts.length) return { line: '', area: '', max };
  const x = xScale(domain, w);
  const xy = pts.map((b) => [x((b.start + b.end) / 2), r(h - (b[field] / max) * h)]);
  const line = xy.map(([px, py], i) => `${i ? 'L' : 'M'}${px},${py}`).join('');
  return { line, area: `${line}L${xy.at(-1)[0]},${h}L${xy[0][0]},${h}Z`, max };
}

/** A bar per bucket with a nonzero `field`, filling the bucket's width less a 1px gap each side. */
export function barRects(buckets, field, domain, w, h) {
  const max = niceMax(Math.max(0, ...buckets.map((b) => b[field] ?? 0)));
  const x = xScale(domain, w);
  return buckets.filter((b) => b[field] > 0).map((b) => {
    const height = r((b[field] / max) * h);
    return { x: x(b.start) + 1, y: r(h - height), width: Math.max(1, r(x(b.end) - x(b.start) - 2)), height, value: b[field], start: b.start };
  });
}

/**
 * Where deploys fall on the time axis: [{ id, label, x, at, current }] in time order, for those inside `domain`.
 * `deploys` are newest first (GET /api/projects/:slug/deploys); labels count up from the oldest one kept ("v1").
 */
export function deployMarkers(deploys, domain, w) {
  const x = xScale(domain, w);
  return deploys.map((d, i) => ({ id: d.id, label: `v${deploys.length - i}`, at: Date.parse(String(d.created).replace(' ', 'T')), current: Boolean(d.current) }))
    .filter((d) => d.at >= domain[0] && d.at <= domain[1])
    .reverse()
    .map((d) => ({ id: d.id, label: d.label, x: x(d.at), at: d.at, current: d.current }));
}

const pad = (n) => String(n).padStart(2, '0');
const utcDay = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** How a bucket is named in text: its UTC day ("Oct 15") for day buckets, its local hour ("15:00") for 24h. */
export const bucketLabel = (start, range) => (range === '24h' ? `${pad(new Date(start).getHours())}:00` : utcDay(start));

/** Labels under the time axis: every 6 hours (local time) for 24h, every day for 7d, every week for longer. */
export function timeTicks(domain, range, w) {
  const x = xScale(domain, w);
  const ticks = [];
  if (range === '24h') {
    const first = new Date(domain[0]);
    first.setMinutes(0, 0, 0);
    for (let t = first.getTime(); t < domain[1]; t += HOUR) {
      const hr = new Date(t).getHours();
      if (t >= domain[0] && hr % 6 === 0) ticks.push({ x: x(t), label: `${pad(hr)}:00` });
    }
    return ticks;
  }
  const every = range === '7d' ? DAY : 7 * DAY;
  for (let t = domain[0]; t < domain[1]; t += every) ticks.push({ x: x(t), label: utcDay(t) });
  return ticks;
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
