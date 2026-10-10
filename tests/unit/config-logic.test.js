import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { prefixFor, SLUG_RE, RESERVED_SLUGS } from '../../server/src/config.js';
import * as logic from '../../server/src/logic.js';
import { HttpError } from '../../server/src/http.js';

const rejects = (fn, status, re) => assert.throws(fn, (e) => e instanceof HttpError && e.status === status && (!re || re.test(e.message)));

describe('config', () => {
  test('prefixFor maps hyphens to underscores and appends "__"', () => {
    assert.equal(prefixFor('todo'), 'todo__');
    assert.equal(prefixFor('my-cool-app'), 'my_cool_app__');
  });
  test('prefixes are unambiguous: no slug can produce another slug\'s prefix plus a name', () => {
    // a slug never contains "__", so the first "__" always ends the prefix
    for (const s of ['a-b', 'ab', 'a-b-c']) assert.equal(prefixFor(s).indexOf('__'), prefixFor(s).length - 2);
  });
  for (const ok of ['abc', 'a1', 'my-app', 'a-b-c', 'x9-y8']) test(`SLUG_RE accepts ${ok}`, () => assert.ok(SLUG_RE.test(ok)));
  for (const bad of ['', '1abc', 'Abc', 'my_app', 'my--app', '-app', 'app-', 'a b', 'app.x', 'äpp'])
    test(`SLUG_RE rejects ${JSON.stringify(bad)}`, () => assert.ok(!SLUG_RE.test(bad)));
  test('reserved slugs include platform names', () => {
    for (const r of ['www', 'api', 'admin', 'cubby', 'pb']) assert.ok(RESERVED_SLUGS.has(r));
  });
});

describe('logic.appSlugFromHost', () => {
  const base = 'example.com';
  const cases = [
    ['todo.example.com', 'todo'], ['my-app.example.com', 'my-app'], ['example.com', null], ['www.other.com', null],
    ['a.b.example.com', null], ['Bad_App.example.com', null], [undefined, null], ['xexample.com', null],
  ];
  for (const [host, want] of cases) test(`${host} → ${want}`, () => assert.equal(logic.appSlugFromHost(host, base), want));
  test('works with a port in the base domain', () => assert.equal(logic.appSlugFromHost('app.localhost:8080', 'localhost:8080'), 'app'));
});

describe('logic.isLoopback', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) test(`${ip} is loopback`, () => assert.ok(logic.isLoopback(ip)));
  for (const ip of ['10.0.0.1', '192.168.1.2', '', undefined, '::ffff:10.0.0.1']) test(`${ip} is not loopback`, () => assert.ok(!logic.isLoopback(ip)));
});

describe('logic views', () => {
  const cfg = { publicUrl: 'https://example.com', baseDomain: 'example.com' };
  test('appUrl uses the public URL scheme', () => {
    assert.equal(logic.appUrl('todo', 'https://example.com', 'example.com'), 'https://todo.example.com');
    assert.equal(logic.appUrl('todo', 'http://1-2-3-4.sslip.io', '1-2-3-4.sslip.io'), 'http://todo.1-2-3-4.sslip.io');
  });
  test('projectView fills defaults and includes owner when expanded', () => {
    const v = logic.projectView({ id: 'p1', slug: 'my-app', name: 'My App', created: 'c', expand: { owner: { email: 'a@b.c' } } }, cfg);
    assert.deepEqual(v, {
      id: 'p1', slug: 'my-app', name: 'My App', description: '', url: 'https://my-app.example.com', prefix: 'my_app__',
      unlisted: false, current_deploy: null, last_deployed: null, schema_hash: null, created: 'c', owner: 'a@b.c',
    });
    assert.ok(!('owner' in logic.projectView({ slug: 'x-y' }, cfg)));
  });
  test('galleryView hides owner-only internals', () => {
    const g = logic.galleryView({ slug: 's', prefix: 'p', schema_hash: 'h', current_deploy: 'd', url: 'u' });
    assert.deepEqual(g, { slug: 's', url: 'u' });
  });
  test('settingsView exposes exactly the editable settings', () => {
    assert.deepEqual(logic.settingsView({ id: 'x', signup_code: 'c', open_signup: true, max_apps_per_user: 3, max_deploy_mb: 9, created: 'z' }),
      { signup_code: 'c', open_signup: true, max_apps_per_user: 3, max_deploy_mb: 9 });
  });
});

describe('logic.checkNewSlug', () => {
  test('accepts a valid slug', () => logic.checkNewSlug('my-app'));
  for (const bad of [undefined, null, 42, 'ab', 'a'.repeat(41), 'My-App', 'a_b', 'a--b'])
    test(`rejects ${JSON.stringify(bad)} with 400`, () => rejects(() => logic.checkNewSlug(bad), 400, /3-40 chars/));
  test('accepts exactly 3 and 40 characters', () => { logic.checkNewSlug('abc'); logic.checkNewSlug('a'.repeat(40)); });
  test('rejects reserved names with 409', () => rejects(() => logic.checkNewSlug('admin'), 409, /reserved/));
});

describe('logic patches', () => {
  test('projectPatch keeps only valid, typed fields and trims', () => {
    assert.deepEqual(logic.projectPatch({ unlisted: true, description: 'd', name: '  N  ', extra: 1 }), { unlisted: true, description: 'd', name: 'N' });
    assert.deepEqual(logic.projectPatch({ unlisted: 'yes', description: 5, name: '   ' }), {});
    assert.deepEqual(logic.projectPatch(), {});
    assert.equal(logic.projectPatch({ description: 'x'.repeat(400) }).description.length, 300);
    assert.equal(logic.projectPatch({ name: 'y'.repeat(200) }).name.length, 100);
  });
  test('deployPatch reads unlisted/description from query params', () => {
    assert.deepEqual(logic.deployPatch(new URLSearchParams('unlisted=1&description=hi')), { unlisted: true, description: 'hi' });
    assert.deepEqual(logic.deployPatch(new URLSearchParams('unlisted=0')), { unlisted: false });
    assert.deepEqual(logic.deployPatch(new URLSearchParams('message=x')), {});
    assert.equal(logic.deployPatch(new URLSearchParams(`description=${'d'.repeat(500)}`)).description.length, 300);
  });
  test('deployClient stringifies and caps the agent name', () => {
    assert.equal(logic.deployClient(undefined), '');
    assert.equal(logic.deployClient('claude-code'), 'claude-code');
    assert.equal(logic.deployClient('x'.repeat(100)).length, 60);
  });
  test('settingsPatch validates limits and rotates the code', () => {
    let calls = 0;
    const code = () => (calls++, 'new-code-11');
    assert.deepEqual(logic.settingsPatch({ open_signup: true, rotate_code: true, max_apps_per_user: '5', max_deploy_mb: 20 }, code),
      { open_signup: true, signup_code: 'new-code-11', max_apps_per_user: 5, max_deploy_mb: 20 });
    assert.equal(calls, 1);
    assert.deepEqual(logic.settingsPatch({ open_signup: 'yes' }, code), {});
    assert.deepEqual(logic.settingsPatch(undefined, code), {});
    for (const bad of [0, -1, 1.5, 10_001, 'abc', null])
      rejects(() => logic.settingsPatch({ max_apps_per_user: bad }, code), 400, /whole number/);
    assert.deepEqual(logic.settingsPatch({ max_deploy_mb: 10_000 }, code), { max_deploy_mb: 10_000 });
  });
});

describe('logic.checkSignup', () => {
  const closed = { open_signup: false, signup_code: 'otter-maple-42' };
  test('requires email and password', () => {
    rejects(() => logic.checkSignup({ password: 'password1' }, closed), 400, /required/);
    rejects(() => logic.checkSignup({ email: 'a@b.c' }, closed), 400, /required/);
    rejects(() => logic.checkSignup(undefined, closed), 400);
  });
  test('requires 8+ character passwords', () => rejects(() => logic.checkSignup({ email: 'a@b.c', password: 'short', code: 'otter-maple-42' }, closed), 400, /8 characters/));
  test('rejects a missing or wrong code', () => {
    rejects(() => logic.checkSignup({ email: 'a@b.c', password: 'password1' }, closed), 403, /signup code/);
    rejects(() => logic.checkSignup({ email: 'a@b.c', password: 'password1', code: 'nope' }, closed), 403);
  });
  test('accepts the code case- and whitespace-insensitively', () => {
    logic.checkSignup({ email: 'a@b.c', password: 'password1', code: '  Otter-MAPLE-42 ' }, closed);
  });
  test('open signup needs no code', () => logic.checkSignup({ email: 'a@b.c', password: 'password1' }, { open_signup: true, signup_code: 'x' }));
});

describe('logic routes', () => {
  const routes = logic.compileRoutes([
    ['GET', '/api/projects', 'user', () => 'list'],
    ['GET', '/api/projects/:slug', 'user', () => 'one'],
    ['DELETE', '/api/projects/:slug/schema/:target', 'user', () => 'drop'],
  ]);
  test('matches by method and path, decoding params', () => {
    const m = logic.matchRoute(routes, 'DELETE', '/api/projects/app/schema/tasks.color%20x');
    assert.equal(m.route.handler(), 'drop');
    assert.deepEqual(m.params, { slug: 'app', target: 'tasks.color x' });
  });
  test('exact paths only', () => {
    assert.equal(logic.matchRoute(routes, 'GET', '/api/projects').route.handler(), 'list');
    assert.equal(logic.matchRoute(routes, 'GET', '/api/projects/a/b'), null);
    assert.equal(logic.matchRoute(routes, 'POST', '/api/projects'), null);
    assert.equal(logic.matchRoute(routes, 'GET', '/api/projectsX'), null);
  });
});

describe('logic.renderDocs', () => {
  const guide = '# {{SLUG}}\nUse {{PREFIX}}tasks at {{URL}}.\n';
  test('fills server facts and placeholders (https, closed signup)', () => {
    const md = logic.renderDocs({ guide, settings: { open_signup: false, max_apps_per_user: 7, max_deploy_mb: 25 }, publicUrl: 'https://ex.com', baseDomain: 'ex.com', version: '9.9.9', keepDeploys: 10 });
    assert.match(md, /Server: https:\/\/ex\.com/);
    assert.match(md, /Version: 9\.9\.9/);
    assert.match(md, /HTTPS: yes/);
    assert.match(md, /requires a signup code/);
    assert.match(md, /Apps per user: 7/);
    assert.match(md, /Max deploy size \(built dist\/\): 25 MB/);
    assert.match(md, /Use <app_with_underscores>__tasks at https:\/\/<app>\.ex\.com\./);
    assert.doesNotMatch(md, /\{\{/);
    assert.doesNotMatch(md, /^# <app>/m, 'guide title line is dropped');
  });
  test('warns on plain HTTP and open signup', () => {
    const md = logic.renderDocs({ guide, settings: { open_signup: true, max_apps_per_user: 1, max_deploy_mb: 1 }, publicUrl: 'http://1-2-3-4.sslip.io', baseDomain: '1-2-3-4.sslip.io', version: '1', keepDeploys: 10 });
    assert.match(md, /HTTPS: no/);
    assert.match(md, /Signup: open/);
  });
});
