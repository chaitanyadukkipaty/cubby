// The dashboard's session (server/public/js/session.js) with stand-ins for the browser's storage and fetch.
// Every tab shares one localStorage; each tab keeps its token in memory too.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.document = { querySelector: () => null };
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
let valid; // the tokens the server still accepts
globalThis.fetch = async (path, { headers }) => {
  const ok = valid.has(headers.authorization?.slice(7));
  return { ok, status: ok ? 200 : 401, json: async () => (ok ? { email: 'ann@x.dev', path } : { error: 'Invalid token' }) };
};
const session = await import('../../server/public/js/session.js');
after(() => { delete globalThis.document; delete globalThis.localStorage; delete globalThis.fetch; });

beforeEach(() => {
  store.clear();
  valid = new Set();
  session.state.token = null;
  session.state.me = null;
});

describe('api() on a 401', () => {
  test('a stale tab never signs out the fresh token another tab stored', async () => {
    // This tab signed in with hk_old; another tab then regenerated, storing hk_new.
    session.state.token = 'hk_old';
    store.set('cubby_token', 'hk_new');
    valid.add('hk_new');
    await assert.rejects(session.api('GET', '/api/agents'), /another tab/);
    assert.equal(store.get('cubby_token'), 'hk_new', 'the fresh token survives');
    assert.equal(session.state.token, 'hk_new', 'this tab picks it up');
    assert.equal(session.state.me?.email, 'ann@x.dev', 'and reloads who is signed in');
    assert.equal((await session.api('GET', '/api/agents')).path, '/api/agents');
  });
  test('a token that is still the stored one is signed out as before', async () => {
    session.state.token = 'hk_old';
    store.set('cubby_token', 'hk_old');
    await assert.rejects(session.api('GET', '/api/me'), /Session expired/);
    assert.equal(store.has('cubby_token'), false);
    assert.equal(session.state.token, null);
  });
  test('signed out in another tab (nothing stored): this tab signs out too', async () => {
    session.state.token = 'hk_old';
    await assert.rejects(session.api('GET', '/api/me'), /Session expired/);
    assert.equal(session.state.token, null);
  });
});
