// Snapshots: what a data clear deleted, kept 7 days so it can be restored. One folder per snapshot:
//   DATA_DIR/snapshots/<app>/<id>/meta.json        who, why, what, counts, created, expires (written last)
//                                  schema.json      the cleared collections as `cubby schema pull` shows them
//                                  records/<c>.jsonl one record per line, as PocketBase returned it
//                                  files/<c>/<record id>/…  uploaded files, only when they total ≤ 100 MB
// Plain files on purpose: no database rows, nothing running in the background; the nightly maintenance prunes them.
import { randomBytes } from 'node:crypto';
import { appendFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from './http.js';

export const SNAPSHOT_DAYS = 7;
export const FILES_CAP_BYTES = 100 * 1024 * 1024;
export const SNAPSHOT_ID_RE = /^\d{8}T\d{6}-[0-9a-f]{6}$/;
const DAY = 24 * 60 * 60 * 1000;

export const appSnapshotsDir = (dataDir, slug) => join(dataDir, 'snapshots', slug);

// "20261017T101500-a1b2c3": sorts by time, unique enough for one server.
export const newSnapshotId = (now, rand = () => randomBytes(3).toString('hex')) =>
  `${new Date(now).toISOString().replace(/[-:]/g, '').slice(0, 15)}-${rand()}`;

// Starts a snapshot folder. Returns writers for its parts; `finish(meta)` writes meta.json, which makes it complete.
export async function startSnapshot(dataDir, slug, id) {
  const dir = join(appSnapshotsDir(dataDir, slug), id);
  await mkdir(join(dir, 'records'), { recursive: true });
  return {
    id,
    dir,
    schema: (schema) => writeFile(join(dir, 'schema.json'), JSON.stringify(schema, null, 2)),
    // Appends records of collection `name` (unprefixed), one JSON line each.
    async records(name, list) {
      if (list.length) await appendFile(join(dir, 'records', `${name}.jsonl`), list.map((r) => `${JSON.stringify(r)}\n`).join(''));
    },
    // Copies the uploaded files of `recordIds` from `storage` (a collection's storage folder), without thumbnails.
    async files(name, storage, recordIds) {
      for (const id of recordIds) {
        const from = join(storage, id);
        if (!(await stat(from).catch(() => null))) continue;
        await cp(from, join(dir, 'files', name, id), { recursive: true, filter: (src) => !/[/\\]thumbs_[^/\\]*$/.test(src) });
      }
    },
    finish: (meta) => writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2)),
    discard: () => rm(dir, { recursive: true, force: true }),
  };
}

export const expiresAt = (now) => new Date(now + SNAPSHOT_DAYS * DAY).toISOString();

const readMeta = (dir) => readFile(join(dir, 'meta.json'), 'utf8').then(JSON.parse, () => null);
const dirsIn = async (dir) => (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);

// Complete snapshots of `slugs`, newest first.
export async function listSnapshots(dataDir, slugs) {
  const metas = [];
  for (const slug of slugs) {
    for (const id of await dirsIn(appSnapshotsDir(dataDir, slug))) {
      const meta = await readMeta(join(appSnapshotsDir(dataDir, slug), id));
      if (meta) metas.push(meta);
    }
  }
  return metas.sort((a, b) => b.id.localeCompare(a.id));
}

// { meta, dir } of snapshot `id`, whichever app it belongs to.
export async function findSnapshot(dataDir, id) {
  if (!SNAPSHOT_ID_RE.test(String(id))) throw new HttpError(400, 'A snapshot id looks like 20261017T101500-a1b2c3 (see `cubby data snapshots`)');
  for (const slug of await dirsIn(join(dataDir, 'snapshots'))) {
    const dir = join(appSnapshotsDir(dataDir, slug), id);
    const meta = await readMeta(dir);
    if (meta) return { meta, dir };
  }
  throw new HttpError(404, `No snapshot ${id}`);
}

// Nightly: deletes snapshots past their expiry, and unfinished ones (no meta.json) a day old. Returns how many.
export async function pruneSnapshots(dataDir, now = Date.now()) {
  let n = 0;
  for (const slug of await dirsIn(join(dataDir, 'snapshots'))) {
    for (const id of await dirsIn(appSnapshotsDir(dataDir, slug))) {
      const dir = join(appSnapshotsDir(dataDir, slug), id);
      const meta = await readMeta(dir);
      const expired = meta ? Date.parse(meta.expires) <= now : (await stat(dir)).mtimeMs < now - DAY;
      if (expired) {
        await rm(dir, { recursive: true, force: true });
        n++;
      }
    }
  }
  return n;
}

export const removeAppSnapshots = (dataDir, slug) => rm(appSnapshotsDir(dataDir, slug), { recursive: true, force: true });

export const removeSnapshot = (dir) => rm(dir, { recursive: true, force: true });
