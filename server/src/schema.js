// Translates a project's schema (unprefixed names) to/from collections in the shared PocketBase,
// enforcing that a project can only ever create or reference its own collections.
import { admin, mergeFieldIds } from './pb.js';
import { prefixFor } from './config.js';
import { HttpError, clip } from './http.js';

const COLLECTION_NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;
const FIELD_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,60}$/;
const FIELD_TYPES = new Set(['text', 'editor', 'number', 'bool', 'email', 'url', 'date', 'autodate', 'select', 'file', 'relation', 'json', 'geoPoint']);
const RULE_KEYS = ['listRule', 'viewRule', 'createRule', 'updateRule', 'deleteRule'];
const AUTH_RULE_KEYS = ['authRule', 'manageRule'];
const AUTH_SYSTEM_FIELDS = new Set(['id', 'password', 'tokenKey', 'email', 'emailVisibility', 'verified']);

// Every function takes the PocketBase collections API as an optional last argument (defaults to the
// shared superuser client) so the logic can be unit-tested against an in-memory fake.
const pbCollections = () => admin.collections;

// Per-project cache of collection ids and names, used by the PocketBase proxy.
const cache = new Map();
export const resetCollectionCache = () => cache.clear();

export async function projectCollections(slug, api = pbCollections()) {
  const prefix = prefixFor(slug);
  const all = await api.getFullList({ batch: 500 });
  return all.filter((c) => c.name.startsWith(prefix));
}

export async function collectionIndex(slug, { refresh = false } = {}, api = pbCollections()) {
  const hit = cache.get(slug);
  if (hit && !refresh && Date.now() - hit.at < 30_000) return hit;
  const cols = await projectCollections(slug, api);
  const entry = {
    at: Date.now(),
    ids: new Set(cols.map((c) => c.id)),
    names: new Set(cols.map((c) => c.name)),
    authIds: new Set(cols.filter((c) => c.type === 'auth').map((c) => c.id)),
  };
  cache.set(slug, entry);
  return entry;
}

export const rewriteRule = (rule, prefix) =>
  rule == null ? null : String(rule).replace(/@collection\.([a-zA-Z0-9_]+)/g, (_, name) => `@collection.${prefix}${name}`);
export const unrewriteRule = (rule, prefix) =>
  rule == null ? null : rule.replaceAll(`@collection.${prefix}`, '@collection.');

export function validate(input) {
  const errors = [];
  if (!Array.isArray(input?.collections)) throw new HttpError(400, 'Body must be { "collections": [...] }');
  const names = new Set();
  for (const [i, c] of input.collections.entries()) {
    const at = `collections[${i}]`;
    if (!COLLECTION_NAME_RE.test(c.name ?? '') || c.name.includes('__')) errors.push(`${at}.name must match ${COLLECTION_NAME_RE} without "__"`);
    if (names.has(c.name)) errors.push(`${at}.name "${c.name}" is duplicated`);
    names.add(c.name);
    if (!['base', 'auth'].includes(c.type ?? 'base')) errors.push(`${at}.type must be "base" or "auth"`);
    for (const [j, f] of (c.fields ?? []).entries()) {
      const fat = `${at}.fields[${j}]`;
      if (!FIELD_NAME_RE.test(f.name ?? '')) errors.push(`${fat}.name is invalid`);
      if (!FIELD_TYPES.has(f.type)) errors.push(`${fat}.type must be one of ${[...FIELD_TYPES].join(', ')}`);
      if (f.type === 'relation' && !f.collection) errors.push(`${fat} relation needs "collection" (a collection name from this schema)`);
    }
    for (const [j, idx] of (c.indexes ?? []).entries()) {
      if (!Array.isArray(idx.columns) || !idx.columns.length || !idx.columns.every((col) => FIELD_NAME_RE.test(col))) {
        errors.push(`${at}.indexes[${j}] must be { "columns": ["field", ...], "unique"?: bool }`);
      }
    }
  }
  for (const c of input.collections) {
    for (const f of c.fields ?? []) {
      if (f.type === 'relation' && f.collection && !names.has(f.collection)) {
        errors.push(`${c.name}.${f.name} references unknown collection "${f.collection}"`);
      }
    }
  }
  if (errors.length) throw new HttpError(400, 'Invalid schema', errors);
}

export function buildFields(c, prefix, idsByName, { skipRelations }) {
  const fields = [];
  for (const f of c.fields ?? []) {
    if (c.type === 'auth' && AUTH_SYSTEM_FIELDS.has(f.name)) continue;
    if (f.type === 'relation' && skipRelations) continue;
    const { id, system, collection, collectionId, ...rest } = f;
    if (f.type === 'relation') rest.collectionId = idsByName.get(prefix + collection);
    fields.push(rest);
  }
  for (const name of ['created', 'updated']) {
    if (!fields.some((f) => f.name === name)) fields.push({ name, type: 'autodate', onCreate: true, onUpdate: name === 'updated' });
  }
  return fields;
}

export const buildIndexes = (c, fullName) =>
  (c.indexes ?? []).map((idx) => {
    const cols = idx.columns.map((col) => `\`${col}\``).join(', ');
    return `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX \`idx_${fullName}_${idx.columns.join('_')}\` ON \`${fullName}\` (${cols})`;
  });

function pbError(err, collection) {
  const data = err?.response?.data;
  const details = data && Object.keys(data).length ? JSON.stringify(data) : err?.response?.message || err.message;
  return new HttpError(400, `PocketBase rejected collection "${collection}"`, [details]);
}

export async function applySchema(slug, input, api = pbCollections()) {
  validate(input);
  const prefix = prefixFor(slug);
  const existing = await projectCollections(slug, api);
  const byName = new Map(existing.map((c) => [c.name, c]));
  const idsByName = new Map(existing.map((c) => [c.name, c.id]));
  const changes = { created: [], updated: [], kept: [] };

  // Pass 1: create missing collections without relations/rules so every id is known.
  for (const c of input.collections) {
    const fullName = prefix + c.name;
    if (byName.has(fullName)) continue;
    try {
      const created = await api.create({
        name: fullName,
        type: c.type ?? 'base',
        fields: buildFields(c, prefix, idsByName, { skipRelations: true }),
      });
      byName.set(fullName, created);
      idsByName.set(fullName, created.id);
      changes.created.push(c.name);
    } catch (err) {
      throw pbError(err, c.name);
    }
  }

  // Pass 2: full definition with relations, rules and indexes.
  // Non-destructive: fields that exist but aren't in the file are kept and reported.
  for (const c of input.collections) {
    const fullName = prefix + c.name;
    const current = byName.get(fullName);
    const wanted = buildFields(c, prefix, idsByName, { skipRelations: false });
    for (const f of wanted) {
      const existing = current.fields.find((e) => e.name === f.name);
      if (existing && existing.type !== f.type) {
        throw new HttpError(400, `Cannot change ${c.name}.${f.name} from ${existing.type} to ${f.type}`, [
          `Drop it first with \`cubby schema drop ${c.name}.${f.name}\` (deletes its data), or use a new field name.`,
        ]);
      }
    }
    const kept = current.fields.filter((e) => !e.system && !wanted.some((f) => f.name === e.name));
    for (const f of kept) changes.kept.push(`${c.name}.${f.name}`);
    const body = {
      fields: mergeFieldIds(current.fields, [...wanted, ...kept]),
      indexes: buildIndexes(c, fullName),
    };
    for (const key of [...RULE_KEYS, ...(c.type === 'auth' ? AUTH_RULE_KEYS : [])]) {
      if (key in c) body[key] = rewriteRule(c[key], prefix);
      else if (RULE_KEYS.includes(key)) body[key] = null; // default: superuser-only, like PocketBase
    }
    if (c.type === 'auth' && c.passwordAuth) body.passwordAuth = c.passwordAuth;
    try {
      await api.update(current.id, body);
      if (!changes.created.includes(c.name)) changes.updated.push(c.name);
    } catch (err) {
      throw pbError(err, c.name);
    }
  }

  const listed = new Set(input.collections.map((c) => prefix + c.name));
  for (const c of existing) if (!listed.has(c.name)) changes.kept.push(c.name.slice(prefix.length));

  await collectionIndex(slug, { refresh: true }, api);
  return changes;
}

// Explicitly deletes a collection ("tasks") or a single field ("tasks.color") and its data.
export async function dropFromSchema(slug, target, api = pbCollections()) {
  const prefix = prefixFor(slug);
  const [name, field] = String(target).split('.');
  const col = (await projectCollections(slug, api)).find((c) => c.name === prefix + name);
  if (!col) throw new HttpError(404, `Collection "${clip(name)}" not found`);
  if (!field) {
    await deleteCollections([col], api);
  } else {
    const f = col.fields.find((x) => x.name === field);
    if (!f) throw new HttpError(404, `Field "${clip(name)}.${clip(field)}" not found`);
    if (f.system) throw new HttpError(400, `"${name}.${field}" is a system field and can't be dropped`);
    try {
      await api.update(col.id, { fields: col.fields.filter((x) => x.name !== field) });
    } catch (err) {
      throw pbError(err, name);
    }
  }
  await collectionIndex(slug, { refresh: true }, api);
  return { dropped: target };
}

// Deletes collections, retrying so that relation dependencies resolve in any order.
export async function deleteCollections(cols, api = pbCollections()) {
  const deleted = [];
  let pending = [...cols];
  for (let round = 0; pending.length && round < pending.length + 1; round++) {
    const failed = [];
    for (const c of pending) {
      try {
        await api.delete(c.id);
        deleted.push(c.name);
      } catch {
        failed.push(c);
      }
    }
    pending = failed;
  }
  if (pending.length) throw new HttpError(409, `Could not delete: ${pending.map((c) => c.name).join(', ')}`);
  return deleted;
}

export async function readSchema(slug, api = pbCollections()) {
  const prefix = prefixFor(slug);
  const cols = await projectCollections(slug, api);
  const nameById = new Map(cols.map((c) => [c.id, c.name.slice(prefix.length)]));
  return {
    collections: cols.map((c) => {
      const out = { name: c.name.slice(prefix.length), type: c.type };
      out.fields = c.fields
        .filter((f) => !f.system && !(c.type === 'auth' && AUTH_SYSTEM_FIELDS.has(f.name)))
        .map(({ id, system, collectionId, ...f }) => (f.type === 'relation' ? { ...f, collection: nameById.get(collectionId) } : f));
      for (const key of [...RULE_KEYS, ...(c.type === 'auth' ? AUTH_RULE_KEYS : [])]) out[key] = unrewriteRule(c[key], prefix);
      out.indexes = parseIndexes(c.indexes);
      return out;
    }),
  };
}

// Turns PocketBase index SQL back into the schema file's { columns, unique } form.
export function parseIndexes(indexes) {
  return (indexes ?? [])
    .map((sql) => sql.match(/CREATE\s+(UNIQUE\s+)?INDEX\s+\S+\s+ON\s+\S+\s*\(([^)]*)\)/i))
    .filter(Boolean)
    .map((m) => ({ columns: m[2].split(',').map((s) => s.trim().replace(/[`"]/g, '')), unique: Boolean(m[1]) }));
}
