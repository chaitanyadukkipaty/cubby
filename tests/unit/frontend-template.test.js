// Unit tests for the app template's runtime-config helpers (cli/template/src/lib/cubby-config.js),
// plus static checks that the template keeps the wiring the platform depends on.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readConfig, makeCol } from '../../cli/template/src/lib/cubby-config.js';

const tpl = (p) => readFileSync(new URL(`../../cli/template/${p}`, import.meta.url), 'utf8');
const MISSING = /Cubby runtime config missing/;

describe('readConfig()', () => {
  test('returns the injected config', () => {
    const cfg = { project: 'polls', prefix: 'polls__', pbUrl: '/pb' };
    assert.equal(readConfig({ __CUBBY__: cfg }), cfg);
  });
  test('throws a helpful error when the config script is missing', () => {
    assert.throws(() => readConfig({}), MISSING);
    assert.throws(() => readConfig(undefined), MISSING);
  });
  test('rejects malformed configs', () => {
    assert.throws(() => readConfig({ __CUBBY__: { prefix: '', pbUrl: '/pb' } }), MISSING);
    assert.throws(() => readConfig({ __CUBBY__: { prefix: 'a__' } }), MISSING);
    assert.throws(() => readConfig({ __CUBBY__: { prefix: 1, pbUrl: '/pb' } }), MISSING);
  });
});

describe('makeCol()', () => {
  const col = makeCol('team_polls__');
  test('prefixes collection names', () => {
    assert.equal(col('tasks'), 'team_polls__tasks');
    assert.equal(col('users'), 'team_polls__users');
  });
  test('is idempotent, so col(col(x)) is safe', () => assert.equal(col(col('tasks')), 'team_polls__tasks'));
  test('rejects empty or non-string names', () => {
    assert.throws(() => col(''), TypeError);
    assert.throws(() => col(undefined), TypeError);
    assert.throws(() => col(42), TypeError);
  });
});

describe('template wiring', () => {
  test('index.html loads the runtime config as a classic script before the app module', () => {
    const html = tpl('index.html');
    const cfg = html.indexOf('<script src="/__cubby/config.js"></script>');
    const app = html.indexOf('<script type="module" src="/src/main.tsx">');
    assert.ok(cfg > -1, 'config script tag missing or changed');
    assert.ok(app > cfg, 'config must load before the app');
  });
  test('pb.ts builds the client and col() from the runtime config', () => {
    const src = tpl('src/lib/pb.ts');
    assert.match(src, /readConfig\(window\)/);
    assert.match(src, /new PocketBase\(cubby\.pbUrl\)/);
    assert.match(src, /export const col = makeCol\(cubby\.prefix\)/);
  });
  test('the demo app never uses raw collection names', () => {
    const app = tpl('src/App.tsx');
    const raw = [...app.matchAll(/pb\.collection\(\s*(['"`])/g)];
    assert.equal(raw.length, 0, 'use pb.collection(col("name")) everywhere');
  });
  test('vite dev proxies /pb and /__cubby to the server for the linked project', () => {
    const v = tpl('vite.config.ts');
    assert.match(v, /'\/pb': toCubby/);
    assert.match(v, /'\/__cubby': toCubby/);
    assert.match(v, /'x-cubby-project': cubby\.project/);
  });
  test('example schema is valid JSON with an auth users collection and owner-scoped tasks', () => {
    const schema = JSON.parse(tpl('cubby/schema.json'));
    const users = schema.collections.find((c) => c.name === 'users');
    const tasks = schema.collections.find((c) => c.name === 'tasks');
    assert.equal(users.type, 'auth');
    assert.equal(tasks.fields.find((f) => f.name === 'owner').collection, 'users');
    for (const rule of ['listRule', 'viewRule', 'updateRule', 'deleteRule']) assert.match(tasks[rule], /@request\.auth\.id/);
  });
});
