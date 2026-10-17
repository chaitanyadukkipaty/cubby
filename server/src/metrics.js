// Page views, unique visitors, active now and /pb API health per app. Counted in memory, flushed to cubby_metrics as
// hourly and daily buckets. Active now (visitors seen in the last 5 minutes) lives only in memory; its hourly peak is
// stored.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HttpError } from './http.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Buckets are in UTC, like job schedules.
const hourStart = (ms) => Math.floor(ms / HOUR) * HOUR;
const dayStart = (ms) => Math.floor(ms / DAY) * DAY;
const iso = (ms) => new Date(ms).toISOString();

// Metrics time. Integration tests move it forward (to see active visitors expire) by writing an offset in ms to the
// file named in CUBBY_TEST_CLOCK_FILE; it's read on every call, so it's for tests only.
export function metricsClock(file) {
  if (!file) return Date.now;
  return () => {
    let offset = 0;
    try { offset = Number(readFileSync(file, 'utf8')) || 0; } catch {}
    return Date.now() + offset;
  };
}

export const FLUSH_MS = 60_000;
// Someone seen in the last 5 minutes is "active now".
export const ACTIVE_MS = 5 * 60_000;
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

// Whether a request comes from a person's browser (what active now counts), going by its user agent.
export const isPerson = (headers) => Boolean(headers['user-agent']) && !BOT_RE.test(headers['user-agent']);

// Whether a request for an app's HTML page is a person viewing it. Prefetches aren't (yet) views.
export function countsAsView({ method, headers }) {
  if (method !== 'GET' || !isPerson(headers)) return false;
  return !/prefetch/i.test(`${headers['sec-purpose'] ?? ''} ${headers.purpose ?? ''}`);
}

// A visitor is a salted hash of IP + user agent: its first 6 bytes as a number (a safe integer below 2^48; collisions
// are negligible at 200k a day). Cheaper in a Set than a string. The raw IP is never kept.
export const visitorId = (salt, ip, ua) => createHash('sha256').update(`${salt}\n${ip}\n${ua}`).digest().readUIntBE(0, 6);

// Visitors remembered per app and UTC day. Past it, new visitors aren't counted (the number becomes a lower
// bound), which keeps memory near 200k * ~42 bytes (about 8.5 MB, measured) per busy app.
export const VISITOR_CAP = 200_000;
// Visitors remembered as active per app (a Map of id to last seen: about 70 bytes each, 3.5 MB at the cap, measured;
// a small app holds a few KB). Past it, newcomers aren't counted until someone drops out, so active now and peaks
// become lower bounds.
export const ACTIVE_CAP = 50_000;
// Numeric fields of a bucket, added up across flushes.
const COUNTERS = ['views', 'visitors', 'api_requests', 'api_errors'];
// Numeric fields of a bucket that keep the highest value seen across flushes.
const MAXES = ['peak_active'];

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

// The app's own accounts (records of its auth collections, names starting with `prefix`), read when asked, never
// stored: the total, signups since `from`, and signups per UTC day for the days the range touches.
export async function appAccounts(admin, prefix, from, to) {
  const names = (await admin.collections.getFullList({ batch: 500, fields: 'name,type' }))
    .filter((c) => c.type === 'auth' && c.name.startsWith(prefix)).map((c) => c.name);
  const first = dayStart(from);
  const days = [];
  for (let s = first; s <= to; s += DAY) days.push({ start: iso(s), signups: 0 });
  let total = 0, fresh = 0;
  for (const name of names) {
    total += (await admin.collection(name).getList(1, 1, { fields: 'id' })).totalItems;
    const since = await admin.collection(name).getFullList({ filter: admin.filter('created >= {:from}', { from: new Date(first) }), fields: 'created', batch: 1000 });
    for (const { created } of since) {
      const t = Date.parse(created.replace(' ', 'T'));
      days[Math.floor((t - first) / DAY)].signups++;
      if (t >= from) fresh++;
    }
  }
  return { total, new: fresh, days };
}

export function createMetrics({ store, now = Date.now, newSalt = () => randomBytes(16).toString('hex'), cap = VISITOR_CAP, activeCap = ACTIVE_CAP }) {
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
    if (!b) pending.set(key, (b = { project, period, start: iso(start), views: 0, ...(period === 'day' ? { visitors: 0 } : { peak_active: 0, api_requests: 0, api_errors: 0 }) }));
    return b;
  };
  // Merges one bucket's numbers into another's (only the fields it has: hourly buckets have no visitors). Rows stored
  // before a field existed lack it, hence the ?? 0.
  const add = (to, from) => Object.fromEntries([
    ...COUNTERS.filter((f) => f in from).map((f) => [f, (to[f] ?? 0) + from[f]]),
    ...MAXES.filter((f) => f in from).map((f) => [f, Math.max(to[f] ?? 0, from[f])]),
  ]);

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

  // When each visitor was last seen, per project.
  const lastSeen = new Map();
  const touch = (project, id, t) => {
    let ids = lastSeen.get(project);
    if (!ids) lastSeen.set(project, (ids = new Map()));
    const active = prune(project, t);
    if (ids.has(id)) ids.delete(id); // re-inserted, so the map stays ordered by last seen
    else if (active >= activeCap) return;
    ids.set(id, t);
    const hour = pend(project, 'hour', hourStart(t));
    hour.peak_active = Math.max(hour.peak_active, ids.size);
  };
  // Forgets visitors not seen for ACTIVE_MS: the oldest come first, so it stops at the first recent one.
  const prune = (project, t) => {
    const ids = lastSeen.get(project);
    if (!ids) return 0;
    for (const [id, at] of ids) {
      if (t - at < ACTIVE_MS) break;
      ids.delete(id);
    }
    return ids.size;
  };

  return {
    // A visitor using the app (a page view or a /pb request): counts towards active now.
    seen(project, { ip, ua }) {
      const t = now();
      rotate(t);
      touch(project, visitorId(salt, ip, ua), t);
    },
    // A response the /pb proxy sent (or PocketBase through it). 5xx responses are errors.
    apiResponse(project, status) {
      const hour = pend(project, 'hour', hourStart(now()));
      hour.api_requests++;
      if (status >= 500) hour.api_errors++;
    },
    activeNow(project) {
      return prune(project, now());
    },
    // A page view (also makes its visitor active).
    record(project, { ip, ua }) {
      const t = now();
      rotate(t);
      const id = visitorId(salt, ip, ua);
      touch(project, id, t);
      pend(project, 'hour', hourStart(t)).views++;
      const today = pend(project, 'day', day);
      today.views++;
      let ids = seen.get(project);
      if (!ids) seen.set(project, (ids = new Set()));
      if (!ids.has(id) && ids.size < cap) {
        ids.add(id);
        today.visitors++;
      }
    },
    // Views of each project over the last `hours` hours (including the current one) by hour, and views and unique
    // visitors by UTC day. The visitor total is the days' unique visitors, summed. Also who is active now, the highest
    // peak of any hour in the range, and /pb requests and 5xx errors (by hour and in total).
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
          const fields = period === 'day' ? ['views', 'visitors'] : ['views', 'peak_active', 'api_requests', 'api_errors'];
          out.push({ start: iso(s), ...Object.fromEntries(fields.map((f) => [f, row?.[f] ?? 0])) });
        }
        return out;
      };
      const sum = (list, field) => list.reduce((n, b) => n + b[field], 0);
      return Object.fromEntries(projects.map((p) => {
        const byHour = series(p, 'hour', from, HOUR, t);
        const byDay = series(p, 'day', dayStart(from), DAY, t);
        const [requests, errors] = [sum(byHour, 'api_requests'), sum(byHour, 'api_errors')];
        return [p, {
          from: iso(from), to: iso(t), views: sum(byHour, 'views'), visitors: sum(byDay, 'visitors'),
          active_now: this.activeNow(p), peak_active: Math.max(0, ...byHour.map((h) => h.peak_active)),
          api_requests: requests, api_errors: errors, api_error_rate: requests ? errors / requests : 0,
          hours: byHour, days: byDay,
        }];
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
