// Clearing an app's data without deleting the app: empty or drop collections, or delete records by filter or id,
// always after writing a snapshot (snapshots.js) that `restore` can bring back.
// Every function takes { pb, dataDir }: the superuser client and DATA_DIR, injectable for unit tests.
import { join } from 'node:path';
import { prefixFor } from './config.js';
import { HttpError, clip } from './http.js';
import { projectCollections, readSchema, deleteCollections, collectionIndex } from './schema.js';
import { dirSize } from './sites.js';
import { checkForeignRefs } from './proxy.js';
import { startSnapshot, newSnapshotId, expiresAt, FILES_CAP_BYTES } from './snapshots.js';
import { planCascade } from './cascade.js';

const PAGE = 500;

// Every record of `name` matching `filter`, a page at a time (so a big collection never sits in memory whole), with
// only `fields` when given.
export async function eachPage(pb, name, filter, fn, fields) {
  for (let page = 1; ; page++) {
    const { items } = await pb.collection(name).getList(page, PAGE, { filter, sort: 'id', skipTotal: true, ...(fields && { fields }) });
    if (items.length) await fn(items);
    if (items.length < PAGE) return;
  }
}

// A delete-by-filter runs as superuser, past every rule, so its filter gets the proxy's check (no `@collection.` of
// another app or a platform collection, on decoded text) plus one for back-relations (`<collection>_via_<field>`),
// which name another collection too. The collection itself is always this app's (the caller resolves it).
export const FILTER_MAX = 2000;
export function checkDataFilter(filter, prefix) {
  if (typeof filter !== 'string' || !filter.trim() || filter.length > FILTER_MAX) throw new HttpError(400, `A filter is a PocketBase filter of 1-${FILTER_MAX} characters, like 'done = true'`);
  const { foreign } = checkForeignRefs(filter, null, prefix);
  const via = [...filter.matchAll(/([a-zA-Z0-9_]+)_via_[a-zA-Z0-9_]+/g)].map((m) => m[1]).find((name) => !name.startsWith(prefix));
  const bad = foreign ?? via;
  if (bad) throw new HttpError(403, `Cannot reference collection "${bad}" from this app.`);
}

// Runs `fn` once every earlier data change of app `slug` (clear, restore, schema push or drop) is done, so they never
// interleave: a clear's cascade check holds until its deletes are done. Cubby is one process, so a queue in memory is
// enough (like its other in-memory state).
const queues = new Map();
export function oneAtATime(slug, fn) {
  const run = (queues.get(slug) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  queues.set(slug, tail);
  tail.then(() => { if (queues.get(slug) === tail) queues.delete(slug); });
  return run;
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

// Relation fields of the app's other collections that point at `targets` (which can't be dropped without them).
function dependents(cols, targets) {
  const byId = new Map(targets.map((c) => [c.id, c]));
  return cols.filter((c) => !byId.has(c.id)).flatMap((c) => c.fields
    .filter((f) => f.type === 'relation' && byId.has(f.collectionId))
    .map((f) => ({ col: c, field: f.name, target: byId.get(f.collectionId), deletes: Boolean(f.cascadeDelete) })));
}

export const MAX_MATCHES = 10_000;
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const CHUNK = 100;
export const chunks = (list) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));
const anyOf = (pb, field, ids, op) =>
  pb.filter(ids.map((_, i) => `${field} ${op} {:i${i}}`).join(' || '), Object.fromEntries(ids.map((id, i) => [`i${i}`, id])));
// `id = "a" || id = "b"`.
export const byIds = (pb, ids) => anyOf(pb, 'id', ids, '=');
// Records whose relation `field` holds any of `ids`. `field.id ?=` works whether it holds one id or several; a plain
// `field ?= id` matches nothing on a relation holding several in PocketBase 0.40.5.
export const idsIn = (pb, field, ids) => anyOf(pb, `${field}.id`, ids, '?=');

// What a clear request asks for: whole collections (`collections`, emptied or with `drop` dropped), every collection
// dropped (`wipe`), or records of one `collection`, by `filter` or by `ids`.
function readRequest(r) {
  const bad = (msg) => new HttpError(400, msg);
  if (r.wipe) {
    if (['collection', 'collections', 'filter', 'ids'].some((k) => r[k] !== undefined)) throw bad('"wipe" drops every collection: it goes alone');
    return { mode: 'drop', wipe: true };
  }
  if (r.collection !== undefined) {
    if (r.collections !== undefined || r.drop) throw bad('Clear whole collections ("collections", optionally "drop") or records of one "collection" by "filter" or "ids", not both');
    if ((r.filter === undefined) === (r.ids === undefined)) throw bad('Give "filter" or "ids" (not both) to delete records of a collection');
    if (r.ids !== undefined && (!Array.isArray(r.ids) || !r.ids.length || !r.ids.every((id) => ID_RE.test(String(id))))) throw bad('"ids" is a list of record ids');
    return { mode: r.ids ? 'ids' : 'filter', names: [String(r.collection)], filter: r.filter, ids: r.ids && [...new Set(r.ids.map(String))] };
  }
  if (r.filter !== undefined || r.ids !== undefined) throw bad('"filter" and "ids" go with one "collection"');
  if (!Array.isArray(r.collections) || !r.collections.length) throw bad('Name the collections to clear, like { "collections": ["tasks"] }');
  return { mode: r.drop ? 'drop' : 'empty', names: r.collections.map(String) };
}

// Clears data of the app, after snapshotting what goes. `request` is { collections: [names], drop } or
// { collection, filter | ids, all_matching }, plus dry_run (report, delete nothing). `project` is { id, slug };
// `actor` is { id, email, admin } (admin: an admin clearing someone else's app); `reason` is shown to the owner.
// Records that point at what's cleared (deleted by cascade however many hops away, self-relations included, or
// losing the reference) are snapshotted too (cascade.js works them out). A filter runs as superuser: it passes checkDataFilter first.
export async function clearData(slug, request, { pb, dataDir, project, actor, reason = '', now = Date.now, filesCap = FILES_CAP_BYTES, maxMatches = MAX_MATCHES }) {
  const prefix = prefixFor(slug);
  const req = readRequest(request ?? {});
  if (req.mode === 'filter') checkDataFilter(req.filter, prefix);
  const cols = await projectCollections(slug, pb.collections);
  if (req.wipe) {
    if (!cols.length) throw new HttpError(400, `${slug} has no collections to wipe`);
    req.names = cols.map((c) => c.name.slice(prefix.length));
  }
  const targets = req.names.map((name) => {
    const c = cols.find((x) => x.name === prefix + name);
    if (!c) throw new HttpError(404, `Collection "${clip(name)}" not found`);
    return c;
  });
  const short = (c) => c.name.slice(prefix.length);
  const count = async (name, filter) => (await pb.collection(name).getList(1, 1, { filter, fields: 'id' })).totalItems;
  const refs = dependents(cols, targets);
  if (req.mode === 'drop' && refs.length) {
    const [d] = refs;
    throw new HttpError(409, `${short(d.col)}.${d.field} points at ${short(d.target)}: drop ${short(d.col)} too, or empty instead of dropping.`);
  }

  // What matches: everything in whole-collection modes; otherwise the ids of the matching records.
  let matched = null;
  let total, missing;
  if (req.mode === 'filter' || req.mode === 'ids') {
    const [c] = targets;
    total = await count(c.name, '');
    const filters = req.mode === 'ids' ? chunks(req.ids).map((ids) => byIds(pb, ids)) : [req.filter];
    const tooMany = (what, n) => {
      if (n > maxMatches && !request.all_matching) throw new HttpError(409, `${what} ${n} records, more than ${maxMatches}. Narrow it, or confirm with all_matching (--all-matching).`);
    };
    // A filter is counted before its ids are read; ids given are looked up first (the limit is on what matches).
    if (req.mode === 'filter') {
      tooMany('The filter matches', await count(c.name, req.filter).catch((err) => {
        if (err.status === 400) throw new HttpError(400, `PocketBase rejected the filter: ${err.response?.message ?? err.message}`);
        throw err;
      }));
    }
    matched = [];
    for (const filter of filters) await eachPage(pb, c.name, filter, (items) => { matched.push(...items.map((r) => r.id)); });
    if (req.mode === 'ids') {
      tooMany('Those ids match', matched.length);
      const found = new Set(matched);
      missing = req.ids.filter((id) => !found.has(id));
    }
  }
  // Uploaded bytes of records `ids` of collection id `col`.
  const sizeOf = async (col, ids) => (await Promise.all(ids.map((id) => dirSize(join(storageDir(dataDir, col), id))))).reduce((a, b) => a + b, 0);
  const summary = await Promise.all(targets.map(async (c) => {
    const files = matched ? await sizeOf(c.id, matched) : await dirSize(storageDir(dataDir, c.id));
    return { name: short(c), type: c.type, records: matched ? matched.length : await count(c.name, ''), files_bytes: files };
  }));
  const matches = summary.reduce((n, c) => n + c.records, 0);
  // Everything else PocketBase deletes or unlinks along with them, however many hops away.
  const plan = await planCascade(pb, cols, targets, matched);
  const cascade = plan.entries.map((e) => ({ collection: short(e.col), field: e.field, records: e.records, deletes: e.deletes }));
  // Uploads of the records that go by cascade count toward the cap too, and go in the snapshot with them.
  let cascadeBytes = 0;
  for (const [col, ids] of plan.deleted) cascadeBytes += await sizeOf(col, ids);
  const filesBytes = summary.reduce((n, c) => n + c.files_bytes, 0) + cascadeBytes;
  const withFiles = filesBytes <= filesCap;
  const warnings = [
    ...(withFiles ? [] : [`The uploaded files (${formatBytes(filesBytes)}) are over the ${formatBytes(filesCap)} snapshot cap: they are deleted and can't be restored.`]),
    ...summary.filter((c) => c.type === 'auth').map((c) => authWarning(c.name)),
  ];
  const blocked = plan.blocked.map((b) => blockedText(short(b.col), b.field, short(b.target), b.ids));
  const result = {
    mode: req.mode, ...(req.wipe && { wipe: true }), collections: summary, matches, total: total ?? matches, ...(missing && { missing }),
    ...(req.mode === 'filter' && { filter: req.filter }), cascade, blocked, warnings, files: withFiles, files_bytes: filesBytes,
    // Records deleted by cascade, and records that stay but lose links: each counted once.
    cascade_deleted: [...plan.deleted.values()].reduce((n, ids) => n + ids.length, 0),
    unlinked: [...plan.unlinked.values()].reduce((n, ids) => n + ids.length, 0),
  };
  // Each matched collection's records, a page at a time.
  const eachMatch = async (c, fn) => {
    if (!matched) return eachPage(pb, c.name, '', fn);
    for (const ids of chunks(matched)) await eachPage(pb, c.name, byIds(pb, ids), fn);
  };
  if (request.dry_run) {
    const samples = [];
    for (const c of targets) {
      if (samples.length >= 5) break;
      const filter = matched ? byIds(pb, matched.slice(0, 5)) : '';
      if (!matched || matched.length) samples.push(...(await pb.collection(c.name).getList(1, 5 - samples.length, { filter, sort: 'id', skipTotal: true })).items);
    }
    return { dry_run: true, ...result, samples };
  }
  // Nothing to delete (a filter or ids matching nothing, collections with no records): nothing changes, no snapshot.
  if (req.mode !== 'drop' && !matches) return { ...result, snapshot: null };
  // PocketBase would refuse (part of) the delete: refuse it now, before anything is snapshotted or deleted.
  if (blocked.length) throw new HttpError(409, `Can't clear: ${blocked.length === 1 ? 'a required relation' : 'required relations'} would point at nothing`, blocked);

  const t = now();
  const snap = await startSnapshot(dataDir, slug, newSnapshotId(t));
  const meta = {
    format: 1, id: snap.id, app: slug, project: project.id, created: new Date(t).toISOString(), expires: expiresAt(t),
    by: actor, reason, ...result, ...(req.ids && { ids: matched }),
  };
  try {
    const others = cols.filter((c) => plan.deleted.has(c.id) || plan.unlinked.has(c.id));
    const names = [...new Set([...summary.map((c) => c.name), ...others.map(short)])];
    const live = (await readSchema(slug, pb.collections)).collections;
    await snap.schema({ collections: names.map((n) => live.find((c) => c.name === n)) });
    for (const c of targets) {
      await eachMatch(c, async (items) => {
        await snap.records(short(c), items);
        if (withFiles) await snap.files(short(c), storageDir(dataDir, c.id), items.map((r) => r.id));
      });
    }
    // What goes by cascade, and what stays but loses links, as it is before the clear.
    for (const col of others) {
      const deleted = plan.deleted.get(col.id) ?? [];
      for (const part of chunks(deleted)) await eachPage(pb, col.name, byIds(pb, part), (items) => snap.records(short(col), items));
      if (withFiles && deleted.length) await snap.files(short(col), storageDir(dataDir, col.id), deleted);
      for (const part of chunks(plan.unlinked.get(col.id) ?? [])) await eachPage(pb, col.name, byIds(pb, part), (items) => snap.links(short(col), items));
    }
    await snap.finish(meta);
  } catch (err) {
    await snap.discard();
    throw err;
  }

  const done = { ...result, snapshot: { id: snap.id, expires: meta.expires, files: withFiles, files_bytes: filesBytes } };
  // PocketBase refuses (400) a delete that would leave a required relation empty, and runs each delete (with its
  // cascade) or truncate in a transaction. One refused only for the order (it points at another that goes too) goes
  // through once the other is gone: refused ones are tried again while that gets any further.
  let progress = false;
  const inTurn = async (list, del) => {
    let pending = list;
    while (pending.length) {
      const refused = [];
      let last;
      for (const x of pending) {
        try {
          await del(x);
          progress = true;
        } catch (err) {
          if (err.status === 404) continue; // gone already (deleted meanwhile, or by a cascade): fine
          if (err.status !== 400) throw err;
          refused.push(x);
          last = err;
        }
      }
      if (refused.length === pending.length) throw last;
      pending = refused;
    }
  };
  try {
    if (req.mode === 'drop') {
      await deleteCollections(targets, pb.collections).catch(async (err) => {
        const left = new Set((await projectCollections(slug, pb.collections)).map((c) => c.id));
        progress = targets.some((c) => !left.has(c.id));
        throw err;
      });
      await collectionIndex(slug, { refresh: true }, pb.collections);
    } else if (req.mode === 'empty') {
      await inTurn(targets, (c) => pb.collections.truncate(c.id));
    } else {
      // Exactly the records snapshotted.
      await inTurn(matched, (id) => pb.collection(targets[0].name).delete(id));
    }
  } catch (err) {
    // Something changed since the check (a record linked meanwhile): what was deleted stays in the snapshot and is
    // reported (err.cleared, for the activity log); the snapshot of a clear that deleted nothing goes.
    const out = err.status === 400
      ? new HttpError(409, `PocketBase refused to delete: ${err.response?.message || err.message}${progress ? ' Some records were deleted before that: the snapshot keeps them.' : ' Nothing was deleted.'}`)
      : err;
    if (progress) out.cleared = done;
    else await snap.discard();
    throw out;
  }
  return done;
}

// "lines.item must point at an items record and doesn't cascade: 2 records (l1, l2) would point at nothing. …"
function blockedText(col, field, target, ids) {
  const shown = ids.slice(0, 5).join(', ') + (ids.length > 5 ? `, … ${ids.length - 5} more` : '');
  const one = ids.length === 1;
  return `${col}.${field} must point at ${/^[aeiou]/.test(target) ? 'an' : 'a'} ${target} record and doesn't cascade: ${ids.length} record${one ? '' : 's'} (${shown}) would point at nothing. Delete or relink ${one ? 'it' : 'them'} first, or clear ${col} too.`;
}
