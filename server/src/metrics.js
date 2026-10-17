// Page views and unique visitors per app. Counted in memory, flushed to cubby_metrics as hourly buckets.
import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './http.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Buckets are in UTC, like job schedules.
const hourStart = (ms) => Math.floor(ms / HOUR) * HOUR;
const dayStart = (ms) => Math.floor(ms / DAY) * DAY;
const iso = (ms) => new Date(ms).toISOString();

export const FLUSH_MS = 60_000;
const MAX_RANGE_HOURS = 90 * 24;

// "24h", "7d" (default 24h) as a number of hours.
export function parseRange(range) {
  if (!range) return 24;
  const m = /^(\d+)(h|d)$/.exec(range);
  const hours = m ? Number(m[1]) * (m[2] === 'd' ? 24 : 1) : 0;
  if (hours < 1 || hours > MAX_RANGE_HOURS) throw new HttpError(400, 'Range must be hours or days, like 24h or 7d (at most 90d)');
  return hours;
}

// Crawlers, link previews, monitors and HTTP libraries. A rough filter: people are what we want to count.
const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|embedly|curl|wget|python|java\/|go-http|okhttp|axios|node-fetch|undici|libwww|httpie|headless|phantom|lighthouse|pagespeed|uptime|pingdom|monitor/i;

// Whether a request for an app's HTML page is a person viewing it. Prefetches aren't (yet) views.
export function countsAsView({ method, headers }) {
  const ua = headers['user-agent'];
  if (method !== 'GET' || !ua || BOT_RE.test(ua)) return false;
  return !/prefetch/i.test(`${headers['sec-purpose'] ?? ''} ${headers.purpose ?? ''}`);
}

// A visitor is a salted hash of IP + user agent: its first 6 bytes as a number (a safe integer below 2^48; collisions
// are negligible at 200k a day). Cheaper in a Set than a string. The raw IP is never kept.
export const visitorId = (salt, ip, ua) => createHash('sha256').update(`${salt}\n${ip}\n${ua}`).digest().readUIntBE(0, 6);

// Visitors remembered per app and UTC day. Past it, new visitors aren't counted (the number becomes a lower
// bound), which keeps memory near 200k * ~42 bytes (about 8.5 MB, measured) per busy app.
export const VISITOR_CAP = 200_000;
// Numeric fields of a bucket, added up across flushes.
const COUNTERS = ['views', 'visitors'];

// Buckets in the cubby_metrics platform collection (superuser only, like every cubby_* collection).
export function pocketbaseStore(admin) {
  const col = () => admin.collection('cubby_metrics');
  return {
    find: ({ project, period, start }) => col()
      .getFirstListItem(admin.filter('project = {:project} && period = {:period} && start = {:start}', { project, period, start: new Date(start) }))
      .catch((err) => { if (err.status === 404) return null; throw err; }),
    create: (bucket) => col().create(bucket),
    update: (id, patch) => col().update(id, patch),
    list: async ({ projects, from }) => {
      if (!projects.length) return [];
      const params = Object.fromEntries(projects.map((p, i) => [`p${i}`, p]));
      const which = projects.map((_, i) => `project = {:p${i}}`).join(' || ');
      return col().getFullList({ filter: admin.filter(`(${which}) && start >= {:from}`, { ...params, from: new Date(from) }), batch: 1000 });
    },
  };
}

export function createMetrics({ store, now = Date.now, newSalt = () => randomBytes(16).toString('hex'), cap = VISITOR_CAP }) {
  let pending = new Map();
  // Visitors already counted today, per project.
  const seen = new Map();
  // The salt lives only in memory and changes every UTC day, so visitors can't be followed across days.
  let day, salt;
  const rotate = (t) => {
    if (dayStart(t) === day) return;
    day = dayStart(t);
    salt = newSalt();
    seen.clear();
  };

  const pend = (project, period, start) => {
    const key = `${project}\t${period}\t${start}`;
    let b = pending.get(key);
    if (!b) pending.set(key, (b = { project, period, start: iso(start), views: 0, ...(period === 'day' && { visitors: 0 }) }));
    return b;
  };
  // Adds one bucket's counters to another (only the counters it has: hourly buckets have no visitors).
  const add = (to, from) => Object.fromEntries(COUNTERS.filter((f) => f in from).map((f) => [f, to[f] + from[f]]));

  // Adds the pending counts to the stored buckets.
  const write = async () => {
    const buckets = [...pending.values()];
    pending = new Map();
    let error;
    for (const b of buckets) {
      try {
        const row = await store.find(b);
        if (row) await store.update(row.id, add(row, b));
        else await store.create(b);
      } catch (err) {
        // Put the counts back, so the next flush writes them.
        error = err;
        const p = pend(b.project, b.period, Date.parse(b.start));
        Object.assign(p, add(p, b));
      }
    }
    if (error) throw error;
  };
  let queue = Promise.resolve();

  return {
    record(project, { ip, ua }) {
      const t = now();
      rotate(t);
      pend(project, 'hour', hourStart(t)).views++;
      const today = pend(project, 'day', day);
      today.views++;
      let ids = seen.get(project);
      if (!ids) seen.set(project, (ids = new Set()));
      const id = visitorId(salt, ip, ua);
      if (!ids.has(id) && ids.size < cap) {
        ids.add(id);
        today.visitors++;
      }
    },
    // Views of each project over the last `hours` hours (including the current one) by hour, and views and unique
    // visitors by UTC day. The visitor total is the days' unique visitors, summed.
    async report(projects, hours) {
      await this.flush();
      const t = now();
      const from = hourStart(t) - (hours - 1) * HOUR;
      const rows = new Map();
      for (const r of await store.list({ projects, from: iso(dayStart(from)) })) rows.set(`${r.project}\t${r.period}\t${Date.parse(r.start)}`, r);
      const series = (project, period, first, step, last) => {
        const out = [];
        for (let s = first; s <= last; s += step) {
          const row = rows.get(`${project}\t${period}\t${s}`);
          out.push({ start: iso(s), views: row?.views ?? 0, ...(period === 'day' && { visitors: row?.visitors ?? 0 }) });
        }
        return out;
      };
      const sum = (list, field) => list.reduce((n, b) => n + b[field], 0);
      return Object.fromEntries(projects.map((p) => {
        const byHour = series(p, 'hour', from, HOUR, t);
        const byDay = series(p, 'day', dayStart(from), DAY, t);
        return [p, { from: iso(from), to: iso(t), views: sum(byHour, 'views'), visitors: sum(byDay, 'visitors'), hours: byHour, days: byDay }];
      }));
    },
    // Flushes every `everyMs` in the background; if the server dies, at most that much is lost.
    start(everyMs = FLUSH_MS) {
      const timer = setInterval(() => this.flush().catch((err) => console.error('metrics:', err.message)), everyMs);
      timer.unref();
      return timer;
    },
    // One flush at a time (the timer, a read and shutdown can overlap), so a bucket is never created twice.
    flush() {
      const run = queue.then(write);
      queue = run.catch(() => {});
      return run;
    },
  };
}
