// Draws the dashboard's SVG charts from the geometry in js/charts.js (pure, unit-tested). Every chart has a <title>
// and an accessible name; the numbers it shows are also in text next to it.
import { sparkline } from '../charts.js';

const NS = 'http://www.w3.org/2000/svg';

/** Like h(), for SVG elements. */
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/** A small trend line (w×h) labelled for screen readers, e.g. "Views per day, last 7 days: 12, 30, 18…". */
export function sparkSvg(values, { w = 120, h = 28, label }) {
  const { line, area } = sparkline(values, w, h - 2);
  return s('svg', { class: 'spark', viewBox: `0 -1 ${w} ${h}`, width: w, height: h, role: 'img', 'aria-label': label, preserveAspectRatio: 'none' },
    s('title', {}, label),
    area ? s('path', { d: area, class: 'spark-area' }) : null,
    line ? s('path', { d: line, class: 'spark-line', 'vector-effect': 'non-scaling-stroke' }) : null);
}
