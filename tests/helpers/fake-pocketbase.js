// An in-memory stand-in for the superuser PocketBase client, for unit-testing data clears and restores: collections
// (from fake-pb.js), records with ids, cascades on delete, truncate, uploaded files under
// <dataDir>/pb_data/storage/<collectionId>/<recordId>/ and a small filter language: clauses joined by `||` / `&&`,
// each `field op value` with op `=`, `!=`, `?=`, `>`, `<` and value a "string", number, true/false or ''.
// Auth records never expose a password, like the real one.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fakeCollections } from './fake-pb.js';

const quote = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

function parseValue(text) {
  const t = text.trim();
  if (t === "''" || t === '""') return '';
  if (/^".*"$/.test(t) || /^'.*'$/.test(t)) return JSON.parse(`"${t.slice(1, -1)}"`);
  if (t === 'true' || t === 'false') return t === 'true';
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  throw Object.assign(new Error(`fake filter: bad value ${t}`), { status: 400, response: { message: 'Invalid filter' } });
}

// Returns a predicate for `filter`, or throws a 400 like PocketBase for anything it can't read.
export function compileFilter(filter) {
  if (!filter) return () => true;
  const ors = filter.split(/\s*\|\|\s*/).map((part) => part.replace(/^\(|\)$/g, '').split(/\s*&&\s*/).map((clause) => {
    const m = /^([a-zA-Z_][a-zA-Z0-9_.]*)\s*(\?=|!=|=|>|<)\s*(.+)$/.exec(clause.replace(/^\(|\)$/g, '').trim());
    if (!m) throw Object.assign(new Error(`fake filter: bad clause ${clause}`), { status: 400, response: { message: 'Invalid filter' } });
    const [, field, op, raw] = m;
    const want = parseValue(raw);
    return (r) => {
      const v = r[field] ?? '';
      if (op === '?=') return Array.isArray(v) ? v.includes(want) : v === want;
      if (op === '=') return Array.isArray(v) ? (want === '' ? v.length === 0 : false) : v === want;
      if (op === '!=') return Array.isArray(v) ? (want === '' ? v.length > 0 : true) : v !== want;
      return op === '>' ? v > want : v < want;
    };
  }));
  return (r) => ors.some((ands) => ands.every((p) => p(r)));
}

export function fakePocketBase({ dataDir } = {}) {
  const collections = fakeCollections();
  const records = new Map(); // collection id -> Map(record id -> record)
  let n = 0;
  const colOf = (idOrName) => collections.cols.get(idOrName) ?? collections.byName(idOrName);
  const rowsOf = (col) => records.get(col.id) ?? records.set(col.id, new Map()).get(col.id);
  const notFound = () => Object.assign(new Error('not found'), { status: 404, response: { message: 'not found' } });
  const view = (col, r) => {
    const { password, tokenKey, ...rest } = r;
    return { ...structuredClone(rest), collectionId: col.id, collectionName: col.name };
  };
  const storage = (col, id) => join(dataDir, 'pb_data', 'storage', col.id, id);

  // Deletes a record the way PocketBase does: records pointing at it by a cascading relation go too; other relations
  // pointing at it lose that id. A required non-cascading relation blocks the delete.
  function deleteRecord(col, id) {
    const rows = rowsOf(col);
    if (!rows.has(id)) throw notFound();
    for (const other of collections.cols.values()) {
      for (const f of other.fields.filter((x) => x.type === 'relation' && x.collectionId === col.id)) {
        for (const r of [...rowsOf(other).values()]) {
          const v = r[f.name];
          const hit = Array.isArray(v) ? v.includes(id) : v === id;
          if (!hit) continue;
          if (f.cascadeDelete) deleteRecord(other, r.id);
          else if (f.required) throw Object.assign(new Error('referenced'), { status: 400, response: { message: 'The record is referenced' } });
          else r[f.name] = Array.isArray(v) ? v.filter((x) => x !== id) : '';
        }
      }
    }
    rows.delete(id);
    if (dataDir) rmSync(storage(col, id), { recursive: true, force: true });
  }

  async function writeRecord(col, data, existing) {
    const r = existing ?? { id: data.id || `r${String(++n).padStart(14, '0')}` };
    if (!existing && rowsOf(col).has(r.id)) throw Object.assign(new Error('exists'), { status: 400, response: { data: { id: { code: 'validation_not_unique', message: 'Value must be unique.' } } } });
    for (const f of col.fields) {
      if (['id', 'created', 'updated'].includes(f.name)) continue;
      if (!(f.name in data)) { if (!existing) r[f.name] = f.type === 'bool' ? false : f.type === 'number' ? 0 : ''; continue; }
      let v = data[f.name];
      if (f.type === 'file') {
        const files = [].concat(v).filter(Boolean);
        const names = [];
        for (const file of files) {
          if (typeof file === 'string') { names.push(file); continue; }
          const name = file.name.replace(/(\.[^.]*)?$/, (ext) => `_${(++n).toString(36).padStart(6, '0')}${ext}`);
          if (dataDir) {
            mkdirSync(storage(col, r.id), { recursive: true });
            writeFileSync(join(storage(col, r.id), name), Buffer.from(await file.arrayBuffer()));
          }
          names.push(name);
        }
        v = (f.maxSelect ?? 1) > 1 ? names : (names[0] ?? '');
      }
      if (f.type === 'relation' && v) {
        const target = collections.cols.get(f.collectionId);
        for (const id of [].concat(v)) {
          if (!rowsOf(target).has(id)) throw Object.assign(new Error('missing relation'), { status: 400, response: { data: { [f.name]: { code: 'validation_missing_rel_records', message: 'Failed to find all relation records with the provided ids.' } } } });
        }
      }
      r[f.name] = v;
    }
    if (col.type === 'auth' && data.password) r.password = data.password;
    r.created ??= '2026-10-17 10:00:00.000Z';
    r.updated = '2026-10-17 10:00:00.000Z';
    rowsOf(col).set(r.id, r);
    return view(col, r);
  }

  const pb = {
    collections: Object.assign(collections, {
      async getOne(idOrName) { const c = colOf(idOrName); if (!c) throw notFound(); return structuredClone(c); },
      async truncate(idOrName) {
        const c = colOf(idOrName);
        for (const id of [...rowsOf(c).keys()]) deleteRecord(c, id);
        return true;
      },
    }),
    filter: (expr, params = {}) => expr.replace(/\{:(\w+)\}/g, (_, k) => quote(params[k])),
    collection(name) {
      const col = () => { const c = colOf(name); if (!c) throw notFound(); return c; };
      const matching = (filter, sort) => {
        const keep = compileFilter(filter);
        const list = [...rowsOf(col()).values()].filter(keep);
        if (sort) list.sort((a, b) => String(a[sort.replace(/^-/, '')]).localeCompare(String(b[sort.replace(/^-/, '')])) * (sort.startsWith('-') ? -1 : 1));
        return list;
      };
      return {
        async getList(page = 1, perPage = 30, { filter, sort } = {}) {
          const all = matching(filter, sort);
          return { page, perPage, totalItems: all.length, items: all.slice((page - 1) * perPage, page * perPage).map((r) => view(col(), r)) };
        },
        async getFullList({ filter, sort } = {}) { return matching(filter, sort).map((r) => view(col(), r)); },
        async getOne(id) { const r = rowsOf(col()).get(id); if (!r) throw notFound(); return view(col(), r); },
        async create(data) { return writeRecord(col(), data); },
        async update(id, data) { const r = rowsOf(col()).get(id); if (!r) throw notFound(); return writeRecord(col(), data, r); },
        async delete(id) { deleteRecord(col(), id); return true; },
      };
    },
    // Test helpers.
    records: (name) => [...rowsOf(colOf(name)).values()],
    password: (name, id) => rowsOf(colOf(name)).get(id)?.password,
  };
  return pb;
}
