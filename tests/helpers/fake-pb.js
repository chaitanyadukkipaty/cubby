// In-memory stand-in for PocketBase's collections API (getFullList/create/update/delete),
// close enough to exercise schema logic without a server.
const SYSTEM = {
  base: () => [{ name: 'id', type: 'text', system: true }],
  auth: () => ['id', 'password', 'tokenKey', 'email', 'emailVisibility', 'verified']
    .map((name) => ({ name, type: name === 'email' ? 'email' : name === 'password' ? 'password' : name.startsWith('email') || name === 'verified' ? 'bool' : 'text', system: true })),
};

export function fakeCollections({ failCreate, failUpdate } = {}) {
  let n = 0;
  const cols = new Map();
  const withIds = (fields) => fields.map((f) => ({ ...f, id: f.id ?? `${f.type}${++n}` }));
  const clone = (x) => structuredClone(x);
  const api = {
    cols,
    calls: { getFullList: 0, create: 0, update: 0, delete: 0 },
    async getFullList() { api.calls.getFullList++; return [...cols.values()].map(clone); },
    async create(def) {
      api.calls.create++;
      if (failCreate) throw Object.assign(new Error('create failed'), { response: { data: { name: { message: 'invalid' } } } });
      const id = `pbc_${++n}`;
      const col = { id, name: def.name, type: def.type ?? 'base', fields: withIds([...SYSTEM[def.type ?? 'base'](), ...(def.fields ?? [])]), indexes: [],
        listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null };
      cols.set(id, col);
      return clone(col);
    },
    async update(id, body) {
      api.calls.update++;
      if (failUpdate) throw Object.assign(new Error('update failed'), { response: { message: 'Something went wrong', data: {} } });
      const col = cols.get(id);
      if (!col) throw Object.assign(new Error('not found'), { status: 404 });
      const { fields, ...rest } = body;
      Object.assign(col, rest);
      if (fields) col.fields = withIds(fields);
      return clone(col);
    },
    async delete(id) {
      api.calls.delete++;
      for (const other of cols.values()) {
        if (other.id !== id && other.fields.some((f) => f.type === 'relation' && f.collectionId === id)) throw new Error('still referenced');
      }
      cols.delete(id);
    },
    byName: (name) => [...cols.values()].find((c) => c.name === name),
  };
  return api;
}
