// fail2ban on the host bans IPs in its Cubby jails (docker/fail2ban); this side keeps the record behind the Admin
// page's Security tab. The host and the container share one folder ($CUBBY_FAIL2BAN_DIR) and nothing else: never
// fail2ban's socket, which runs any command as root. events/: one JSON file per ban or unban, written by the host.
// requests/: unban requests from Cubby. results/: the host's answers. Every file the host writes is untrusted.
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { HttpError } from './http.js';

const NOT_ENABLED = "fail2ban isn't enabled on this server. On the server run: sudo cubby-server fail2ban enable";

const JAIL_RE = /^cubby-[a-z0-9-]{1,40}$/;

/** A host event file's text as { event, ip, jail, time, bantime }, or null if anything about it is off. */
export function parseEvent(text) {
  let e;
  try { e = JSON.parse(text); } catch { return null; }
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  const { event, ip, jail, time, bantime } = e;
  if (event !== 'ban' && event !== 'unban') return null;
  if (typeof ip !== 'string' || !isIP(ip)) return null;
  if (typeof jail !== 'string' || !JAIL_RE.test(jail)) return null;
  if (!Number.isFinite(time) || time < 0) return null;
  if (event === 'unban') return { event, ip, jail, time, bantime: null };
  // -1 is fail2ban's "forever".
  if (!Number.isFinite(bantime) || bantime < -1) return null;
  return { event, ip, jail, time, bantime };
}

// A host file's text if it's a regular file (never through a symlink) of at most 4 KB, else ''.
const MAX_FILE = 4096;
async function readSmall(file) {
  const st = await lstat(file).catch(() => null);
  if (!st?.isFile() || st.size > MAX_FILE) return '';
  return readFile(file, 'utf8').catch(() => '');
}

export const JAIL_REASONS ={ 'cubby-probe': 'Scanning for secret files', 'cubby-ratelimit': 'Too many login attempts' };
export const BAN_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;

// PocketBase dates ("2026-10-18 18:37:05.000Z", "" when unset) as milliseconds or ISO strings; null when unset.
const ms = (d) => (d ? new Date(String(d).replace(' ', 'T')).getTime() : null);
const isoOrNull = (d) => (d ? new Date(ms(d)).toISOString() : null);

/** Records in memory, with the same interface as pocketbaseStore. For tests. */
export function memoryStore() {
  const rows = new Map();
  let n = 0;
  return {
    rows,
    create: async (rec) => { const r = { id: `ban${++n}`, unbanned_at: '', unbanned_by: '', hosts: [], paths: [], ...rec }; rows.set(r.id, r); return { ...r }; },
    update: async (id, patch) => { Object.assign(rows.get(id), patch); return { ...rows.get(id) }; },
    // The newest record of this ip and jail that wasn't unbanned.
    findOpen: async ({ ip, jail }) => [...rows.values()].filter((r) => r.ip === ip && r.jail === jail && !r.unbanned_at)
      .sort((a, b) => ms(b.banned_at) - ms(a.banned_at))[0] ?? null,
    // Every record of this ip that wasn't unbanned, in any jail.
    openFor: async (ip) => [...rows.values()].filter((r) => r.ip === ip && !r.unbanned_at).map((r) => ({ ...r })),
    since: async (from) => [...rows.values()].filter((r) => ms(r.banned_at) >= ms(from)).map((r) => ({ ...r })),
    removeBefore: async (before) => {
      let gone = 0;
      for (const r of [...rows.values()]) if (ms(r.banned_at) < ms(before)) gone += rows.delete(r.id);
      return gone;
    },
  };
}

/** The records in the cubby_bans platform collection (rules null: only the server reads them). */
export function bansStore(admin) {
  const col = () => admin.collection('cubby_bans');
  return {
    create: (rec) => col().create(rec),
    update: (id, patch) => col().update(id, patch),
    findOpen: ({ ip, jail }) => col()
      .getFirstListItem(admin.filter('ip = {:ip} && jail = {:jail} && unbanned_at = ""', { ip, jail }), { sort: '-banned_at' })
      .catch((err) => { if (err.status === 404) return null; throw err; }),
    openFor: (ip) => col().getFullList({ filter: admin.filter('ip = {:ip} && unbanned_at = ""', { ip }) }),
    since: (from) => col().getFullList({ filter: admin.filter('banned_at >= {:from}', { from: new Date(from) }), sort: '-banned_at', batch: 1000 }),
    async removeBefore(before) {
      const filter = admin.filter('banned_at < {:before}', { before: new Date(before) });
      let gone = 0;
      for (;;) {
        const { items } = await col().getList(1, 200, { filter, fields: 'id', skipTotal: true });
        if (!items.length) return gone;
        for (const r of items) await col().delete(r.id);
        gone += items.length;
      }
    },
  };
}

/** Nightly (backups.MAINTENANCE): records of bans from more than 90 days ago go, IPs and sweeps with them. */
export const pruneBans = (store, now = new Date()) => store.removeBefore(new Date(now.getTime() - BAN_DAYS * DAY).toISOString());

/** GET /api/admin/bans from records of the last 90 days: bans in force now, and the rest, newest first. */
export function bansView(records, now = new Date()) {
  const sorted = [...records].sort((a, b) => ms(b.banned_at) - ms(a.banned_at));
  const view = (r) => ({
    id: r.id, ip: r.ip, jail: r.jail, reason: JAIL_REASONS[r.jail] ?? r.jail,
    banned_at: isoOrNull(r.banned_at), expires_at: isoOrNull(r.expires_at), unbanned_at: isoOrNull(r.unbanned_at), unbanned_by: r.unbanned_by || null,
    hosts: r.hosts ?? [], paths: r.paths ?? [],
    seen_before: sorted.filter((o) => o.ip === r.ip && ms(o.banned_at) < ms(r.banned_at)).length,
  });
  const inForce = (r) => !r.unbanned_at && (!r.expires_at || ms(r.expires_at) > now.getTime());
  return { current: sorted.filter(inForce).map(view), history: sorted.filter((r) => !inForce(r)).map(view) };
}

const SWEEP_MAX = 50;

/**
 * What `ip` asked for in Caddy's JSON access log during the day before `at` (ms): the hosts it swept and up to 50
 * distinct paths, in order. Streams the file (Caddy rolls it at 10 MB); a missing file is an empty sweep.
 */
export async function sweepOf(file, ip, at) {
  const hosts = new Set();
  const paths = new Set();
  if (!file || !(await lstat(file).catch(() => null))?.isFile()) return { hosts: [], paths: [] };
  const needle = `"client_ip":${JSON.stringify(ip)}`;
  const lines = createInterface({ input: createReadStream(file).on('error', () => {}), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes(needle)) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      const t = Date.parse(r?.ts);
      if (r?.request?.client_ip !== ip || !(t >= at - DAY && t <= at + 60_000)) continue;
      if (typeof r.request.host === 'string' && hosts.size < SWEEP_MAX) hosts.add(r.request.host.slice(0, 200));
      if (typeof r.request.uri === 'string' && paths.size < SWEEP_MAX) paths.add(r.request.uri.slice(0, 300));
    }
  } catch {
    // Unreadable (or gone): what was read so far.
  }
  return { hosts: [...hosts], paths: [...paths] };
}

/**
 * The Security tab's side of fail2ban. `dir` is $CUBBY_FAIL2BAN_DIR (unset: fail2ban isn't enabled on the host),
 * `accessLog` Caddy's JSON access log. `store` holds the records (pocketbaseStore in the server).
 */
export function createBans({ dir, accessLog, store, now = () => new Date(), log = console, waitMs = 10_000, pollMs = 100 }) {
  const eventsDir = dir && join(dir, 'events');

  // A record is open from its ban until its unban or expiry; `at` in milliseconds.
  const stillOpen = (r, at) => r && (!r.expires_at || ms(r.expires_at) > at);

  // Unbans asked for from the dashboard or CLI, by IP: who asked, until the host's unban event names them.
  const asked = new Map();

  async function apply(e) {
    const at = e.time * 1000;
    const open = await store.findOpen(e);
    if (e.event === 'unban') {
      if (!open) return;
      const expired = open.expires_at && at >= ms(open.expires_at) - 2000;
      const by = asked.get(e.ip) ?? (expired ? 'expired' : 'on the server (cubby-server or fail2ban)');
      await store.update(open.id, { unbanned_at: new Date(at).toISOString(), unbanned_by: by });
      return;
    }
    const expires = e.bantime === -1 ? '' : new Date(at + e.bantime * 1000).toISOString();
    // fail2ban re-issues every active ban when it restarts: the same ban again, so keep one record (the later expiry).
    if (stillOpen(open, at)) {
      const longer = !expires || (open.expires_at && ms(expires) > ms(open.expires_at));
      if (longer) await store.update(open.id, { expires_at: expires });
      return;
    }
    // A ban that ran out without an unban event (missed while Cubby was down) ends at its expiry.
    if (open) await store.update(open.id, { unbanned_at: new Date(ms(open.expires_at)).toISOString(), unbanned_by: 'expired' });
    // Scanners sweep many apps; the record says which, and what they looked for.
    const sweep = e.jail === 'cubby-probe' ? await sweepOf(accessLog, e.ip, at) : { hosts: [], paths: [] };
    await store.create({ ip: e.ip, jail: e.jail, banned_at: new Date(at).toISOString(), expires_at: expires, ...sweep });
  }

  // Reads the events the host wrote, oldest first by their time, and removes their files.
  async function readEvents() {
    const names = (await readdir(eventsDir).catch(() => [])).filter((n) => !n.startsWith('.')).sort();
    const events = [];
    for (const name of names) {
      const file = join(eventsDir, name);
      const e = parseEvent(await readSmall(file));
      await rm(file, { force: true, recursive: true });
      if (e) events.push(e);
      else log.error(`ignored a bad fail2ban event (${name.slice(0, 80)})`);
    }
    events.sort((a, b) => a.time - b.time);
    for (const e of events) await apply(e);
    return events.length;
  }

  // One read at a time (the poller, the API and unbans all read), so no event is read twice.
  let queue = Promise.resolve();
  const ingest = () => {
    if (!dir) return Promise.resolve(0);
    const run = queue.then(readEvents);
    queue = run.catch(() => {});
    return run;
  };

  // Writes the request through tmp/ (the host acts on anything that appears in requests/) and waits for the
  // answer in results/. Unanswered, the request is taken back.
  async function askHost(ip) {
    const id = randomBytes(16).toString('hex');
    const request = join(dir, 'requests', `${id}.json`);
    const result = join(dir, 'results', `${id}.json`);
    const temp = join(dir, 'tmp', `${id}.json`);
    await writeFile(temp, JSON.stringify({ id, action: 'unban', ip }));
    await rename(temp, request);
    let answer = '';
    for (const end = Date.now() + waitMs; !answer && Date.now() < end;) {
      await new Promise((r) => setTimeout(r, pollMs));
      answer = await readSmall(result);
    }
    if (!answer) {
      await rm(request, { force: true });
      throw new HttpError(504, "The host didn't answer. Check: sudo cubby-server fail2ban status");
    }
    await rm(result, { force: true });
    let res;
    try { res = JSON.parse(answer); } catch {}
    if (res?.ok !== true) throw new HttpError(422, typeof res?.error === 'string' ? res.error.slice(0, 300) : "The host couldn't unban it");
  }

  return {
    enabled: Boolean(dir),
    ingest,
    // Asks the host to lift every ban of `ip` (fail2ban-client unban <ip>) and waits for its answer. The host checks
    // the request again; all Cubby can ever ask for is the unban of an address.
    async unban(ip, user) {
      if (!dir) throw new HttpError(409, NOT_ENABLED);
      if (typeof ip !== 'string' || !isIP(ip)) throw new HttpError(400, 'Not an IP address');
      await ingest();
      const at = now().getTime();
      const open = (await store.openFor(ip)).filter((r) => stillOpen(r, at));
      if (!open.length) throw new HttpError(404, `${ip} isn't banned`);
      const by = `admin ${user.email}`;
      asked.set(ip, by);
      try {
        await askHost(ip);
        await ingest(); // the host's own unban events, if they're in already
        for (const r of await store.openFor(ip)) {
          if (open.some((o) => o.id === r.id)) await store.update(r.id, { unbanned_at: new Date(at).toISOString(), unbanned_by: by });
        }
      } finally {
        asked.delete(ip);
      }
      return { ok: true, ip, jails: [...new Set(open.map((r) => r.jail))].sort() };
    },
    prune: () => pruneBans(store, now()),
    // Picks up the host's events every few seconds, so bans are recorded (with their sweep, while the access log
    // still has it) even when nobody opens the Security tab.
    start(everyMs = 3000) {
      if (!dir) return null;
      const timer = setInterval(() => ingest().catch((err) => log.error('fail2ban events:', err.message)), everyMs);
      timer.unref();
      return timer;
    },
    async list() {
      await ingest();
      const t = now();
      return { enabled: Boolean(dir), ...bansView(await store.since(new Date(t.getTime() - BAN_DAYS * DAY).toISOString()), t) };
    },
  };
}

