// Restoring a snapshot (snapshots.js) written by a data clear. Additive by default: records come back with their
// original ids, and ids that exist again are skipped, so restoring twice is harmless. `overwrite` replaces them
// instead, after snapshotting the versions it replaces. What PocketBase doesn't let even a superuser set comes back
// different: `created`/`updated` are new, uploaded files get new names, and accounts get new random passwords
// (PocketBase never hands out password hashes), which the result lists.
import { createReadStream, existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { prefixFor } from './config.js';
import { HttpError } from './http.js';
import { applySchema, collectionIndex, projectCollections, readSchema, validate } from './schema.js';
import { byIds, chunks, storageDir } from './data.js';
import { startSnapshot, newSnapshotId, expiresAt } from './snapshots.js';

const BATCH = 100;
const FAILURES_SHOWN = 50;
// Record keys PocketBase sets itself.
const READ_ONLY = new Set(['id', 'collectionId', 'collectionName', 'expand', 'created', 'updated']);

// The records of `name` in a snapshot's `part` (records/ or links/), BATCH lines at a time (a big file never sits in
// memory whole). None when there's no file.
async function* batches(dir, name, part = 'records') {
  const path = join(dir, part, `${name}.jsonl`);
  if (!existsSync(path)) return;
  let batch = [];
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    batch.push(JSON.parse(line));
    if (batch.length === BATCH) { yield batch; batch = []; }
  }
  if (batch.length) yield batch;
}

// Collections in an order where relation targets come before the collections pointing at them (cycles last).
function relationOrder(names, defs) {
  const left = [...names];
  const out = [];
  while (left.length) {
    const ready = left.find((n) => defs.get(n).fields.every((f) => f.type !== 'relation' || f.collection === n || !left.includes(f.collection)));
    const next = ready ?? left[0];
    out.push(next);
    left.splice(left.indexOf(next), 1);
  }
  return out;
}

const newPassword = () => randomBytes(12).toString('base64url');
const idList = (v) => [].concat(v).filter(Boolean);
const jsonlNames = async (dir) => (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length));

// `snap` is { meta, dir } (findSnapshot). Returns what was (or, with dry_run, would be) restored, per collection,
// with the schema drift found: fields removed since (skipped) and fields whose type changed (refused: nothing is
// restored while any remain).
export async function restoreSnapshot({ meta, dir }, { overwrite = false, dry_run = false } = {}, { pb, dataDir, project, actor, now = Date.now }) {
  if (meta.project !== project.id) throw new HttpError(404, `Snapshot ${meta.id} is not one of ${project.slug}'s`);
  const slug = project.slug;
  const prefix = prefixFor(slug);
  const saved = new Map(JSON.parse(await readFile(join(dir, 'schema.json'), 'utf8')).collections.map((c) => [c.name, c]));
  // What comes back: collections with records, and every collection a drop (or wipe) took, records or not.
  const names = [...new Set([...(meta.mode === 'drop' ? [...saved.keys()] : []), ...await jsonlNames(join(dir, 'records'))])];
  const linkNames = await jsonlNames(join(dir, 'links'));
  const live = new Map((await readSchema(slug, pb.collections)).collections.map((c) => [c.name, c]));
  const order = relationOrder(names, saved);

  // Drift between the snapshot's schema and the app's now.
  const skipped = [], refused = [], recreate = [];
  for (const name of order) {
    const was = saved.get(name);
    const current = live.get(name);
    if (!current) { recreate.push(name); continue; }
    for (const f of was.fields.filter((x) => x.type !== 'autodate')) {
      const cur = current.fields.find((x) => x.name === f.name);
      if (!cur) skipped.push(`${name}.${f.name}`);
      else if (cur.type !== f.type) refused.push(`${name}.${f.name} was ${f.type}, is ${cur.type} now`);
    }
  }
  // A recreated collection keeps relations only to collections that exist (or come back with it).
  const recreated = recreate.map((name) => {
    const def = structuredClone(saved.get(name));
    def.fields = def.fields.filter((f) => {
      const ok = f.type !== 'relation' || live.has(f.collection) || recreate.includes(f.collection);
      if (!ok) skipped.push(`${name}.${f.name}`);
      return ok;
    });
    return def;
  });
  // applySchema checks that every relation points at a collection it's given: the recreated ones plus, as they are,
  // the live ones they point at, and the ones those point at, and so on. The dry run checks the same.
  const pointedAt = new Set();
  const visit = (def) => {
    for (const f of def.fields.filter((x) => x.type === 'relation' && live.has(x.collection) && !pointedAt.has(x.collection))) {
      pointedAt.add(f.collection);
      visit(live.get(f.collection));
    }
  };
  recreated.forEach(visit);
  const toApply = recreated.length ? { collections: [...recreated, ...[...pointedAt].map((n) => live.get(n))] } : null;
  if (toApply) validate(toApply);

  // Which snapshotted ids exist in the app again.
  const existing = new Map();
  const counts = new Map();
  const inSnapshot = new Map(); // name -> ids of the records the clear deleted
  for (const name of order) {
    const ids = new Set();
    const all = new Set();
    inSnapshot.set(name, all);
    let n = 0;
    for await (const batch of batches(dir, name)) {
      n += batch.length;
      for (const r of batch) all.add(r.id);
      if (!live.has(name)) continue;
      const { items } = await pb.collection(prefix + name).getList(1, batch.length, { filter: byIds(pb, batch.map((r) => r.id)), fields: 'id', skipTotal: true });
      for (const r of items) ids.add(r.id);
    }
    existing.set(name, ids);
    counts.set(name, n);
  }
  // Auth collections where accounts are (or would be) created: one that exists again is skipped, or replaced with
  // its password kept.
  const auth = order.filter((n) => saved.get(n).type === 'auth' && counts.get(n) > existing.get(n).size);
  const result = {
    snapshot: meta.id, overwrite, recreated: recreate, skipped_fields: skipped, refused_fields: refused, files: meta.files,
    collections: order.map((name) => ({ name, records: counts.get(name), existing: existing.get(name).size, restored: 0, replaced: 0, failed: 0 })),
    links: [],
    accounts: [], failures: [], warnings: [
      ...(meta.files ? [] : ['This snapshot has no uploaded files (they were over the size cap): records come back without them.']),
      ...auth.map((n) => `${n} holds user accounts: restored accounts get new random passwords (the restore lists them), since PocketBase never hands out password hashes.`),
    ],
  };
  const row = (name) => result.collections.find((c) => c.name === name);
  for (const name of linkNames) {
    let n = 0;
    for await (const batch of batches(dir, name, 'links')) n += batch.length;
    result.links.push({ name, records: n, relinked: 0 });
  }
  if (dry_run) return { dry_run: true, ...result };
  if (refused.length) {
    throw new HttpError(409, `Can't restore ${meta.id}: fields changed type since the snapshot`, [...refused, 'Drop those fields (`cubby schema drop <collection>.<field>`) or rename them, then restore again.']);
  }

  // --overwrite: snapshot the records about to be replaced, as they are now.
  if (overwrite && [...existing.values()].some((s) => s.size)) {
    const t = now();
    const backup = await startSnapshot(dataDir, slug, newSnapshotId(t));
    const replacing = order.filter((n) => existing.get(n).size);
    await backup.schema({ collections: replacing.map((n) => live.get(n)) });
    const cols = new Map((await projectCollections(slug, pb.collections)).map((c) => [c.name, c]));
    for (const name of replacing) {
      for (const ids of chunks([...existing.get(name)])) {
        const items = await pb.collection(prefix + name).getFullList({ filter: byIds(pb, ids) });
        await backup.records(name, items);
        await backup.files(name, storageDir(dataDir, cols.get(prefix + name).id), ids);
      }
    }
    const replaced = replacing.map((n) => ({ name: n, type: live.get(n).type, records: existing.get(n).size, files_bytes: 0 }));
    await backup.finish({
      format: 1, id: backup.id, app: slug, project: project.id, created: new Date(t).toISOString(), expires: expiresAt(t), by: actor,
      reason: `Replaced by restoring ${meta.id} with --overwrite`, mode: 'overwrite', collections: replaced, cascade: [], files: true, files_bytes: 0, warnings: [],
    });
    result.backup = { id: backup.id, expires: expiresAt(t) };
  }

  if (toApply) await applySchema(slug, toApply, pb.collections);
  const cols = new Map((await projectCollections(slug, pb.collections)).map((c) => [c.name.slice(prefix.length), c]));

  // Creates (or with overwrite updates) one record. One pointing at a record not restored yet goes to `defer` (when
  // given) to be tried again later. `noRelations` leaves its relations out (set afterwards by linkLater).
  const linkLater = [];
  async function write(name, rec, defer, noRelations = false) {
    const col = cols.get(name);
    const fields = col.fields.filter((f) => !f.system || ['email', 'emailVisibility', 'verified'].includes(f.name))
      .filter((f) => !['autodate', 'password'].includes(f.type) && f.name !== 'tokenKey' && f.name in rec && !READ_ONLY.has(f.name))
      .filter((f) => !noRelations || f.type !== 'relation');
    const data = {};
    for (const f of fields) {
      if (f.type !== 'file') { data[f.name] = rec[f.name]; continue; }
      const files = [];
      for (const fname of [].concat(rec[f.name]).filter(Boolean)) {
        const path = join(dir, 'files', name, rec.id, fname);
        if (existsSync(path)) files.push(new File([await readFile(path)], fname.replace(/_[a-z0-9]{10}(\.[^.]*)?$/, '$1')));
      }
      data[f.name] = (f.maxSelect ?? 1) > 1 ? files : (files[0] ?? '');
    }
    const replace = existing.get(name).has(rec.id);
    try {
      if (replace) {
        await pb.collection(col.name).update(rec.id, data);
        row(name).replaced++;
      } else {
        const password = col.type === 'auth' ? newPassword() : null;
        await pb.collection(col.name).create({ id: rec.id, ...data, ...(password && { password, passwordConfirm: password }) });
        if (password) result.accounts.push({ collection: name, id: rec.id, email: rec.email, password });
        row(name).restored++;
        existing.get(name).add(rec.id);
      }
      if (noRelations) linkLater.push([name, rec]);
    } catch (err) {
      const errors = err.response?.data ?? {};
      if (defer && Object.values(errors).some((e) => e?.code === 'validation_missing_rel_records')) return defer.push([name, rec]);
      row(name).failed++;
      if (result.failures.length < FAILURES_SHOWN) result.failures.push({ collection: name, id: rec.id, error: Object.keys(errors).length ? JSON.stringify(errors) : err.message });
    }
  }
  let pending = [];
  for (const name of order) {
    for await (const batch of batches(dir, name)) {
      for (const rec of batch) if (!existing.get(name).has(rec.id) || overwrite) await write(name, rec, pending);
    }
  }
  // Records pointing at ones that came back after them (self-relations): again while that gets any further. What's
  // left points in a cycle: those records are created without their relations, which are set once all exist.
  while (pending.length) {
    const again = [];
    for (const [name, rec] of pending) await write(name, rec, again);
    if (again.length === pending.length) {
      for (const [name, rec] of again) await write(name, rec, null, true);
      break;
    }
    pending = again;
  }
  for (const [name, rec] of linkLater) {
    const col = cols.get(name);
    const links = Object.fromEntries(col.fields.filter((f) => f.type === 'relation' && f.name in rec).map((f) => [f.name, rec[f.name]]));
    await pb.collection(col.name).update(rec.id, links).catch((err) => {
      row(name).failed++;
      if (result.failures.length < FAILURES_SHOWN) result.failures.push({ collection: name, id: rec.id, error: `restored without its links: ${err.message}` });
    });
  }
  await relink();
  if (recreated.length) await collectionIndex(slug, { refresh: true }, pb.collections);
  return result;

  // Records that stayed but lost links to deleted records (unlinked by PocketBase) get those links back, now that the
  // records exist again: the removed ids go back in place in a relation holding several, a single relation is set
  // only while it's empty. Nothing else of them changes, and links to records that aren't back are left out.
  async function relink() {
    const nameById = new Map([...cols.values()].map((c) => [c.id, c.name.slice(prefix.length)]));
    const back = (name, id) => Boolean(inSnapshot.get(name)?.has(id) && existing.get(name).has(id));
    for (const entry of result.links) {
      const col = cols.get(entry.name);
      if (!col) continue;
      const rels = col.fields.filter((f) => f.type === 'relation');
      for await (const batch of batches(dir, entry.name, 'links')) {
        const { items } = await pb.collection(col.name).getList(1, batch.length, { filter: byIds(pb, batch.map((r) => r.id)), skipTotal: true });
        const now = new Map(items.map((r) => [r.id, r]));
        for (const rec of batch) {
          const cur = now.get(rec.id);
          if (!cur) continue;
          const patch = {};
          for (const f of rels.filter((x) => x.name in rec)) {
            const was = idList(rec[f.name]);
            const has = idList(cur[f.name]);
            const add = was.filter((id) => !has.includes(id) && back(nameById.get(f.collectionId), id));
            if (!add.length) continue;
            if ((f.maxSelect ?? 1) > 1) patch[f.name] = [...was.filter((id) => has.includes(id) || add.includes(id)), ...has.filter((id) => !was.includes(id))];
            else if (!has.length) patch[f.name] = add[0];
          }
          if (!Object.keys(patch).length) continue;
          try {
            await pb.collection(col.name).update(rec.id, patch);
            entry.relinked++;
          } catch (err) {
            if (result.failures.length < FAILURES_SHOWN) result.failures.push({ collection: entry.name, id: rec.id, error: `links not put back: ${err.message}` });
          }
        }
      }
    }
  }
}
