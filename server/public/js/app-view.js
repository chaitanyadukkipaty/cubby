// The app page's view model: the range in the URL, the KPI strip, top paths and chart descriptions. Pure (no DOM,
// no network), so tests/unit/frontend-app-view.test.js imports it directly; views/app.js draws the page.
import { fmtCount, fmtPct } from './helpers.js';
import { bucketLabel } from './charts.js';

export const RANGES = ['24h', '7d', '30d'];

/** The metrics range from the page's query string ("?range=24h"); 7 days unless it's one the page offers. */
export function rangeFrom(search) {
  const range = new URLSearchParams(search).get('range');
  return RANGES.includes(range) ? range : '7d';
}

const RANGE_TEXT = { '24h': 'last 24 hours', '7d': 'last 7 days', '30d': 'last 30 days' };
// Same threshold as the Home page's "needs a look" (js/feed.js).
const needsLook = (r) => r.api_errors >= 5 && r.api_error_rate >= 0.05;

/** The KPI strip above the charts, from GET /api/projects/:slug/metrics. */
export function kpis(r, range) {
  return [
    { label: 'Active now', value: fmtCount(r.active_now), sub: `peak ${fmtCount(r.peak_active)}` },
    { label: 'Views', value: fmtCount(r.views), sub: RANGE_TEXT[range] ?? range },
    { label: 'Visitors', value: fmtCount(r.visitors), sub: 'unique per day, summed' },
    r.api_requests
      ? { label: 'API error rate', value: fmtPct(r.api_error_rate), sub: `${fmtCount(r.api_errors)} of ${fmtCount(r.api_requests)} requests`, alert: needsLook(r) }
      : { label: 'API error rate', value: '–', sub: 'no API requests', alert: false },
    r.accounts ? { label: 'Accounts', value: fmtCount(r.accounts.total), sub: `+${fmtCount(r.accounts.new)} new` } : { label: 'Accounts', value: '–', sub: '' },
  ];
}

/** Top paths as [{ path, views, share }] (share of the busiest path), or null when the report has none. */
export function topPathRows(r) {
  if (!Array.isArray(r.top_paths)) return null;
  const rows = r.top_paths.map((p) => (Array.isArray(p) ? { path: p[0], views: p[1] } : { path: p.path, views: p.views ?? p.count ?? 0 }));
  const max = Math.max(1, ...rows.map((p) => p.views));
  return rows.map((p) => ({ ...p, share: p.views / max }));
}

/** One sentence describing a chart ("Views: 622 in total, most on Oct 15 (610)."), for its description and table caption. */
export function chartSummary(label, buckets, field, range, { total = true } = {}) {
  const values = buckets.filter((b) => b[field] != null);
  const top = values.reduce((best, b) => (b[field] > (best?.[field] ?? 0) ? b : best), null);
  if (!top) return `${label}: none yet.`;
  const at = `${bucketLabel(top.start, range)} (${fmtCount(top[field])})`;
  if (!total) return `${label}: highest on ${at}.`;
  return `${label}: ${fmtCount(values.reduce((n, b) => n + b[field], 0))} in total, most on ${at}.`;
}
