// What deleting records makes PocketBase do to the rest of an app, worked out before anything is deleted, so a data
// clear can snapshot all of it and refuse what PocketBase would refuse. PocketBase (checked against 0.40.5), for each
// record pointing at a deleted one: removes that id from the relation; a record left with no ids in a cascading
// relation is deleted too (and so on, any number of hops, self-relations included); one left with none in a required
// relation that doesn't cascade makes the whole delete fail.
import { chunks, eachPage, idsIn } from './data.js';

const idList = (v) => [].concat(v ?? []).filter(Boolean);
const relations = (col) => col.fields.filter((f) => f.type === 'relation');

// `cols`: the app's collections (PocketBase's form). `targets`: the collections records are deleted from; `matched`:
// the ids deleted from the one target, or null when the targets are deleted whole. Returns, by collection id:
// `deleted` (records that go by cascade, beyond `matched`), `unlinked` (records that stay but lose ids), and
// `entries` (per relation: how many records it deletes or unlinks) and `blocked` (required relations that would be
// left empty: PocketBase refuses the delete).
export async function planCascade(pb, cols, targets, matched) {
  const byId = new Map(cols.map((c) => [c.id, c]));
  const whole = new Set(matched ? [] : targets.map((c) => c.id));
  const del = new Map();
  const setIn = (map, key) => map.get(key) ?? map.set(key, new Set()).get(key);
  if (matched) for (const id of matched) setIn(del, targets[0].id).add(id);
  const gone = (colId, id) => whole.has(colId) || Boolean(del.get(colId)?.has(id));
  // Records of collections not deleted whole that point at something deleted: id and relation fields only.
  const found = new Map();
  const rels = cols.filter((c) => !whole.has(c.id)).flatMap((col) => relations(col).map((f) => ({ col, f })));

  let frontier = matched ? [[targets[0].id, matched]] : targets.map((c) => [c.id, null]);
  while (frontier.length) {
    for (const [colId, ids] of frontier) {
      for (const { col, f } of rels.filter((r) => r.f.collectionId === colId)) {
        const into = found.get(col.id) ?? found.set(col.id, new Map()).get(col.id);
        const keep = (items) => { for (const r of items) if (!into.has(r.id)) into.set(r.id, r); };
        const fields = ['id', ...relations(col).map((x) => x.name)].join(',');
        if (!ids) await eachPage(pb, col.name, `${f.name} != ""`, keep, fields);
        else for (const part of chunks(ids)) await eachPage(pb, col.name, idsIn(pb, f.name, part), keep, fields);
      }
    }
    // Which of them go now: a cascading relation all of whose ids go. Until nothing more goes.
    frontier = [];
    for (let more = true; more;) {
      more = false;
      for (const [colId, recs] of found) {
        const col = byId.get(colId);
        const fresh = [];
        for (const r of recs.values()) {
          if (gone(colId, r.id)) continue;
          const goes = relations(col).some((f) => f.cascadeDelete && idList(r[f.name]).length && idList(r[f.name]).every((id) => gone(f.collectionId, id)));
          if (goes) { setIn(del, colId).add(r.id); fresh.push(r.id); more = true; }
        }
        if (fresh.length) frontier.push([colId, fresh]);
      }
    }
  }

  const deleted = new Map();
  const matchedSet = new Set(matched ?? []);
  for (const [colId, ids] of del) {
    const extra = [...ids].filter((id) => !(matched && colId === targets[0].id && matchedSet.has(id)));
    if (extra.length) deleted.set(colId, extra);
  }
  const unlinked = new Map();
  const entries = [];
  const blocked = [];
  const affected = (colId) => whole.has(colId) || del.has(colId);
  for (const { col, f } of rels.filter((r) => affected(r.f.collectionId))) {
    const hit = [...(found.get(col.id)?.values() ?? [])].filter((r) => idList(r[f.name]).some((id) => gone(f.collectionId, id)));
    const goes = hit.filter((r) => gone(col.id, r.id));
    const stays = hit.filter((r) => !gone(col.id, r.id));
    for (const r of stays) setIn(unlinked, col.id).add(r.id);
    if (f.cascadeDelete) {
      entries.push({ col, field: f.name, records: goes.length, deletes: true });
      if (stays.length) entries.push({ col, field: f.name, records: stays.length, deletes: false });
    } else {
      entries.push({ col, field: f.name, records: stays.length, deletes: false });
    }
    const left = stays.filter((r) => idList(r[f.name]).every((id) => gone(f.collectionId, id)));
    if (f.required && left.length) blocked.push({ col, field: f.name, target: byId.get(f.collectionId), ids: left.map((r) => r.id) });
  }
  return { deleted, unlinked: new Map([...unlinked].map(([k, v]) => [k, [...v]])), entries, blocked };
}
