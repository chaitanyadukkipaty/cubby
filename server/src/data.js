// Clearing an app's data without deleting the app: empty or drop collections, or delete records by filter or id,
// always after writing a snapshot (snapshots.js) that `restore` can bring back.
// Every function takes { pb, dataDir }: the superuser client and DATA_DIR, injectable for unit tests.
import { join } from 'node:path';
import { prefixFor } from './config.js';
import { HttpError } from './http.js';
import { projectCollections, readSchema, deleteCollections, collectionIndex } from './schema.js';
import { dirSize } from './sites.js';
import { startSnapshot, newSnapshotId, expiresAt, FILES_CAP_BYTES } from './snapshots.js';

const PAGE = 500;

// Every record of `name` matching `filter`, a page at a time (so a big collection never sits in memory whole).
async function eachPage(pb, name, filter, fn) {
  for (let page = 1; ; page++) {
    const { items } = await pb.collection(name).getList(page, PAGE, { filter, sort: 'id', skipTotal: true });
    if (items.length) await fn(items);
    if (items.length < PAGE) return;
  }
}

export const storageDir = (dataDir, collectionId) => join(dataDir, 'pb_data', 'storage', collectionId);

// The app's collections (unprefixed names, sorted) with their record counts and uploaded bytes.
export async function listData(slug, { pb, dataDir }) {
  const prefix = prefixFor(slug);
  const cols = await projectCollections(slug, pb.collections);
  const list = await Promise.all(cols.map(async (c) => ({
    name: c.name.slice(prefix.length),
    type: c.type,
    records: (await pb.collection(c.name).getList(1, 1, { fields: 'id' })).totalItems,
    files_bytes: await dirSize(storageDir(dataDir, c.id)),
  })));
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

// "1.5 MB", like the CLI shows sizes.
export function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return i ? `${n.toFixed(1)} ${units[i]}` : `${n} B`;
}

export const authWarning = (name) => `${name} holds user accounts: PocketBase never hands out password hashes, so restored accounts get new random passwords (the restore lists them; the people have to be given theirs).`;

// Relation fields of the app's other collections that point at `targets`: deleting a target record deletes the
// records pointing at it by a cascading relation, and removes it from the others (PocketBase does both).
function dependents(cols, targets) {
  const byId = new Map(targets.map((c) => [c.id, c]));
  return cols.filter((c) => !byId.has(c.id)).flatMap((c) => c.fields
    .filter((f) => f.type === 'relation' && byId.has(f.collectionId))
    .map((f) => ({ col: c, field: f.name, target: byId.get(f.collectionId), deletes: Boolean(f.cascadeDelete) })));
}

// Empties (default) or drops collections of the app, after snapshotting them. `request` is
// { collections: [names], drop }. `project` is { id, slug }; `actor` is { id, email, admin } (admin: an admin
// clearing someone else's app); `reason` is shown to the owner. Records of other collections that point at what's
// cleared (they're deleted by cascade, or lose the reference) are snapshotted too.
export async function clearData(slug, request, { pb, dataDir, project, actor, reason = '', now = Date.now, filesCap = FILES_CAP_BYTES }) {
  const prefix = prefixFor(slug);
  if (!Array.isArray(request.collections) || !request.collections.length) throw new HttpError(400, 'Name the collections to clear, like { "collections": ["tasks"] }');
  const cols = await projectCollections(slug, pb.collections);
  const targets = request.collections.map((name) => {
    const c = cols.find((x) => x.name === prefix + name);
    if (!c) throw new HttpError(404, `Collection "${name}" not found`);
    return c;
  });
  const mode = request.drop ? 'drop' : 'empty';
  const short = (c) => c.name.slice(prefix.length);
  const count = async (name, filter) => (await pb.collection(name).getList(1, 1, { filter, fields: 'id' })).totalItems;
  const summary = await Promise.all(targets.map(async (c) => ({
    name: short(c), type: c.type, records: await count(c.name, ''), files_bytes: await dirSize(storageDir(dataDir, c.id)),
  })));
  const refs = dependents(cols, targets);
  if (mode === 'drop' && refs.length) {
    const [d] = refs;
    throw new HttpError(409, `${short(d.col)}.${d.field} points at ${short(d.target)}: drop ${short(d.col)} too, or empty instead of dropping.`);
  }
  const cascade = await Promise.all(refs.map(async (d) => ({ collection: short(d.col), field: d.field, records: await count(d.col.name, `${d.field} != ""`), deletes: d.deletes })));
  const filesBytes = summary.reduce((n, c) => n + c.files_bytes, 0);
  const withFiles = filesBytes <= filesCap;
  const warnings = [
    ...(withFiles ? [] : [`The uploaded files (${formatBytes(filesBytes)}) are over the ${formatBytes(filesCap)} snapshot cap: they are deleted and can't be restored.`]),
    ...summary.filter((c) => c.type === 'auth').map((c) => authWarning(c.name)),
  ];

  const t = now();
  const snap = await startSnapshot(dataDir, slug, newSnapshotId(t));
  const meta = {
    format: 1, id: snap.id, app: slug, project: project.id, created: new Date(t).toISOString(), expires: expiresAt(t),
    by: actor, reason, mode, collections: summary, cascade, files: withFiles, files_bytes: filesBytes, warnings,
  };
  try {
    const names = new Set(summary.map((c) => c.name));
    await snap.schema({ collections: (await readSchema(slug, pb.collections)).collections.filter((c) => names.has(c.name)) });
    for (const c of targets) {
      await eachPage(pb, c.name, '', async (items) => {
        await snap.records(short(c), items);
        if (withFiles) await snap.files(short(c), storageDir(dataDir, c.id), items.map((r) => r.id));
      });
    }
    for (const col of new Set(refs.map((d) => d.col))) {
      const filter = refs.filter((d) => d.col === col).map((d) => `${d.field} != ""`).join(' || ');
      await eachPage(pb, col.name, filter, (items) => snap.records(short(col), items));
    }
    await snap.finish(meta);
  } catch (err) {
    await snap.discard();
    throw err;
  }

  if (mode === 'drop') {
    await deleteCollections(targets, pb.collections);
    await collectionIndex(slug, { refresh: true }, pb.collections);
  } else {
    for (const c of targets) await pb.collections.truncate(c.id);
  }
  return { mode, collections: summary, cascade, warnings, snapshot: { id: snap.id, expires: meta.expires, files: withFiles, files_bytes: filesBytes } };
}
