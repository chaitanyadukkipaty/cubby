// Version identity and the update notice, against real servers. GitHub is replaced by a local fake.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as tar from 'tar';
import { startServer, ADMIN, ROOT } from '../helpers/server.js';
import { api, adminToken } from '../helpers/integration.js';

const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const [maj, min, pat] = PKG.split('.').map(Number);
const NEWER = `v${maj}.${min}.${pat + 1}`;

let github, githubUrl, hits = 0;
before(async () => {
  github = http.createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tag_name: NEWER, html_url: `https://github.com/x/releases/tag/${NEWER}` }));
  });
  await new Promise((r) => github.listen(0, '127.0.0.1', r));
  githubUrl = `http://127.0.0.1:${github.address().port}/releases/latest`;
});
after(() => github.close());

async function tarballVersion(url) {
  const buf = Buffer.from(await (await fetch(`${url}/cli.tgz`)).arrayBuffer());
  let pkg;
  const parser = new tar.Parser({ onReadEntry: (e) => {
    if (e.path === 'package/package.json') { let s = ''; e.on('data', (d) => (s += d)); e.on('end', () => (pkg = JSON.parse(s))); } else e.resume();
  } });
  await new Promise((res) => { parser.on('end', res); parser.end(buf); });
  return pkg.version;
}

describe('a dev build with an update available', () => {
  let srv, adm;
  before(async () => {
    srv = await startServer({ CUBBY_COMMIT: 'abc1234', CUBBY_TAG: '', CUBBY_UPDATE_CHECK: '1', CUBBY_UPDATE_URL: githubUrl });
    adm = api(srv.url, await adminToken(srv.url, ADMIN));
  });
  after(() => srv.stop());

  test('reports X.Y.Z-dev+<sha> everywhere, including the CLI it serves', async () => {
    const want = `${PKG}-dev+abc1234`;
    const info = await api(srv.url)('GET', '/api/info');
    assert.equal(info.data.version, want);
    assert.equal(info.data.commit, 'abc1234');
    assert.equal(info.headers.get('x-cubby-version'), want);
    assert.equal(await tarballVersion(srv.url), want);
    assert.match(await (await fetch(`${srv.url}/docs.md`)).text(), new RegExp(`Version: ${want.replace(/[.+]/g, '\\$&')}`));
  });

  test('admins see the newer release; turning the check off hides it and stops checks', async () => {
    // The start-up check runs in the background; give it a moment.
    let o;
    for (let i = 0; i < 40; i++) {
      o = (await adm('GET', '/api/admin/overview')).data;
      if (o.update.checked_at) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(o.server.commit, 'abc1234');
    assert.equal(o.settings.update_check, true);
    assert.equal(o.update.enabled, true);
    assert.equal(o.update.latest, NEWER);
    assert.equal(o.update.update_available, true);
    assert.equal(o.update.release_url, `https://github.com/x/releases/tag/${NEWER}`);
    assert.ok(hits >= 1, 'checked GitHub (the fake) at start-up');

    const off = await adm('PATCH', '/api/admin/settings', { body: { update_check: false } });
    assert.equal(off.data.update_check, false);
    const o2 = (await adm('GET', '/api/admin/overview')).data;
    assert.deepEqual(o2.update, { enabled: false, reason: 'setting', current: `${PKG}-dev+abc1234` });

    const on = await adm('PATCH', '/api/admin/settings', { body: { update_check: true } });
    assert.equal(on.data.update_check, true);
    assert.equal((await adm('GET', '/api/admin/overview')).data.update.update_available, true);
  });

  test('non-admins cannot see update details', async () => {
    assert.equal((await api(srv.url)('GET', '/api/admin/overview')).status, 401);
  });
});

describe('a release build with the check disabled by env', () => {
  let srv;
  before(async () => {
    hits = 0;
    srv = await startServer({ CUBBY_COMMIT: 'def5678', CUBBY_TAG: `v${PKG}`, CUBBY_UPDATE_CHECK: '0', CUBBY_UPDATE_URL: githubUrl });
  });
  after(() => srv.stop());

  test('reports the plain version and never calls out', async () => {
    const info = await api(srv.url)('GET', '/api/info');
    assert.equal(info.data.version, PKG);
    assert.equal(info.data.commit, 'def5678');
    const o = (await api(srv.url, await adminToken(srv.url, ADMIN))('GET', '/api/admin/overview')).data;
    assert.deepEqual(o.update, { enabled: false, reason: 'env', current: PKG });
    assert.equal(hits, 0);
  });
});
