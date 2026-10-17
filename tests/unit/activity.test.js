// Activity log: row shaping, list filters, pruning cutoff, summaries, and that logging never fails an action.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Server config is read once at import: point PocketBase at a port nothing listens on before loading anything,
// so recordActivity's failure path is real and no test can reach a running server.
process.env.PB_URL = 'http://127.0.0.1:1';
const logic = await import('../../server/src/logic.js');
const { recordActivity, listActivity, pruneActivity } = await import('../../server/src/activity.js');

const alice = { id: 'u1', agent: null };
const agent = { id: 'u1', agent: { id: 'k9', name: 'Claude Code · laptop' } };

describe('activity rows', () => {
  test('a dashboard action has no agent; an agent action carries its key id and name', () => {
    const now = new Date('2026-10-17T09:30:00Z');
    assert.deepEqual(logic.activityRow(alice, { action: 'app.create', app: 'todo', summary: 'Created app "todo"' }, now), {
      user: 'u1', agent: '', agent_name: '', app: 'todo', action: 'app.create', summary: 'Created app "todo"', at: '2026-10-17T09:30:00.000Z',
    });
    const row = logic.activityRow(agent, { action: 'agent.login' }, now);
    assert.equal(row.agent, 'k9');
    assert.equal(row.agent_name, 'Claude Code · laptop');
    assert.equal(row.app, '', 'actions without an app');
  });
  test('summaries are capped so a row stays small', () => {
    assert.equal(logic.activityRow(alice, { action: 'deploy', summary: 'x'.repeat(1000) }).summary.length, 300);
  });
  test('the view says how the action was made and who made it', () => {
    const base = { id: 'r1', at: 't', app: 'todo', action: 'deploy', summary: 's', expand: { user: { email: 'a@x.dev' } } };
    assert.deepEqual(logic.activityView({ ...base, agent: 'k9', agent_name: 'Codex · box' }), {
      id: 'r1', at: 't', user: 'a@x.dev', via: 'agent', agent: { id: 'k9', name: 'Codex · box' }, app: 'todo', action: 'deploy', summary: 's',
    });
    const dash = logic.activityView({ ...base, agent: '', agent_name: '', app: '', expand: undefined });
    assert.equal(dash.via, 'dashboard');
    assert.equal(dash.agent, null);
    assert.equal(dash.app, null);
    assert.equal(dash.user, null);
  });
});

describe('activity queries', () => {
  test('users only ever see their own rows, whatever they filter on', () => {
    const q = logic.activityQuery({ id: 'u1' }, { app: 'todo', agent: 'k9' });
    assert.equal(q.filter.text, 'user = {:u} && app = {:app} && agent = {:agent}');
    assert.deepEqual(q.filter.params, { u: 'u1', app: 'todo', agent: 'k9' });
  });
  test('admins (all) see everyone; agent=dashboard means the manual token', () => {
    const q = logic.activityQuery({ id: 'admin' }, { agent: 'dashboard' }, { all: true });
    assert.equal(q.filter.text, 'agent = {:agent}');
    assert.deepEqual(q.filter.params, { agent: '' });
    assert.equal(logic.activityQuery({ id: 'a' }, {}, { all: true }).filter.text, '');
  });
  test('limit defaults to 50 and is clamped to 1..500', () => {
    const limit = (l) => logic.activityQuery({ id: 'u' }, { limit: l }).limit;
    assert.equal(limit(undefined), 50);
    assert.equal(limit('abc'), 50);
    assert.equal(limit('10'), 10);
    assert.equal(limit('0'), 1);
    assert.equal(limit('99999'), 500);
  });
  test('the prune cutoff is 30 days back, in PocketBase\'s date format', () => {
    assert.equal(logic.activityCutoff(new Date('2026-10-31T12:00:00Z')), '2026-10-01 12:00:00.000Z');
  });
});

describe('activity summaries', () => {
  test('schema push lists what was created, updated and kept', () => {
    assert.equal(logic.schemaSummary({ created: ['notes'], updated: ['tags'], kept: ['notes.body', 'old'] }),
      'Pushed schema: created notes; updated tags; kept notes.body, old');
    assert.equal(logic.schemaSummary({ created: [], updated: [], kept: [] }), 'Pushed schema: no changes');
  });
  test('data clears say what went, how many records, and until when the snapshot keeps them', () => {
    const snapshot = { id: '20261017T101500-a1b2c3', expires: '2026-10-24T10:15:00.000Z' };
    assert.equal(logic.clearSummary({ mode: 'empty', collections: [{ name: 'polls', records: 1204 }, { name: 'votes', records: 1 }], snapshot }),
      'Emptied polls, votes — 1,205 records · snapshot 20261017T101500-a1b2c3 until 2026-10-24');
    assert.equal(logic.clearSummary({ mode: 'drop', collections: [{ name: 'polls', records: 1 }], snapshot }),
      'Dropped polls — 1 record · snapshot 20261017T101500-a1b2c3 until 2026-10-24');
  });
  test('app updates say what changed', () => {
    assert.equal(logic.patchSummary('todo', { unlisted: true }), 'Updated "todo": made it unlisted');
    assert.equal(logic.patchSummary('todo', { unlisted: false, name: 'Todo', description: 'x' }),
      'Updated "todo": listed it in the gallery, renamed it to "Todo", changed its description');
  });
});

describe('recordActivity', () => {
  test('never throws: a failed log must not fail the action it describes', async () => {
    const errors = [];
    const orig = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try {
      assert.equal(await recordActivity(alice, { action: 'deploy', app: 'todo', summary: 's' }), undefined);
    } finally {
      console.error = orig;
    }
    assert.match(errors.join('\n'), /activity log failed \(deploy\)/);
  });
});

// Just enough of a PocketBase record collection for listing and pruning (filters are checked, not evaluated).
function fakeRows(items) {
  const calls = [];
  return {
    calls,
    async getList(page, perPage, opts) {
      calls.push({ perPage, ...opts });
      const old = opts.filter.startsWith('at <') ? items.filter((r) => r.at < opts.filter.slice(6, -1)) : items;
      return { items: old.slice(0, perPage) };
    },
    async delete(id) { items.splice(items.findIndex((r) => r.id === id), 1); },
  };
}

describe('listing and pruning', () => {
  test('listActivity asks for the newest rows matching the query, with the user\'s email', async () => {
    const col = fakeRows([{ id: 'r1', at: 't', agent: '', app: 'todo', action: 'deploy', summary: 's', expand: { user: { email: 'a@x.dev' } } }]);
    const list = await listActivity({ id: 'u1' }, { app: 'todo', limit: '5' }, {}, col);
    assert.deepEqual(list.map((r) => [r.app, r.via, r.user]), [['todo', 'dashboard', 'a@x.dev']]);
    assert.equal(col.calls[0].perPage, 5);
    assert.equal(col.calls[0].sort, '-at');
    assert.equal(col.calls[0].expand, 'user');
    assert.equal(col.calls[0].filter, 'user = "u1" && app = "todo"');
  });
  test('pruneActivity deletes every row older than 30 days, page by page, and says how many', async () => {
    const now = new Date('2026-10-31T12:00:00Z');
    const items = [
      ...Array.from({ length: 450 }, (_, i) => ({ id: `old${i}`, at: '2026-09-01 00:00:00.000Z' })),
      { id: 'new', at: '2026-10-30 00:00:00.000Z' },
    ];
    const col = fakeRows(items);
    assert.equal(await pruneActivity(now, col), 450);
    assert.deepEqual(items.map((r) => r.id), ['new']);
    assert.ok(col.calls.every((c) => c.filter === 'at < "2026-10-01 12:00:00.000Z"'));
  });
});
