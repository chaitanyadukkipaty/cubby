// Admin storage: where the disk goes, and the backups on it.
// A backup is a pair keyed by date: PocketBase's `cubby-DATE.zip` (pb_data/backups) and `DATA_DIR/backups/sites-DATE.tar.gz`.
// docker/cubby-server parses the same names for `backups` and `restore`, so keep them.
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from './http.js';
import { dirSize } from './sites.js';

const entries = (dir) => readdir(dir, { withFileTypes: true }).catch(() => []);
const sizeOf = async (dir, e) => {
  const p = join(dir, e.name);
  if (e.isDirectory()) return dirSize(p);
  return e.isFile() ? (await stat(p)).size : 0;
};

// Where the bytes under DATA_DIR go, overall and per app. One pass over the tree; nothing is stored.
// `apps` is [{ slug, owner, current_deploy, collectionIds }]. A site folder holds one dir per deploy plus
// `jobs-<deploy>` for its jobs; anything that isn't the current deploy (older deploys kept for rollback, or
// leftovers of a deleted app) counts as older.
export async function scanStorage(dataDir, apps) {
  const breakdown = { database_bytes: 0, uploads_bytes: 0, sites_current_bytes: 0, sites_older_bytes: 0, backups_bytes: 0, other_bytes: 0 };
  // Snapshots, once they exist, get their own category here.
  const perApp = new Map(apps.map((a) => [a.slug, { slug: a.slug, owner: a.owner, total_bytes: 0, current_deploy_bytes: 0, older_deploys_bytes: 0, uploads_bytes: 0 }]));
  const appOfCollection = new Map(apps.flatMap((a) => a.collectionIds.map((id) => [id, perApp.get(a.slug)])));
  const currentOf = new Map(apps.map((a) => [a.slug, a.current_deploy]));

  for (const top of await entries(dataDir)) {
    const topDir = join(dataDir, top.name);
    if (top.name === 'pb_data') {
      for (const e of await entries(topDir)) {
        if (e.name === 'backups') breakdown.backups_bytes += await sizeOf(topDir, e);
        else if (e.name !== 'storage') breakdown.database_bytes += await sizeOf(topDir, e);
        else {
          for (const col of await entries(join(topDir, 'storage'))) {
            const bytes = await sizeOf(join(topDir, 'storage'), col);
            breakdown.uploads_bytes += bytes;
            const app = appOfCollection.get(col.name);
            if (app) app.uploads_bytes += bytes;
          }
        }
      }
    } else if (top.name === 'sites') {
      for (const site of await entries(topDir)) {
        const current = currentOf.get(site.name);
        for (const d of await entries(join(topDir, site.name))) {
          const bytes = await sizeOf(join(topDir, site.name), d);
          const isCurrent = Boolean(current) && (d.name === current || d.name === `jobs-${current}`);
          breakdown[isCurrent ? 'sites_current_bytes' : 'sites_older_bytes'] += bytes;
          const app = perApp.get(site.name);
          if (app) app[isCurrent ? 'current_deploy_bytes' : 'older_deploys_bytes'] += bytes;
        }
      }
    } else if (top.name === 'backups') {
      breakdown.backups_bytes += await sizeOf(dataDir, top);
    } else {
      breakdown.other_bytes += await sizeOf(dataDir, top);
    }
  }
  const list = [...perApp.values()].map((a) => ({ ...a, total_bytes: a.current_deploy_bytes + a.older_deploys_bytes + a.uploads_bytes }));
  return {
    data_bytes: Object.values(breakdown).reduce((sum, n) => sum + n, 0),
    breakdown,
    apps: list.sort((a, b) => b.total_bytes - a.total_bytes || a.slug.localeCompare(b.slug)),
  };
}

export const BACKUP_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DB_RE = /^cubby-(\d{4}-\d{2}-\d{2})\.zip$/;
const SITES_RE = /^sites-(\d{4}-\d{2}-\d{2})\.tar\.gz$/;

// Pairs PocketBase backups ({ key, size }) with site tarballs ({ name, size }) by date, newest first.
export function pairBackups(dbFiles, siteFiles) {
  const byDate = new Map();
  const entry = (date) => byDate.get(date) ?? byDate.set(date, { date, db_bytes: null, sites_bytes: null }).get(date);
  for (const f of dbFiles) {
    const m = DB_RE.exec(f.key);
    if (m) entry(m[1]).db_bytes = f.size;
  }
  for (const f of siteFiles) {
    const m = SITES_RE.exec(f.name);
    if (m) entry(m[1]).sites_bytes = f.size;
  }
  return [...byDate.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((b) => ({ ...b, total_bytes: (b.db_bytes ?? 0) + (b.sites_bytes ?? 0), complete: b.db_bytes !== null && b.sites_bytes !== null }));
}

// The backups on disk, newest first. `pb` is the superuser client (PocketBase owns its own backup folder).
export async function listBackups(pb, dataDir) {
  const dir = join(dataDir, 'backups');
  const names = (await readdir(dir).catch(() => [])).filter((n) => SITES_RE.test(n));
  const siteFiles = await Promise.all(names.map(async (name) => ({ name, size: (await stat(join(dir, name))).size })));
  return pairBackups(await pb.backups.getFullList(), siteFiles);
}

// Deletes both files of a backup (whichever exist). Returns the names removed.
export async function deleteBackup(pb, dataDir, backup) {
  const files = [];
  if (backup.db_bytes !== null) {
    await pb.backups.delete(`cubby-${backup.date}.zip`);
    files.push(`cubby-${backup.date}.zip`);
  }
  if (backup.sites_bytes !== null) {
    await rm(join(dataDir, 'backups', `sites-${backup.date}.tar.gz`), { force: true });
    files.push(`sites-${backup.date}.tar.gz`);
  }
  return files;
}

// Remembers one computed value for `ttlMs` (in memory, per process, like the rest of Cubby's caches).
export function createTtlCache(ttlMs, now = Date.now) {
  let entry = null;
  return {
    get(compute) {
      if (entry && now() - entry.at < ttlMs) return entry.value;
      const value = Promise.resolve().then(compute);
      const mine = (entry = { at: now(), value });
      value.catch(() => { if (entry === mine) entry = null; });
      return value;
    },
    clear() { entry = null; },
  };
}

// Whether `date` may be deleted from `backups` (newest first). Throws if not; returns a warning worth showing.
export function checkBackupDelete(backups, date, { leaveNone = false, running = false } = {}) {
  if (!BACKUP_DATE_RE.test(date)) throw new HttpError(400, 'A backup is named by its date: YYYY-MM-DD');
  if (running) throw new HttpError(409, 'A backup is running. Try again when it finishes.');
  if (!backups.some((b) => b.date === date)) throw new HttpError(404, `No backup for ${date}`);
  if (backups.length === 1 && !leaveNone) {
    throw new HttpError(409, `${date} is the only backup: deleting it leaves nothing to restore until the next one runs. Confirm with leave_none=1 (cubby admin backups delete ${date} --yes --leave-none).`);
  }
  if (backups.length === 1) return { warning: 'That was the only backup: there are no backups left until the next one runs.' };
  if (backups[0].date === date) return { warning: `That was the newest backup: the latest one to restore is now ${backups[1].date}.` };
  return { warning: null };
}
