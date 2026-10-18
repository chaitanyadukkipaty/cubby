import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import * as tar from 'tar';

// sites.js reads DATA_DIR at import time.
const dataDir = mkdtempSync(join(tmpdir(), 'cubby-sites-'));
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_URL = 'https://ex.com';
const sites = await import('../../server/src/sites.js');
const cliDist = await import('../../server/src/cli-dist.js');

const SLUG = 'demo';
const DEPLOY = 'd1';
const root = join(dataDir, 'sites', SLUG, DEPLOY);
const project = { slug: SLUG, current_deploy: DEPLOY };

// Minimal response double that captures what serveSite writes (including piped files).
function fakeRes() {
  const res = new PassThrough();
  res.status = null;
  res.headers = {};
  res.writeHead = (s, h = {}) => { res.status = s; res.headers = h; return res; };
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.done = new Promise((r) => res.on('finish', () => r(Buffer.concat(chunks).toString())));
  return res;
}
async function get(path, { method = 'GET', proj = project } = {}) {
  const res = fakeRes();
  await sites.serveSite({ method }, res, proj, path);
  if (!res.writableEnded) await new Promise((r) => res.on('finish', r));
  return { status: res.status, headers: res.headers, body: await res.done };
}

before(() => {
  mkdirSync(join(root, 'assets'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<h1>home</h1>');
  writeFileSync(join(root, 'assets', 'app-abc.js'), 'console.log(1)');
  writeFileSync(join(root, 'favicon.svg'), '<svg/>');
  writeFileSync(join(root, 'robots.txt'), 'ok');
  writeFileSync(join(root, 'data.bin'), 'xx');
  writeFileSync(join(root, 'docs', 'index.html'), '<h1>docs</h1>');
  writeFileSync(join(dataDir, 'secret.txt'), 'top secret');
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

describe('serveSite', () => {
  test('serves index.html at / with no-cache', async () => {
    const r = await get('/');
    assert.equal(r.status, 200);
    assert.equal(r.body, '<h1>home</h1>');
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  });
  test('hashed assets are cached immutably', async () => {
    const r = await get('/assets/app-abc.js');
    assert.equal(r.body, 'console.log(1)');
    assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable');
  });
  test('other files get a short cache and the right type', async () => {
    assert.equal((await get('/favicon.svg')).headers['content-type'], 'image/svg+xml');
    assert.equal((await get('/robots.txt')).headers['cache-control'], 'public, max-age=300');
    assert.equal((await get('/data.bin')).headers['content-type'], 'application/octet-stream');
  });
  test('directories serve their index.html', async () => assert.equal((await get('/docs')).body, '<h1>docs</h1>'));
  test('SPA fallback: unknown extensionless paths serve the root index.html', async () => {
    for (const p of ['/polls/123', '/settings', '/a/b/c']) assert.equal((await get(p)).body, '<h1>home</h1>', p);
  });
  test('missing files with an extension are a real 404', async () => {
    const r = await get('/assets/missing.js');
    assert.equal(r.status, 404);
  });
  test('path traversal cannot escape the deploy directory', async () => {
    for (const p of ['/../../../secret.txt', '/..%2f..%2f..%2fsecret.txt', '/%2e%2e/%2e%2e/%2e%2e/secret.txt', '/assets/../../../../secret.txt']) {
      const r = await get(p);
      assert.ok(!r.body.includes('top secret'), `leaked via ${p}`);
    }
  });
  test('malformed URL encoding is a 400', async () => assert.equal((await get('/%E0%A4%A')).status, 400));
  test('HEAD sends headers only', async () => {
    const r = await get('/', { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.equal(r.body, '');
  });
  test('says whether it served an HTML page (what metrics count), not an asset or an error', async () => {
    const served = async (path, proj = project) => {
      const res = fakeRes();
      const page = await sites.serveSite({ method: 'GET' }, res, proj, path);
      await res.done;
      return page;
    };
    for (const p of ['/', '/docs', '/polls/123', '/index.html']) assert.equal(await served(p), true, p);
    for (const p of ['/assets/app-abc.js', '/favicon.svg', '/robots.txt', '/assets/missing.js', '/%E0%A4%A']) assert.equal(await served(p), false, p);
    assert.equal(await served('/', { slug: 'empty', current_deploy: '' }), false);
  });
  test('apps with no deploy explain how to deploy', async () => {
    const r = await get('/', { proj: { slug: 'empty', current_deploy: '' } });
    assert.equal(r.status, 404);
    assert.match(r.body, /no deploys yet/);
    assert.match(r.body, /cubby deploy/);
  });
});

describe('sendPage', () => {
  test('renders a small HTML page with the status', async () => {
    const res = fakeRes();
    sites.sendPage(res, 418, 'Teapot', 'short and stout');
    assert.equal(res.status, 418);
    assert.match(await res.done, /<title>Teapot<\/title>.*short and stout/s);
  });
});

async function tarball(build) {
  const src = mkdtempSync(join(tmpdir(), 'cubby-tar-'));
  build(src);
  const chunks = [];
  for await (const c of tar.c({ gzip: true, cwd: src, portable: true }, readdirSync(src))) chunks.push(c);
  rmSync(src, { recursive: true, force: true });
  return Buffer.concat(chunks);
}

describe('extractDeploy', () => {
  test('extracts files, counts files and bytes', async () => {
    const tgz = await tarball((d) => { writeFileSync(join(d, 'index.html'), '12345'); mkdirSync(join(d, 'assets')); writeFileSync(join(d, 'assets', 'a.js'), '123'); });
    const out = join(dataDir, 'x1');
    assert.deepEqual(await sites.extractDeploy(tgz, out), { files: 2, bytes: 8 });
    assert.ok(existsSync(join(out, 'assets', 'a.js')));
  });
  test('drops symlinks so a deploy cannot point outside itself', async () => {
    const tgz = await tarball((d) => { writeFileSync(join(d, 'index.html'), 'x'); symlinkSync('/etc/passwd', join(d, 'passwd')); });
    const out = join(dataDir, 'x2');
    assert.deepEqual(await sites.extractDeploy(tgz, out), { files: 1, bytes: 1 });
    assert.ok(!existsSync(join(out, 'passwd')));
  });
  test('requires index.html at the root and cleans up', async () => {
    const tgz = await tarball((d) => { mkdirSync(join(d, 'dist')); writeFileSync(join(d, 'dist', 'index.html'), 'x'); });
    const out = join(dataDir, 'x3');
    await assert.rejects(sites.extractDeploy(tgz, out), (e) => e.status === 400 && /index\.html at its root/.test(e.message));
    assert.ok(!existsSync(out));
  });
  test('rejects data that is not a gzip tarball and cleans up', async () => {
    const out = join(dataDir, 'x4');
    await assert.rejects(sites.extractDeploy(Buffer.from('definitely not a tarball'), out), (e) => e.status === 400 && /Invalid tarball/.test(e.message));
    assert.ok(!existsSync(out));
  });
});

describe('disk usage', () => {
  test('dirSize sums nested files and is 0 for missing dirs', async () => {
    const d = join(dataDir, 'du');
    mkdirSync(join(d, 'a', 'b'), { recursive: true });
    writeFileSync(join(d, 'x'), '1234');
    writeFileSync(join(d, 'a', 'b', 'y'), '12');
    assert.equal(await sites.dirSize(d), 6);
    assert.equal(await sites.dirSize(join(dataDir, 'nope')), 0);
  });
  test('appDiskUsage = deploys + uploaded files of the app\'s collections', async () => {
    mkdirSync(join(dataDir, 'pb_data', 'storage', 'pbc_files'), { recursive: true });
    writeFileSync(join(dataDir, 'pb_data', 'storage', 'pbc_files', 'f'), '1234567890');
    const deploys = await sites.dirSize(join(dataDir, 'sites', SLUG));
    assert.equal(await sites.appDiskUsage(SLUG, ['pbc_files', 'pbc_missing']), deploys + 10);
  });
  test('removeSite deletes all deploys of an app', async () => {
    mkdirSync(join(dataDir, 'sites', 'gone', 'd'), { recursive: true });
    await sites.removeSite('gone');
    assert.ok(!existsSync(join(dataDir, 'sites', 'gone')));
  });
});

describe('cli-dist', () => {
  test('skillMarkdown stamps the version and stays server-neutral', async () => {
    const md = cliDist.skillMarkdown();
    assert.match(md, /^---\nname: cubby/);
    const { config } = await import('../../server/src/config.js');
    assert.ok(md.includes(`**Skill version: ${config.version}**`), 'stamped with the version this server reports');
    assert.doesNotMatch(md, /\{\{/);
    assert.doesNotMatch(md, /https:\/\/ex\.com/, 'one skill serves every server; skill.sh registers the server');
  });
  test('buildCliTarball produces an npm package with src, template, skill and a versioned package.json', async () => {
    assert.equal(cliDist.cliTarball(), null);
    await cliDist.buildCliTarball();
    const entries = [];
    let pkg;
    const parser = new tar.Parser({ onReadEntry: (e) => {
      entries.push(e.path);
      if (e.path === 'package/package.json') { let s = ''; e.on('data', (d) => (s += d)); e.on('end', () => (pkg = JSON.parse(s))); } else e.resume();
    } });
    await new Promise((res) => { parser.on('end', res); parser.end(cliDist.cliTarball()); });
    for (const want of ['package/package.json', 'package/src/index.js', 'package/src/launcher.js', 'package/src/servers.js', 'package/src/lib.js', 'package/skill/cubby/SKILL.md', 'package/template/AGENTS.md', 'package/template/_gitignore'])
      assert.ok(entries.includes(want), `missing ${want}`);
    assert.ok(entries.every((p) => p.startsWith('package/')));
    assert.ok(!entries.some((p) => p.includes('node_modules')));
    // Stamped with the version the server reports ("X.Y.Z", or "X.Y.Z-dev+<sha>" outside a release build).
    const { config } = await import('../../server/src/config.js');
    assert.equal(pkg.version, config.version);
    assert.deepEqual(pkg.bin, { cubby: 'src/launcher.js' });
  });
});

describe('oldDeploys', () => {
  // Newest first, as listDeploys returns them; the app was rolled back to d3.
  const list = ['d5', 'd4', 'd3', 'd2', 'd1'].map((id) => ({ id, current: id === 'd3' }));
  const ids = (picked) => picked.map((d) => d.id);
  test('picks every deploy but the current one, oldest first', () => {
    assert.deepEqual(ids(sites.oldDeploys(list)), ['d1', 'd2', 'd4', 'd5']);
  });
  test('keep N spares the N newest besides the current one', () => {
    assert.deepEqual(ids(sites.oldDeploys(list, { keep: 2 })), ['d1', 'd2']);
    assert.deepEqual(ids(sites.oldDeploys(list, { keep: '1' })), ['d1', 'd2', 'd4']);
    assert.deepEqual(ids(sites.oldDeploys(list, { keep: 10 })), []);
    for (const bad of [-1, 1.5, 'x']) assert.throws(() => sites.oldDeploys(list, { keep: bad }), (e) => e.status === 400 && /keep must be a whole number/.test(e.message), String(bad));
  });
  test('one deploy by id, but never the current one', () => {
    assert.deepEqual(ids(sites.oldDeploys(list, { id: 'd4' })), ['d4']);
    assert.throws(() => sites.oldDeploys(list, { id: 'd3' }), (e) => e.status === 409 && /current deploy/.test(e.message));
    assert.throws(() => sites.oldDeploys(list, { id: 'nope' }), (e) => e.status === 404);
  });
  test('an unknown id is echoed back cut short, however long it is', () => {
    assert.throws(() => sites.oldDeploys(list, { id: 'x'.repeat(500) }), (e) => e.status === 404 && e.message === `Deploy ${'x'.repeat(40)}… not found`);
  });
});
