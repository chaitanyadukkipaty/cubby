// The dashboard's routes (server/public/js/routes.js): the browser router and the server share this one table, so
// a path the server serves the shell for is always a path the router can draw.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matchRoute, navItems } from '../../server/public/js/routes.js';

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
    assert.deepEqual(matchRoute('/apps/friend-polls'), { name: 'app', slug: 'friend-polls' });
    assert.deepEqual(matchRoute('/apps/a1'), { name: 'app', slug: 'a1' });
  });
  test('a trailing slash is the same page', () => {
    assert.deepEqual(matchRoute('/apps/'), { name: 'apps' });
    assert.deepEqual(matchRoute('/apps/polls/'), { name: 'app', slug: 'polls' });
  });
  test('anything else is not a dashboard page (the server answers 404)', () => {
    for (const p of ['/nope', '/api/me', '/docs.md', '/skill.sh', '/cli.tgz', '/apps/polls/extra', '/apps/Polls', '/apps/my_app',
      '/apps/-x', '/apps/x--y', '/apps/%2e%2e', '/APPS', '//apps', '/connect/extra', '', 'apps'])
      assert.equal(matchRoute(p), null, p);
  });
  test('inherited object keys are not pages', () => {
    for (const p of ['/constructor', '/__proto__', '/toString']) assert.equal(matchRoute(p), null, p);
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
    assert.deepEqual(current(navItems({ is_admin: true }, matchRoute('/admin'))), ['/admin']);
    assert.deepEqual(current(navItems({}, null)), []);
  });
});
