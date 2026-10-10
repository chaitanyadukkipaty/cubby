// The launcher: which CLI version runs for which server, version caching, atomic installs, offline fallback.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import * as L from '../../cli/src/launcher.js';

let home, cwd, nodeModules;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cubby-launch-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'cubby-launch-cwd-'));
  nodeModules = mkdtempSync(join(tmpdir(), 'cubby-launch-nm-'));
});
afterEach(() => { for (const d of [home, cwd, nodeModules]) rmSync(d, { recursive: true, force: true }); });

// An npm-style tarball like a server's /cli.tgz, for a given version.
async function cliTgz(version, { withEntry = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cubby-tgz-'));
  mkdirSync(join(dir, 'package', 'src'), { recursive: true });
  writeFileSync(join(dir, 'package', 'package.json'), JSON.stringify({ name: 'cubby-cli', version }));
  if (withEntry) writeFileSync(join(dir, 'package', 'src', 'index.js'), `console.log('cli ${version}')`);
  const chunks = [];
  for await (const c of tar.c({ gzip: true, cwd: dir, portable: true }, ['package'])) chunks.push(c);
  rmSync(dir, { recursive: true, force: true });
  return Buffer.concat(chunks);
}

const writeCfg = (cfg) => { mkdirSync(join(home, '.cubby'), { recursive: true }); writeFileSync(join(home, '.cubby', 'config.json'), JSON.stringify(cfg)); };
const readCfg = () => JSON.parse(readFileSync(join(home, '.cubby', 'config.json'), 'utf8'));
const NOW = 1_000_000_000_000;
const server = (url, extra = {}) => ({ name: null, url, email: null, token: 'hk_tok', version: null, ...extra });

function deps(over = {}) {
  const calls = { fetch: [], download: [] };
  const d = {
    home, cwd, env: {}, now: () => NOW, nodeModules, bundledVersion: '0.2.0',
    fetchVersion: async (url) => { calls.fetch.push(url); return '0.2.0'; },
    download: async (url) => { calls.download.push(url); return cliTgz('0.1.0'); },
    ...over,
  };
  return { d, calls };
}

describe('parseLaunchArgs', () => {
  test('finds the command and strips --server in both forms', () => {
    assert.deepEqual(L.parseLaunchArgs(['deploy', '--server', 'Acme', '-m', 'x']), { command: 'deploy', server: 'Acme', argsWithoutServer: ['deploy', '-m', 'x'] });
    assert.deepEqual(L.parseLaunchArgs(['--json', '--server=https://a.dev', 'init', 'app']), { command: 'init', server: 'https://a.dev', argsWithoutServer: ['--json', 'init', 'app'] });
  });
  test('no command', () => assert.equal(L.parseLaunchArgs(['--help']).command, null));
});

describe('helpers', () => {
  test('cachedVersion honours the TTL and needs a check time', () => {
    assert.equal(L.cachedVersion({ version: '1.0.0', version_checked_at: NOW - 1000 }, NOW), '1.0.0');
    assert.equal(L.cachedVersion({ version: '1.0.0', version_checked_at: NOW - L.VERSION_TTL_MS - 1 }, NOW), null);
    assert.equal(L.cachedVersion({ version: '1.0.0' }, NOW), null);
    assert.equal(L.cachedVersion(null, NOW), null);
  });
  test('only app commands depend on the server version', () => {
    for (const c of ['init', 'deploy', 'schema', 'rollback', 'version']) assert.ok(L.SERVER_COMMANDS.has(c), c);
    for (const c of ['login', 'signup', 'logout', 'servers', 'use', 'skill', 'whoami', null]) assert.ok(!L.SERVER_COMMANDS.has(c), String(c));
  });
  test('sharedNodeModules finds the directory tar resolves from', () => {
    const dir = L.sharedNodeModules();
    assert.match(dir, /node_modules$/);
    assert.ok(existsSync(join(dir, 'tar')));
  });
  test('cachedVersions lists complete installs, newest first, ignoring temp dirs', async () => {
    for (const v of ['0.9.0', '0.10.0', '0.2.1']) await L.installCli({ home, url: 'u', download: () => cliTgz(v), nodeModules });
    mkdirSync(join(L.cliRoot(home), '.tmp-123'));
    mkdirSync(join(L.cliRoot(home), '9.9.9')); // incomplete: no src/index.js
    assert.deepEqual(L.cachedVersions(home), ['0.10.0', '0.9.0', '0.2.1']);
    assert.deepEqual(L.cachedVersions(join(home, 'nope')), []);
  });
});

describe('network helpers (against a local server)', () => {
  let srv, base;
  const routes = {
    '/ok/api/info': [200, '{"version":"1.2.3","name":"X"}'],
    '/old/api/info': [200, '{"name":"no version"}'],
    '/down/api/info': [503, '{}'],
    '/ok/cli.tgz': [200, 'tgz-bytes'],
  };
  beforeEach(async () => {
    const http = await import('node:http');
    srv = http.createServer((req, res) => {
      const [status, body] = routes[req.url] ?? [404, ''];
      res.writeHead(status);
      res.end(body);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  afterEach(() => new Promise((r) => srv.close(r)));

  test('fetchVersion reads /api/info', async () => assert.equal(await L.fetchVersion(`${base}/ok`), '1.2.3'));
  test('fetchVersion rejects errors and servers without a version', async () => {
    await assert.rejects(L.fetchVersion(`${base}/down`), /HTTP 503/);
    await assert.rejects(L.fetchVersion(`${base}/old`), /no version/);
  });
  test('download returns the body and rejects HTTP errors', async () => {
    assert.equal((await L.download(`${base}/ok/cli.tgz`)).toString(), 'tgz-bytes');
    await assert.rejects(L.download(`${base}/missing`), /HTTP 404/);
  });
});

describe('installCli', () => {
  test('installs into ~/.cubby/cli/<version> with shared node_modules and no temp dir left', async () => {
    const v = await L.installCli({ home, url: 'https://a.dev', download: async (u) => { assert.equal(u, 'https://a.dev/cli.tgz'); return cliTgz('0.1.0'); }, nodeModules });
    assert.equal(v, '0.1.0');
    assert.ok(existsSync(L.cliEntry(home, '0.1.0')));
    const nm = join(L.cliRoot(home), '0.1.0', 'package', 'node_modules');
    assert.ok(lstatSync(nm).isSymbolicLink());
    assert.equal(readlinkSync(nm), nodeModules);
    assert.deepEqual(readdirSync(L.cliRoot(home)), ['0.1.0']);
  });
  test('uses the version inside the tarball (server upgraded since /api/info)', async () => {
    assert.equal(await L.installCli({ home, url: 'u', download: () => cliTgz('0.3.0'), nodeModules }), '0.3.0');
  });
  test('a concurrent install of the same version keeps the first and cleans up', async () => {
    await L.installCli({ home, url: 'u', download: () => cliTgz('0.1.0'), nodeModules });
    await L.installCli({ home, url: 'u', download: () => cliTgz('0.1.0'), nodeModules });
    assert.deepEqual(readdirSync(L.cliRoot(home)), ['0.1.0']);
  });
  test('a broken tarball leaves nothing behind', async () => {
    await assert.rejects(L.installCli({ home, url: 'u', download: async () => Buffer.from('not a tarball'), nodeModules }));
    assert.deepEqual(readdirSync(L.cliRoot(home)), []);
  });
  test('a tarball without src/index.js is rejected and cleaned up', async () => {
    await assert.rejects(L.installCli({ home, url: 'u', download: () => cliTgz('0.1.0', { withEntry: false }), nodeModules }), /no src\/index\.js/);
    assert.deepEqual(readdirSync(L.cliRoot(home)), []);
  });
});

describe('plan', () => {
  const twoServers = (acme = {}) => ({
    format: 1, default: 'priya.dev',
    servers: { 'priya.dev': server('https://priya.dev'), 'cubby.acme.com': server('https://cubby.acme.com', { token: 'hk_acme', ...acme }) },
  });

  test('account and help commands always run the bundled CLI without network', async () => {
    const { d, calls } = deps();
    for (const argv of [['login', 'https://x.dev'], ['servers'], ['skill', 'status'], ['whoami'], [], ['--help']])
      assert.deepEqual(await L.plan(argv, d), { run: 'bundled' });
    assert.equal(calls.fetch.length, 0);
  });
  test('inside a launched child, never dispatch again', async () => {
    writeCfg(twoServers());
    const { d, calls } = deps({ env: { CUBBY_LAUNCHED: '1' } });
    assert.deepEqual(await L.plan(['deploy'], d), { run: 'bundled' });
    assert.equal(calls.fetch.length, 0);
  });
  test('an unresolvable server falls through to the bundled CLI (which reports it)', async () => {
    const { d } = deps();
    assert.deepEqual(await L.plan(['deploy'], d), { run: 'bundled' });
  });
  test('same version as bundled: bundled, and the version is cached in config', async () => {
    writeCfg(twoServers());
    const { d, calls } = deps();
    assert.equal((await L.plan(['deploy'], d)).run, 'bundled');
    assert.deepEqual(calls.fetch, ['https://priya.dev']);
    assert.deepEqual([readCfg().servers['priya.dev'].version, readCfg().servers['priya.dev'].version_checked_at], ['0.2.0', NOW]);
  });
  test('a fresh cached version skips the network', async () => {
    writeCfg(twoServers({ version: '0.1.0', version_checked_at: NOW - 1000 }));
    await L.installCli({ home, url: 'u', download: () => cliTgz('0.1.0'), nodeModules });
    const { d, calls } = deps();
    const p = await L.plan(['deploy', '--server', 'cubby.acme.com'], d);
    assert.equal(p.run, 'cached');
    assert.equal(calls.fetch.length, 0);
    assert.equal(calls.download.length, 0);
  });
  test('a different version downloads that server\'s CLI and runs it with the server and token in env', async () => {
    writeCfg(twoServers());
    const { d, calls } = deps({ fetchVersion: async () => '0.1.0' });
    const p = await L.plan(['deploy', '--server', 'cubby.acme.com', '-m', 'x'], d);
    assert.equal(p.run, 'cached');
    assert.equal(p.version, '0.1.0');
    assert.equal(p.entry, L.cliEntry(home, '0.1.0'));
    assert.deepEqual(p.args, ['deploy', '-m', 'x'], '--server is resolved by the launcher, not passed on');
    assert.deepEqual([p.env.CUBBY_SERVER, p.env.CUBBY_TOKEN, p.env.CUBBY_LAUNCHED], ['https://cubby.acme.com', 'hk_acme', '1']);
    assert.deepEqual(calls.download, ['https://cubby.acme.com/cli.tgz']);
  });
  test('the app\'s cubby.json picks the server', async () => {
    writeCfg(twoServers());
    writeFileSync(join(cwd, 'cubby.json'), JSON.stringify({ format: 1, project: 'p', server: 'https://cubby.acme.com' }));
    const { d, calls } = deps({ fetchVersion: async (u) => { calls.fetch.push(u); return '0.2.0'; } });
    await L.plan(['deploy'], d);
    assert.deepEqual(calls.fetch, ['https://cubby.acme.com']);
  });
  test('an explicit CUBBY_TOKEN is not overridden', async () => {
    writeCfg(twoServers());
    const { d } = deps({ env: { CUBBY_TOKEN: 'hk_ci' }, fetchVersion: async () => '0.1.0' });
    const p = await L.plan(['deploy', '--server', 'cubby.acme.com'], d);
    assert.equal(p.env.CUBBY_TOKEN, 'hk_ci');
  });
  test('a URL you are not logged in to still dispatches, without a token', async () => {
    const { d } = deps({ fetchVersion: async () => '0.1.0' });
    const p = await L.plan(['projects', '--server', 'https://new.dev'], d);
    assert.equal(p.run, 'cached');
    assert.equal(p.env.CUBBY_TOKEN, undefined);
  });
  test('offline with a cached CLI for the last known version: uses it, with a note', async () => {
    writeCfg(twoServers({ version: '0.1.0', version_checked_at: NOW - L.VERSION_TTL_MS * 2 }));
    await L.installCli({ home, url: 'u', download: () => cliTgz('0.1.0'), nodeModules });
    const { d } = deps({ fetchVersion: async () => { throw new Error('ECONNREFUSED'); } });
    const p = await L.plan(['deploy', '--server', 'Cubby.Acme.com'], d);
    assert.equal(p.run, 'cached');
    assert.match(p.notes[0], /can't reach https:\/\/cubby\.acme\.com; using the cached CLI for its last known version 0\.1\.0/);
  });
  test('offline with no known version: bundled, silently', async () => {
    writeCfg(twoServers());
    const { d } = deps({ fetchVersion: async () => { throw new Error('down'); } });
    assert.deepEqual(await L.plan(['deploy', '--server', 'cubby.acme.com'], d), { run: 'bundled', notes: [] });
  });
  test('offline, known version, nothing cached and the download fails too: bundled with notes', async () => {
    writeCfg(twoServers({ version: '0.1.0' }));
    const { d } = deps({ fetchVersion: async () => { throw new Error('down'); }, download: async () => { throw new Error('down'); } });
    const p = await L.plan(['deploy', '--server', 'cubby.acme.com'], d);
    assert.equal(p.run, 'bundled');
    assert.equal(p.notes.length, 2);
    assert.match(p.notes[1], /couldn't fetch the CLI for https:\/\/cubby\.acme\.com \(v0\.1\.0\): down; using the bundled v0\.2\.0/);
  });
  test('online but /cli.tgz fails: bundled with a note', async () => {
    writeCfg(twoServers());
    const { d } = deps({ fetchVersion: async () => '0.1.0', download: async () => { throw new Error('HTTP 404'); } });
    const p = await L.plan(['deploy', '--server', 'cubby.acme.com'], d);
    assert.deepEqual([p.run, p.notes.length], ['bundled', 1]);
  });
});
