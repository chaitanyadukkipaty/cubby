// Managing agents (server/src/auth.js) against an in-memory stand-in for PocketBase.
import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { HttpError } from '../../server/src/http.js';

const { admin } = await import('../../server/src/pb.js');
const auth = await import('../../server/src/auth.js');

// Evaluates the filters auth.js builds with admin.filter: `a = 'x' && b != "y"` clauses only.
function matches(row, filter) {
  return filter.split('&&').every((clause) => {
    const [, field, op, value] = clause.trim().match(/^(\w+) (!?=) ['"](.*)['"]$/);
    const equal = String(row[field] ?? '') === value;
    return op === '=' ? equal : !equal;
  });
}

let tables, n, writes, origCollection;
function table(name) {
  const rows = (tables[name] ??= []);
  const find = (filter) => rows.filter((r) => matches(r, filter));
  return {
    async create(data) { const r = { id: `k${++n}`, created: `c${n}`, last_used: '', kind: '', ...data }; rows.push(r); return { ...r }; },
    async update(id, data) { writes.push({ id, ...data }); const r = rows.find((x) => x.id === id); Object.assign(r, data); return { ...r }; },
    async delete(id) { rows.splice(rows.findIndex((x) => x.id === id), 1); },
    async getFullList({ filter }) { return find(filter).map((r) => ({ ...r })); },
    async getList(page, perPage, { filter }) { return { items: find(filter).reverse().slice(0, perPage).map((r) => ({ ...r })) }; },
    async getFirstListItem(filter, { expand } = {}) {
      const r = find(filter)[0];
      if (!r) throw Object.assign(new Error('not found'), { status: 404 });
      return { ...r, ...(expand === 'owner' && { expand: { owner: tables.users.find((u) => u.id === r.owner) } }) };
    },
  };
}

const hash = (key) => createHash('sha256').update(key).digest('hex');
const keyRow = (id, owner, fields = {}) => ({ id, owner, key: `hk_${id}`, key_hash: hash(`hk_${id}`), kind: 'agent', label: id, created: id, last_used: '', ...fields });
const as = (user, keyId) => ({ id: user, keyId });
const request = (key) => ({ headers: { authorization: `Bearer ${key}` } });
const rejects = (status, re) => (e) => e instanceof HttpError && e.status === status && re.test(e.message);

beforeEach(() => {
  n = 0;
  writes = [];
  tables = {
    users: [{ id: 'ann', email: 'ann@x.dev' }, { id: 'ben', email: 'ben@x.dev' }],
    cubby_api_keys: [
      keyRow('manual', 'ann', { kind: '', label: 'default' }),
      keyRow('laptop', 'ann'),
      keyRow('desktop', 'ann'),
      keyRow('bens', 'ben'),
    ],
  };
  origCollection = admin.collection;
  admin.collection = table;
});
afterEach(() => { admin.collection = origCollection; mock.timers.reset(); });

const ids = () => tables.cubby_api_keys.map((k) => k.id);

describe('last seen', () => {
  test('authenticating writes a key\'s last use at most once a minute', async () => {
    // The throttle lives in auth.js for the whole file; a future clock keeps it independent of the other tests.
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-01-01T12:00:00Z') });
    const lastUsed = () => tables.cubby_api_keys.find((k) => k.id === 'laptop').last_used;
    const user = await auth.authenticate(request('hk_laptop'));
    // `agent` attributes the request in the activity log.
    assert.deepEqual(user, { id: 'ann', email: 'ann@x.dev', is_admin: false, key: 'hk_laptop', keyId: 'laptop', agent: { id: 'laptop', name: 'laptop' } });
    assert.equal(lastUsed(), '2030-01-01T12:00:00.000Z');
    mock.timers.tick(59_000);
    await auth.authenticate(request('hk_laptop'));
    await auth.authenticate(request('hk_desktop'));
    assert.equal(lastUsed(), '2030-01-01T12:00:00.000Z', 'not again within the minute');
    assert.deepEqual(writes.map((w) => w.id), ['laptop', 'desktop'], 'each key on its own clock');
    mock.timers.tick(1_000);
    await auth.authenticate(request('hk_laptop'));
    assert.equal(lastUsed(), '2030-01-01T12:01:00.000Z');
    assert.equal((await auth.listAgents(as('ann', 'laptop'))).find((a) => a.id === 'laptop').last_used_at, '2030-01-01T12:01:00.000Z');
  });
  test('a revoked key is refused at once, even though its last use was just recorded', async () => {
    await auth.authenticate(request('hk_laptop'));
    await auth.revokeAgent(as('ann', 'desktop'), 'laptop');
    await assert.rejects(auth.authenticate(request('hk_laptop')), rejects(401, /Invalid token/));
    assert.equal((await auth.authenticate(request('hk_desktop'))).keyId, 'desktop', 'the other agents keep working');
  });
});

describe('revokeAgent', () => {
  test('deletes the key and says whether it was the agent asking', async () => {
    assert.deepEqual(await auth.revokeAgent(as('ann', 'desktop'), 'laptop'), { ok: true, id: 'laptop', current: false });
    assert.deepEqual(await auth.revokeAgent(as('ann', 'desktop'), 'desktop'), { ok: true, id: 'desktop', current: true });
    assert.deepEqual(ids(), ['manual', 'bens']);
  });
  test("someone else's agent, or none at all, is a 404", async () => {
    await assert.rejects(auth.revokeAgent(as('ann', 'laptop'), 'bens'), rejects(404, /No agent bens in your account/));
    await assert.rejects(auth.revokeAgent(as('ann', 'laptop'), 'x'.repeat(500)), rejects(404, /^No agent x{40} in/));
    assert.ok(ids().includes('bens'));
  });
  test('the manual token is replaced with Regenerate, not revoked', async () => {
    await assert.rejects(auth.revokeAgent(as('ann', 'laptop'), 'manual'), rejects(400, /manual token.*Regenerate/));
    assert.ok(ids().includes('manual'));
  });
});

describe('renameAgent', () => {
  test('relabels the owner\'s agent and returns its view', async () => {
    const view = await auth.renameAgent(as('ann', 'laptop'), 'desktop', ' Old  desktop ');
    assert.deepEqual({ id: view.id, name: view.name, current: view.current }, { id: 'desktop', name: 'Old desktop', current: false });
    assert.equal(tables.cubby_api_keys.find((k) => k.id === 'desktop').label, 'Old desktop');
  });
  test('refuses bad names, other people\'s agents and the manual token', async () => {
    await assert.rejects(auth.renameAgent(as('ann', 'laptop'), 'desktop', ''), rejects(400, /Agent name/));
    await assert.rejects(auth.renameAgent(as('ann', 'laptop'), 'bens', 'mine'), rejects(404, /No agent/));
    await assert.rejects(auth.renameAgent(as('ann', 'laptop'), 'manual', 'x'), rejects(400, /manual token/));
    assert.equal(tables.cubby_api_keys.find((k) => k.id === 'bens').label, 'bens');
  });
});

describe('activity', () => {
  test('rename and revoke are logged under the agent that asked, naming the agent they changed', async () => {
    const actor = { id: 'ann', keyId: 'laptop', agent: { id: 'laptop', name: 'laptop' } };
    await auth.renameAgent(actor, 'desktop', 'Old desktop');
    await auth.revokeAgent(actor, 'desktop');
    await assert.rejects(auth.revokeAgent(actor, 'bens'));
    assert.deepEqual(tables.cubby_activity.map((r) => [r.user, r.agent, r.app, r.action, r.summary]), [
      ['ann', 'laptop', '', 'agent.rename', 'Renamed agent "desktop" to "Old desktop"'],
      ['ann', 'laptop', '', 'agent.revoke', 'Revoked agent "Old desktop"'],
    ]);
  });
});

describe('regenerateToken', () => {
  test('replaces only the manual token; agents and other people keep their keys', async () => {
    const token = await auth.regenerateToken({ id: 'ann', keyId: 'manual', agent: null });
    assert.match(token, /^hk_/);
    assert.deepEqual(ids(), ['laptop', 'desktop', 'bens', 'k1']);
    assert.equal(tables.cubby_api_keys.at(-1).key_hash, hash(token));
  });
  test('an agent key can\'t replace the manual token: revoking the agent must contain it', async () => {
    const agent = { id: 'ann', keyId: 'laptop', agent: { id: 'laptop', name: 'laptop' } };
    await assert.rejects(auth.regenerateToken(agent), rejects(403, /dashboard/));
    assert.deepEqual(ids(), ['manual', 'laptop', 'desktop', 'bens'], 'nothing replaced');
  });
});
