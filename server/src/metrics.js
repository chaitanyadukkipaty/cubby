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
const MAX_RANGE_HOURS = 365 * 24;
// Hourly buckets are kept this long (then rolled into their day, see rollup); longer ranges report by day only.
export const HOURLY_DAYS = 30;
// Daily buckets are kept a year.
export const DAILY_DAYS = 365;

// "24h", "7d", "1y" (default 24h) as a number of hours.
export function parseRange(range) {
  if (!range) return 24;
  const m = /^(\d+)(h|d|y)$/.exec(range);
  const hours = m ? Number(m[1]) * { h: 1, d: 24, y: 365 * 24 }[m[2]] : 0;
  if (hours < 1 || hours > MAX_RANGE_HOURS) throw new HttpError(400, 'Range must be hours, days or 1y, like 1h, 24h, 7d, 30d (at most 1y)');
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
// `fields` of a bucket, 0 where a row lacks one (rows stored before a field existed, or days not rolled up yet).
const pick = (row, fields) => Object.fromEntries(fields.map((f) => [f, row[f] ?? 0]));
// Numeric fields of a bucket that keep the highest value seen across flushes.
const MAXES = ['peak_active'];

// Top paths: each day bucket keeps its TOP_PATHS most viewed paths (as { path: views }) plus "other" for the rest.
// Real paths start with "/", so "other" can't clash. Between flushes at most PENDING_PATHS distinct paths are counted
// per app; past that, new ones count as "other". Merging keeps the top 10 of (stored + new), so a path that was
// folded into "other" earlier only counts from when it climbs back in: an approximation that keeps rows tiny.
export const TOP_PATHS = 10;
const PENDING_PATHS = 1000;
const PATH_MAX = 200;
// "/a/b?x=1" → "/a/b", at most 200 characters.
export const pathKey = (path) => `/${String(path ?? '').split('?')[0].replace(/^\/+/, '')}`.slice(0, PATH_MAX);
export function topPaths(...lists) {
  const sum = new Map();
  for (const list of lists) for (const [p, n] of Object.entries(list ?? {})) sum.set(p, (sum.get(p) ?? 0) + n);
  let other = sum.get('other') ?? 0;
  sum.delete('other');
  const ranked = [...sum].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [, n] of ranked.slice(TOP_PATHS)) other += n;
  return { ...Object.fromEntries(ranked.slice(0, TOP_PATHS)), ...(other && { other }) };
}

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
    older: async ({ period, before, limit }) => (await col()
      .getList(1, limit, { filter: admin.filter('period = {:period} && start < {:before}', { period, before: new Date(before) }), sort: 'start', skipTotal: true })).items,
    remove: (id) => col().delete(id),
  };
}

// Merges numeric bucket fields: COUNTERS added up, MAXES kept as the highest.
const mergeCounts = (a, b) => Object.fromEntries(Object.keys(b).map((f) => [f, MAXES.includes(f) ? Math.max(a[f] ?? 0, b[f]) : (a[f] ?? 0) + b[f]]));

// Nightly (backups.runMaintenance): hourly buckets of days more than 30 days back are folded into their day bucket
// (API requests and errors added up, the peak kept as the max) and deleted; day buckets more than a year back are
// deleted. Views are already counted per day, so they come from the hours only for a day with no row. A run cut
// short between updating a day and deleting its hours would count those hours twice: rare, and only API counts.
export async function rollupMetrics({ store, now = Date.now, batch = 500 }) {
  const today = dayStart(now());
  let rolled = 0, deleted = 0;
  for (;;) {
    const hours = await store.older({ period: 'hour', before: iso(today - HOURLY_DAYS * DAY), limit: batch });
    if (!hours.length) break;
    const days = new Map();
    for (const h of hours) {
      const key = `${h.project}\t${dayStart(Date.parse(h.start))}`;
      const d = days.get(key) ?? { project: h.project, start: dayStart(Date.parse(h.start)), hours: [], counts: {} };
      d.hours.push(h);
      d.counts = mergeCounts(d.counts, pick(h, ['views', 'api_requests', 'api_errors', 'peak_active']));
      days.set(key, d);
    }
    for (const { project, start, hours: list, counts: { views, ...counts } } of days.values()) {
      const row = await store.find({ project, period: 'day', start: iso(start) });
      if (row) await store.update(row.id, mergeCounts(row, counts));
      else await store.create({ project, period: 'day', start: iso(start), views, visitors: 0, ...counts });
      for (const h of list) await store.remove(h.id);
      rolled += list.length;
    }
  }
  for (;;) {
    const old = await store.older({ period: 'day', before: iso(today - DAILY_DAYS * DAY), limit: batch });
    if (!old.length) break;
    for (const d of old) await store.remove(d.id);
    deleted += old.length;
  }
  return { rolled, deleted };
}

// Admins: every app's report summed, plus the 10 busiest apps by views. Visitors are summed across apps, so one
// person using two apps counts twice.
export function summarizeMetrics(projects, report) {
  const apps = projects.map((p) => {
    const r = report[p.id];
    return { app: p.slug, owner: p.expand?.owner?.email ?? null, views: r.views, visitors: r.visitors, api_requests: r.api_requests, api_errors: r.api_errors, active_now: r.active_now, from: r.from, to: r.to };
  });
  const total = (f) => apps.reduce((n, a) => n + a[f], 0);
  const requests = total('api_requests');
  return {
    from: apps[0]?.from ?? null, to: apps[0]?.to ?? null, apps: apps.length,
    views: total('views'), visitors: total('visitors'), active_now: total('active_now'),
    api_requests: requests, api_errors: total('api_errors'), api_error_rate: requests ? total('api_errors') / requests : 0,
    top_apps: apps.sort((a, b) => b.views - a.views || a.app.localeCompare(b.app)).slice(0, 10).map(({ from, to, ...a }) => a),
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
    if (!b) pending.set(key, (b = { project, period, start: iso(start), views: 0, ...(period === 'day' ? { visitors: 0, paths: {} } : { peak_active: 0, api_requests: 0, api_errors: 0 }) }));
    return b;
  };
  // Merges one bucket's numbers into another's (only the fields it has: hourly buckets have no visitors). Rows stored
  // before a field existed lack it, hence the ?? 0.
  const add = (to, from) => Object.fromEntries([
    ...COUNTERS.filter((f) => f in from).map((f) => [f, (to[f] ?? 0) + from[f]]),
    ...MAXES.filter((f) => f in from).map((f) => [f, Math.max(to[f] ?? 0, from[f])]),
    ...('paths' in from ? [['paths', topPaths(to.paths, from.paths)]] : []),
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
        else await store.create('paths' in b ? { ...b, paths: topPaths(b.paths) } : b);
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
    record(project, { ip, ua, path }) {
      const t = now();
      rotate(t);
      const id = visitorId(salt, ip, ua);
      touch(project, id, t);
      pend(project, 'hour', hourStart(t)).views++;
      const today = pend(project, 'day', day);
      today.views++;
      const key = pathKey(path);
      if (key in today.paths || Object.keys(today.paths).length < PENDING_PATHS) today.paths[key] = (today.paths[key] ?? 0) + 1;
      else today.paths.other = (today.paths.other ?? 0) + 1;
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
      // Up to 30 days: by hour (and day). Longer: whole UTC days only, since older hours were rolled into their day.
      const hourly = hours <= HOURLY_DAYS * 24;
      const from = hourly ? hourStart(t) - (hours - 1) * HOUR : dayStart(t) - (Math.ceil(hours / 24) - 1) * DAY;
      const rows = new Map();
      // Hourly counts added up per day, for the days' API counts and peaks (days not rolled up yet still have hours).
      const hoursOfDay = new Map();
      for (const r of await store.list({ projects, from: iso(dayStart(from)) })) {
        const start = Date.parse(r.start);
        rows.set(`${r.project}\t${r.period}\t${start}`, r);
        if (r.period !== 'hour') continue;
        const key = `${r.project}\t${dayStart(start)}`;
        hoursOfDay.set(key, add(hoursOfDay.get(key) ?? {}, pick(r, ['api_requests', 'api_errors', 'peak_active'])));
      }
      const series = (project, period, first, step, last) => {
        const out = [];
        for (let s = first; s <= last; s += step) {
          const row = rows.get(`${project}\t${period}\t${s}`) ?? {};
          if (period === 'hour') out.push({ start: iso(s), ...pick(row, ['views', 'peak_active', 'api_requests', 'api_errors']) });
          else {
            const rolled = pick(row, ['api_requests', 'api_errors', 'peak_active']);
            out.push({ start: iso(s), ...pick(row, ['views', 'visitors']), ...(hoursOfDay.has(`${project}\t${s}`) ? add(rolled, hoursOfDay.get(`${project}\t${s}`)) : rolled) });
          }
        }
        return out;
      };
      const sum = (list, field) => list.reduce((n, b) => n + b[field], 0);
      return Object.fromEntries(projects.map((p) => {
        const byHour = hourly ? series(p, 'hour', from, HOUR, t) : [];
        const byDay = series(p, 'day', dayStart(from), DAY, t);
        const totals = hourly ? byHour : byDay;
        const [requests, errors] = [sum(totals, 'api_requests'), sum(totals, 'api_errors')];
        const { other, ...named } = topPaths(...byDay.map((d) => rows.get(`${p}\tday\t${Date.parse(d.start)}`)?.paths));
        return [p, {
          from: iso(from), to: iso(t), views: sum(totals, 'views'), visitors: sum(byDay, 'visitors'),
          top_paths: [...Object.entries(named), ...(other ? [['other', other]] : [])].map(([path, views]) => ({ path, views })),
          active_now: this.activeNow(p), peak_active: Math.max(0, ...totals.map((h) => h.peak_active)),
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
