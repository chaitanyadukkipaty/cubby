// An in-memory stand-in for the superuser PocketBase client, for unit-testing data clears and restores: collections
// (from fake-pb.js), records with ids, cascades on delete, truncate, uploaded files under
// <dataDir>/pb_data/storage/<collectionId>/<recordId>/ and a small filter language: clauses joined by `||` / `&&`,
// each `field op value` (or `relation.id op value`) with op `=`, `!=`, `?=`, `>`, `>=`, `<`, `<=` and value a "string",
// number, true/false or ''. Dates are kept and compared in PocketBase's format ("2026-10-18 06:00:00.000Z"). Cascades, relation filters and failed deletes behave like PocketBase 0.40.5 (see deleteRecord).
// Auth records never expose a password, like the real one.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fakeCollections } from './fake-pb.js';

// PocketBase's own date format ("2026-10-18 06:00:00.000Z"), which it stores and compares dates in.
const pbDate = (d) => (d instanceof Date ? d : new Date(String(d).replace(' ', 'T'))).toISOString().replace('T', ' ');
const quote = (v) => (v instanceof Date ? JSON.stringify(pbDate(v)) : typeof v === 'string' ? JSON.stringify(v) : String(v));

function parseValue(text) {
  const t = text.trim();
  if (t === "''" || t === '""') return '';
  if (/^".*"$/.test(t) || /^'.*'$/.test(t)) return JSON.parse(`"${t.slice(1, -1)}"`);
  if (t === 'true' || t === 'false') return t === 'true';
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  throw Object.assign(new Error(`fake filter: bad value ${t}`), { status: 400, response: { message: 'Invalid filter' } });
}

// Returns a predicate for `filter` on records of `col`, or throws a 400 like PocketBase for anything it can't read.
// Like PocketBase 0.40.5 (checked against the real one): on a relation holding several ids, `rel ?= "x"` matches
// nothing; `rel.id ?= "x"` matches records holding x among others and `rel.id = "x"` those holding only x.
export function compileFilter(filter, col) {
  if (!filter) return () => true;
  const multiRelation = (name) => col?.fields.some((f) => f.name === name && f.type === 'relation' && (f.maxSelect ?? 1) > 1);
  const ors = filter.split(/\s*\|\|\s*/).map((part) => part.replace(/^\(|\)$/g, '').split(/\s*&&\s*/).map((clause) => {
    const m = /^([a-zA-Z_][a-zA-Z0-9_.]*)\s*(\?=|!=|>=|<=|=|>|<)\s*(.+)$/.exec(clause.replace(/^\(|\)$/g, '').trim());
    if (!m) throw Object.assign(new Error(`fake filter: bad clause ${clause}`), { status: 400, response: { message: 'Invalid filter' } });
    const [, path, op, raw] = m;
    const want = parseValue(raw);
    const byId = path.endsWith('.id');
    const field = byId ? path.slice(0, -3) : path;
    return (r) => {
      const v = r[field] ?? '';
      if (byId && op !== '!=') {
        const list = [].concat(v).filter(Boolean);
        return op === '?=' ? list.includes(want) : list.length > 0 && list.every((x) => x === want);
      }
      if (op === '?=' && multiRelation(field)) return false;
      if (op === '?=') return Array.isArray(v) ? v.includes(want) : v === want;
      if (op === '=') return Array.isArray(v) ? (want === '' ? v.length === 0 : false) : v === want;
      if (op === '!=') return Array.isArray(v) ? (want === '' ? v.length > 0 : true) : v !== want;
      return op === '>' ? v > want : op === '>=' ? v >= want : op === '<=' ? v <= want : v < want;
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

  // Deletes a record the way PocketBase does (checked against 0.40.5): each record pointing at it loses that id; one
  // left with no ids in a cascading relation is deleted too (and so on down), and one left with none in a required
  // relation that doesn't cascade fails the whole delete, which changes nothing (PocketBase runs it in a transaction).
  // Uploaded files go only once the delete went through.
  const requiredRef = () => Object.assign(new Error('Failed to delete record. Make sure that the record is not part of a required relation reference.'), { status: 400, response: { status: 400, data: {}, message: 'Failed to delete record. Make sure that the record is not part of a required relation reference.' } });
  function deleteCascading(col, id, gone) {
    const rows = rowsOf(col);
    if (!rows.has(id)) throw notFound();
    gone.push([col, id]);
    for (const other of collections.cols.values()) {
      for (const f of other.fields.filter((x) => x.type === 'relation' && x.collectionId === col.id)) {
        for (const r of [...rowsOf(other).values()]) {
          if (gone.some(([c, x]) => c === other && x === r.id)) continue;
          const v = r[f.name];
          const ids = [].concat(v).filter(Boolean);
          if (!ids.includes(id)) continue;
          const left = ids.filter((x) => x !== id);
          if (f.cascadeDelete && !left.length) { deleteCascading(other, r.id, gone); continue; }
          if (f.required && !left.length) throw requiredRef();
          r[f.name] = Array.isArray(v) ? left : '';
        }
      }
    }
    rows.delete(id);
  }
  function atomically(fn) {
    const saved = new Map([...records].map(([k, rows]) => [k, new Map([...rows].map(([id, r]) => [id, structuredClone(r)]))]));
    try {
      return fn();
    } catch (err) {
      records.clear();
      for (const [k, rows] of saved) records.set(k, rows);
      throw err;
    }
  }
  function deleteRecord(col, id) {
    const gone = [];
    atomically(() => deleteCascading(col, id, gone));
    if (dataDir) for (const [c, x] of gone) rmSync(storage(c, x), { recursive: true, force: true });
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
      if (f.type === 'date' && v) v = pbDate(v);
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
      // All or nothing, like PocketBase (one transaction).
      async truncate(idOrName) {
        const c = colOf(idOrName);
        const gone = [];
        try {
          atomically(() => { for (const id of [...rowsOf(c).keys()]) if (rowsOf(c).has(id)) deleteCascading(c, id, gone); });
        } catch (err) {
          if (err.status !== 400) throw err;
          throw Object.assign(new Error('Failed to truncate collection (most likely due to required cascade delete record references).'), { status: 400, response: { status: 400, data: {}, message: 'Failed to truncate collection (most likely due to required cascade delete record references).' } });
        }
        if (dataDir) for (const [col, x] of gone) rmSync(storage(col, x), { recursive: true, force: true });
        return true;
      },
    }),
    filter: (expr, params = {}) => expr.replace(/\{:(\w+)\}/g, (_, k) => quote(params[k])),
    collection(name) {
      const col = () => { const c = colOf(name); if (!c) throw notFound(); return c; };
      const matching = (filter, sort) => {
        const keep = compileFilter(filter, col());
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
        async getFirstListItem(filter, { sort } = {}) { const [r] = matching(filter, sort); if (!r) throw notFound(); return view(col(), r); },
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
