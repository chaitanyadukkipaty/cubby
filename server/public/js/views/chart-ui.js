// Draws the dashboard's SVG charts from the geometry in js/charts.js (pure, unit-tested). Every chart has a <title>
// and an accessible name; the numbers it shows are also in text next to it.
import { barRects, bucketLabel, linePath, niceMax, sparkline } from '../charts.js';
import { h, fmtCount } from '../helpers.js';

const NS = 'http://www.w3.org/2000/svg';

/** Like h(), for SVG elements. */
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// Time charts are drawn in a 1000×100 box stretched to the card's width; text (axis, deploy labels) is HTML placed
// by percentage on top, so it never stretches.
const W = 1000;
const PH = 100;
const pct = (x) => `${(x / W) * 100}%`;

/**
 * One chart on the app page's shared time axis. `kind` is 'line' or 'bar'; `markers` are deploys (js/charts.js
 * deployMarkers, computed for width W) drawn through the plot; `summary` (one sentence) is its accessible name, and
 * "Show as table" lists every bucket.
 */
export function timeChart({ id, title, sub, total, field, buckets, domain, markers, ticks, range, summary, kind = 'line' }) {
  const geo = kind === 'bar' ? { bars: barRects(buckets, field, domain, W, PH), max: null } : linePath(buckets, field, domain, W, PH);
  const max = kind === 'bar' ? niceMax(Math.max(0, ...geo.bars.map((b) => b.value))) : geo.max;
  const svg = s('svg', { class: `plot-svg ${kind}`, viewBox: `0 0 ${W} ${PH}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': summary },
    s('title', {}, summary),
    s('line', { x1: 0, x2: W, y1: 0.5, y2: 0.5, class: 'grid', 'vector-effect': 'non-scaling-stroke' }),
    s('line', { x1: 0, x2: W, y1: PH / 2, y2: PH / 2, class: 'grid', 'vector-effect': 'non-scaling-stroke' }),
    s('line', { x1: 0, x2: W, y1: PH - 0.5, y2: PH - 0.5, class: 'base', 'vector-effect': 'non-scaling-stroke' }),
    kind === 'bar'
      ? geo.bars.map((b) => s('rect', { x: b.x, y: b.y, width: b.width, height: b.height, class: 'bar' }))
      : [geo.area ? s('path', { d: geo.area, class: 'area' }) : null, geo.line ? s('path', { d: geo.line, class: 'line', 'vector-effect': 'non-scaling-stroke' }) : null],
    markers.map((m) => s('line', { x1: m.x, x2: m.x, y1: 0, y2: PH, class: 'deploy', 'vector-effect': 'non-scaling-stroke' })));
  const rows = buckets.filter((b) => b[field] != null);
  return h('section', { class: 'chart', 'aria-labelledby': `${id}-h` },
    h('div', { class: 'chart-h' },
      h('h4', { id: `${id}-h` }, title), sub ? h('span', { class: 'muted' }, sub) : null,
      total != null ? h('b', { class: 'num' }, total) : null),
    h('div', { class: 'plot' },
      svg,
      h('span', { class: 'ymax', 'aria-hidden': 'true' }, fmtCount(max)),
      markers.map((m) => h('span', { class: `dmark${m.current ? ' live' : ''}`, style: `left:${pct(m.x)}`, title: `Deploy ${m.label}`, 'aria-hidden': 'true' }, m.label))),
    h('div', { class: 'ticks', 'aria-hidden': 'true' }, ticks.map((t) => h('span', { style: `left:${pct(t.x)}` }, t.label))),
    rows.length ? h('details', { class: 'chart-table small' }, h('summary', { class: 'muted' }, 'Show as table'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('caption', { class: 'sr-only' }, summary),
        h('thead', {}, h('tr', {}, h('th', {}, range === '24h' ? 'Hour' : 'Day (UTC)'), h('th', { class: 'r' }, title))),
        h('tbody', {}, rows.map((b) => h('tr', {}, h('td', {}, bucketLabel(b.start, range)), h('td', { class: 'r num' }, fmtCount(b[field])))))))) : null);
}

/** A small trend line (w×h) labelled for screen readers, e.g. "Views per day, last 7 days: 12, 30, 18…". */
export function sparkSvg(values, { w = 120, h = 28, label }) {
  const { line, area } = sparkline(values, w, h - 2);
  return s('svg', { class: 'spark', viewBox: `0 -1 ${w} ${h}`, width: w, height: h, role: 'img', 'aria-label': label, preserveAspectRatio: 'none' },
    s('title', {}, label),
    area ? s('path', { d: area, class: 'spark-area' }) : null,
    line ? s('path', { d: line, class: 'spark-line', 'vector-effect': 'non-scaling-stroke' }) : null);
}
