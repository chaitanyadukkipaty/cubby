// How the server serves the dashboard (server/src/dashboard.js): one HTML shell plus its stylesheet and modules,
// under a URL prefix that changes whenever any of them does.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDashboard } from '../../server/src/dashboard.js';

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'cubby-dash-'));
  for (const [name, body] of Object.entries(files)) {
    if (body === undefined) continue;
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

const SHELL = '<link href="{{ASSETS}}/app.css"><meta name="s" content="{{PUBLIC_URL}}"><meta name="v" content="{{VERSION}}"><script type="module" src="{{ASSETS}}/js/main.js"></script>';
const FILES = { 'index.html': SHELL, 'app.css': 'body{}', 'js/main.js': "import './views/a.js';", 'js/views/a.js': 'export {}', 'skill.sh': '#!/bin/sh' };

describe('loadDashboard()', () => {
  let dash;
  before(async () => { dash = await loadDashboard(fixture(FILES)); });

  test('the page fills in the server URL, version and asset prefix', () => {
    const html = dash.page({ publicUrl: 'https://cubby.example.com', version: '0.1.4' });
    assert.ok(html.includes('content="https://cubby.example.com"'));
    assert.ok(html.includes('content="0.1.4"'));
    assert.ok(html.includes(`href="${dash.prefix}/app.css"`));
    assert.ok(html.includes(`src="${dash.prefix}/js/main.js"`));
    assert.doesNotMatch(html, /\{\{/);
    assert.match(dash.prefix, /^\/static\/[0-9a-f]{12}$/);
  });

  test('stylesheet and modules (nested too) are served under the prefix with their content type', () => {
    assert.deepEqual(dash.asset(`${dash.prefix}/app.css`), { type: 'text/css; charset=utf-8', body: Buffer.from('body{}') });
    assert.equal(dash.asset(`${dash.prefix}/js/main.js`).type, 'text/javascript; charset=utf-8');
    assert.equal(dash.asset(`${dash.prefix}/js/views/a.js`).body.toString(), 'export {}');
  });

  test('nothing else is served: other files, the shell itself, unknown paths, traversal, another prefix', () => {
    for (const p of [`${dash.prefix}/skill.sh`, `${dash.prefix}/index.html`, `${dash.prefix}/nope.js`, `${dash.prefix}/js/../app.css`,
      `${dash.prefix}/js/%2e%2e/app.css`, `${dash.prefix}`, `${dash.prefix}/`, '/static/000000000000/app.css', '/app.css', '/static/app.css'])
      assert.equal(dash.asset(p), null, p);
  });
});

test('the prefix changes when any served file changes, and old URLs stop answering', async () => {
  const a = await loadDashboard(fixture(FILES));
  const same = await loadDashboard(fixture(FILES));
  const css = await loadDashboard(fixture({ ...FILES, 'app.css': 'body{color:red}' }));
  const nested = await loadDashboard(fixture({ ...FILES, 'js/views/a.js': 'export const x = 1' }));
  const shell = await loadDashboard(fixture({ ...FILES, 'index.html': `${SHELL}<!-- -->` }));
  const renamed = await loadDashboard(fixture({ ...FILES, 'js/views/a.js': undefined, 'js/views/b.js': 'export {}' }));
  assert.equal(a.prefix, same.prefix, 'the hash depends only on content');
  for (const other of [css, nested, shell, renamed]) assert.notEqual(other.prefix, a.prefix);
  assert.equal(css.asset(`${a.prefix}/app.css`), null);
});
