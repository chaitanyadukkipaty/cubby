// The dashboard's routes (server/public/js/routes.js): the browser router and the server share this one table, so
// a path the server serves the shell for is always a path the router can draw.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matchRoute, navItems, appPath } from '../../server/public/js/routes.js';

describe('matchRoute()', () => {
  test('top-level pages', () => {
    assert.deepEqual(matchRoute('/'), { name: 'home' });
    assert.deepEqual(matchRoute('/apps'), { name: 'apps' });
    assert.deepEqual(matchRoute('/agents'), { name: 'agents' });
    assert.deepEqual(matchRoute('/explore'), { name: 'explore' });
    assert.deepEqual(matchRoute('/admin'), { name: 'admin' });
    assert.deepEqual(matchRoute('/connect'), { name: 'connect' });
  });
  test('an app page carries its slug', () => {
    assert.deepEqual(matchRoute('/apps/friend-polls'), { name: 'app', slug: 'friend-polls', tab: 'overview' });
    assert.deepEqual(matchRoute('/apps/a1'), { name: 'app', slug: 'a1', tab: 'overview' });
  });
  test('an app page tab is part of the path, so a reload keeps it', () => {
    assert.deepEqual(matchRoute('/apps/polls/deploys'), { name: 'app', slug: 'polls', tab: 'deploys' });
  });
  test("an agent's page carries its id (a PocketBase id: 15 lowercase letters and digits)", () => {
    assert.deepEqual(matchRoute('/agents/a1b2c3d4e5f6g7h'), { name: 'agent', id: 'a1b2c3d4e5f6g7h' });
    for (const p of ['/agents/short', '/agents/A1B2C3D4E5F6G7H', '/agents/a1b2c3d4e5f6g7h/x', '/agents/a1b2c3d4e5f6g7h8'])
      assert.equal(matchRoute(p), null, p);
  });
  test('a trailing slash is the same page', () => {
    assert.deepEqual(matchRoute('/apps/'), { name: 'apps' });
    assert.deepEqual(matchRoute('/apps/polls/'), { name: 'app', slug: 'polls', tab: 'overview' });
    assert.deepEqual(matchRoute('/apps/polls/env/'), { name: 'app', slug: 'polls', tab: 'env' });
  });
  test('anything else is not a dashboard page (the server answers 404)', () => {
    for (const p of ['/nope', '/api/me', '/docs.md', '/skill.sh', '/cli.tgz', '/apps/polls/extra', '/apps/polls/overview/x', '/apps/polls/Jobs', '/apps/polls/constructor', '/apps/Polls', '/apps/my_app',
      '/apps/-x', '/apps/x--y', '/apps/%2e%2e', '/APPS', '//apps', '/connect/extra', '', 'apps'])
      assert.equal(matchRoute(p), null, p);
  });
  test('inherited object keys are not pages', () => {
    for (const p of ['/constructor', '/__proto__', '/toString']) assert.equal(matchRoute(p), null, p);
  });
});

describe('appPath()', () => {
  test('the overview is the bare app path; other tabs add a segment that matchRoute reads back', () => {
    assert.equal(appPath('polls'), '/apps/polls');
    assert.equal(appPath('polls', 'overview'), '/apps/polls');
    assert.equal(appPath('polls', 'deploys'), '/apps/polls/deploys');
    assert.deepEqual(matchRoute(appPath('polls', 'env')), { name: 'app', slug: 'polls', tab: 'env' });
  });
});

describe('navItems()', () => {
  const labels = (items) => items.map((i) => i.label);
  const current = (items) => items.filter((i) => i.current).map((i) => i.href);
  test('everyone gets Home, Apps, Agents and Explore; admins also get Admin', () => {
    assert.deepEqual(labels(navItems({ is_admin: false }, matchRoute('/'))), ['Home', 'Apps', 'Agents', 'Explore']);
    assert.deepEqual(labels(navItems({ is_admin: true }, matchRoute('/'))), ['Home', 'Apps', 'Agents', 'Explore', 'Admin']);
  });
  test('marks the page you are on; an app page belongs to Apps', () => {
    assert.deepEqual(current(navItems({}, matchRoute('/'))), ['/']);
    assert.deepEqual(current(navItems({}, matchRoute('/explore'))), ['/explore']);
    assert.deepEqual(current(navItems({}, matchRoute('/apps/polls'))), ['/apps']);
    assert.deepEqual(current(navItems({}, matchRoute('/agents/a1b2c3d4e5f6g7h'))), ['/agents']);
    assert.deepEqual(current(navItems({ is_admin: true }, matchRoute('/admin'))), ['/admin']);
    assert.deepEqual(current(navItems({}, null)), []);
  });
});
