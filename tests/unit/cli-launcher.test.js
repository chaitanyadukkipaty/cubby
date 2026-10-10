// The launcher. Rule: the CLI that runs a command matches the version of the server that command talks to (in an
// app folder, the server in cubby.json). Also: config.json ownership, newer-format refusal, login capture, skill
// refresh, version caching, atomic installs and offline fallback.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import * as L from '../../cli/src/launcher.js';
import { skillStatus } from '../../cli/src/lib.js';

let home, cwd, nodeModules;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cubby-launch-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'cubby-launch-cwd-'));
  nodeModules = mkdtempSync(join(tmpdir(), 'cubby-launch-nm-'));
});
afterEach(() => { for (const d of [home, cwd, nodeModules]) rmSync(d, { recursive: true, force: true }); });

// An npm-style tarball like a server's /cli.tgz, for a given version.
async function cliTgz(version, { withEntry = true, withHelp = true, skill = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cubby-tgz-'));
  mkdirSync(join(dir, 'package', 'src'), { recursive: true });
  writeFileSync(join(dir, 'package', 'package.json'), JSON.stringify({ name: 'cubby-cli', version }));
  if (withEntry) writeFileSync(join(dir, 'package', 'src', 'index.js'), `console.log('cli ${version}')`);
  if (withHelp) writeFileSync(join(dir, 'package', 'src', 'commands.js'), 'export const COMMANDS = [];');
  if (skill) {
    mkdirSync(join(dir, 'package', 'skill', 'cubby'), { recursive: true });
    writeFileSync(join(dir, 'package', 'skill', 'cubby', 'SKILL.md'), `# Cubby\n\n**Skill version: 0.0.0**\n\nfrom ${version}\n`);
  }
  const chunks = [];
  for await (const c of tar.c({ gzip: true, cwd: dir, portable: true }, ['package'])) chunks.push(c);
  rmSync(dir, { recursive: true, force: true });
  return Buffer.concat(chunks);
}

const writeCfg = (cfg) => { mkdirSync(join(home, '.cubby'), { recursive: true }); writeFileSync(join(home, '.cubby', 'config.json'), JSON.stringify(cfg)); };
const readCfg = () => JSON.parse(readFileSync(join(home, '.cubby', 'config.json'), 'utf8'));
const NOW = 1_000_000_000_000;
const server = (url, extra = {}) => ({ name: null, url, email: null, token: 'hk_tok', version: null, ...extra });
const PRIYA = 'https://priya.dev';
const ACME = 'https://cubby.acme.com';
// priya.dev (default) runs 0.2.0 like the bundled CLI; cubby.acme.com runs 0.1.5.
const VERSIONS = { [PRIYA]: '0.2.0', [ACME]: '0.1.5', 'https://new.dev': '0.1.5' };
const twoServers = (acme = {}) => ({
  format: 1, default: 'priya.dev',
  servers: { 'priya.dev': server(PRIYA, { token: 'hk_priya' }), 'cubby.acme.com': server(ACME, { token: 'hk_acme', ...acme }) },
});

function deps(over = {}) {
  const calls = { fetch: [], download: [] };
  const d = {
    home, cwd, env: {}, now: () => NOW, nodeModules, bundledVersion: '0.2.0',
    fetchVersion: async (url) => { calls.fetch.push(url); return VERSIONS[url] ?? '0.2.0'; },
    download: async (url) => { calls.download.push(url); return cliTgz(VERSIONS[url.replace(/\/cli\.tgz$/, '')] ?? '0.1.5'); },
    ...over,
  };
  return { d, calls };
}

describe('parseLaunchArgs', () => {
  test('finds the command, its argument and --server in both forms', () => {
    const a = L.parseLaunchArgs(['deploy', '--server', 'Acme', '-m', 'x']);
    assert.deepEqual([a.command, a.arg, a.server], ['deploy', null, 'Acme']);
    const b = L.parseLaunchArgs(['--json', '--server=https://a.dev', 'login', 'https://b.dev', '--no-wait']);
    assert.deepEqual([b.command, b.arg, b.server, b.json, b.noWait, b.wait], ['login', 'https://b.dev', 'https://a.dev', true, true, false]);
  });
  test('a flag\'s value is never mistaken for the command\'s argument', () => {
    assert.equal(L.parseLaunchArgs(['login', '--token', 'hk_x']).arg, null);
    assert.equal(L.parseLaunchArgs(['schema', 'push']).arg, 'push');
  });
  test('no command', () => assert.equal(L.parseLaunchArgs(['--help']).command, null));
});

describe('command classes', () => {
  test('everything that talks to a server is version-matched, including login, whoami and help', () => {
    for (const c of ['login', 'signup', 'whoami', 'help', 'init', 'link', 'projects', 'info', 'delete', 'schema', 'deploy', 'deploys', 'rollback']) assert.ok(L.SERVER_COMMANDS.has(c), c);
  });
  test('purely local commands are never version-matched', () => {
    for (const c of ['servers', 'use', 'logout', 'skill', 'version']) {
      assert.ok(L.LOCAL_COMMANDS.has(c), c);
      assert.ok(!L.SERVER_COMMANDS.has(c), c);
    }
  });
  test('config writers', () => assert.deepEqual([...L.CONFIG_WRITERS].sort(), ['login', 'logout', 'signup', 'use']));
});

describe('helpers', () => {
  test('cachedVersion honours the TTL and needs a check time', () => {
    assert.equal(L.cachedVersion({ version: '1.0.0', version_checked_at: NOW - 1000 }, NOW), '1.0.0');
    assert.equal(L.cachedVersion({ version: '1.0.0', version_checked_at: NOW - L.VERSION_TTL_MS - 1 }, NOW), null);
    assert.equal(L.cachedVersion({ version: '1.0.0' }, NOW), null);
    assert.equal(L.cachedVersion(null, NOW), null);
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

  test('fetchVersion and fetchInfo read /api/info', async () => {
    assert.equal(await L.fetchVersion(`${base}/ok`), '1.2.3');
    assert.deepEqual(await L.fetchInfo(`${base}/ok`), { version: '1.2.3', name: 'X' });
  });
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
    const v = await L.installCli({ home, url: 'https://a.dev', download: async (u) => { assert.equal(u, 'https://a.dev/cli.tgz'); return cliTgz('0.1.5'); }, nodeModules });
    assert.equal(v, '0.1.5');
    assert.ok(existsSync(L.cliEntry(home, '0.1.5')));
    const nm = join(L.cliRoot(home), '0.1.5', 'package', 'node_modules');
    assert.ok(lstatSync(nm).isSymbolicLink());
    assert.equal(readlinkSync(nm), nodeModules);
    assert.deepEqual(readdirSync(L.cliRoot(home)), ['0.1.5']);
  });
  test('uses the version inside the tarball (server upgraded since /api/info)', async () => {
    assert.equal(await L.installCli({ home, url: 'u', download: () => cliTgz('0.3.0'), nodeModules }), '0.3.0');
  });
  test('a concurrent install of the same version keeps the first and cleans up', async () => {
    await L.installCli({ home, url: 'u', download: () => cliTgz('0.1.5'), nodeModules });
    await L.installCli({ home, url: 'u', download: () => cliTgz('0.1.5'), nodeModules });
    assert.deepEqual(readdirSync(L.cliRoot(home)), ['0.1.5']);
  });
  test('a broken tarball leaves nothing behind', async () => {
    await assert.rejects(L.installCli({ home, url: 'u', download: async () => Buffer.from('not a tarball'), nodeModules }));
    assert.deepEqual(readdirSync(L.cliRoot(home)), []);
  });
  test('a tarball without src/index.js is rejected and cleaned up', async () => {
    await assert.rejects(L.installCli({ home, url: 'u', download: () => cliTgz('0.1.5', { withEntry: false }), nodeModules }), /no src\/index\.js/);
    assert.deepEqual(readdirSync(L.cliRoot(home)), []);
  });
});

describe('plan: the CLI matches the server each command talks to', () => {
  // [description, argv, extra deps, expected server URL]
  const sources = [
    ['--server name', ['--server', 'cubby.acme.com'], {}, ACME],
    ['--server URL', ['--server', ACME], {}, ACME],
    ['CUBBY_SERVER', [], { env: { CUBBY_SERVER: 'cubby.acme.com' } }, ACME],
    ['the app\'s cubby.json', [], { project: ACME }, ACME],
    ['the default server', [], {}, PRIYA],
  ];
  const appCommands = [['deploy'], ['init', 'app'], ['schema', 'push'], ['projects'], ['help'], ['whoami']];
  for (const [what, extra, over, url] of sources) {
    for (const cmd of appCommands) {
      test(`${cmd[0]} via ${what} → ${url === ACME ? '0.1.5 (cached)' : '0.2.0 (bundled)'}`, async () => {
        writeCfg(twoServers());
        if (over.project) writeFileSync(join(cwd, 'cubby.json'), JSON.stringify({ format: 1, project: 'p', server: over.project }));
        const { d, calls } = deps(over.env ? { env: over.env } : {});
        const p = await L.plan([...cmd, ...extra], d);
        assert.deepEqual(calls.fetch, [url]);
        if (url === ACME) {
          assert.equal(p.run, 'cached');
          assert.equal(p.version, '0.1.5');
          assert.equal(p.env.CUBBY_SERVER, ACME);
        } else {
          assert.equal(p.run, 'bundled');
        }
      });
    }
  }
  test('in an app folder, --server still wins over cubby.json (explicit beats implicit)', async () => {
    writeCfg(twoServers());
    writeFileSync(join(cwd, 'cubby.json'), JSON.stringify({ format: 1, project: 'p', server: ACME }));
    const { d, calls } = deps();
    await L.plan(['deploy', '--server', 'priya.dev'], d);
    assert.deepEqual(calls.fetch, [PRIYA]);
  });
  test('never picks a CLI by "latest": an app on the older server always gets the older CLI', async () => {
    writeCfg(twoServers());
    await L.installCli({ home, url: 'u', download: () => cliTgz('0.9.0'), nodeModules }); // a newer cached CLI exists
    writeFileSync(join(cwd, 'cubby.json'), JSON.stringify({ format: 1, project: 'p', server: ACME }));
    const { d } = deps();
    for (const cmd of [['whoami'], ['help', '--json'], ['deploy']]) {
      const p = await L.plan(cmd, d);
      assert.equal(p.version, '0.1.5', cmd[0]);
    }
  });
});

describe('plan: login and signup target the server they name', () => {
  test('login <url> runs that server\'s CLI with the arguments untouched; it names its own server', async () => {
    writeCfg(twoServers());
    const { d, calls } = deps();
    const p = await L.plan(['login', 'https://new.dev', '--token', 'hk_new'], d);
    assert.deepEqual(calls.fetch, ['https://new.dev']);
    assert.equal(p.run, 'cached');
    assert.deepEqual(p.args, ['login', 'https://new.dev', '--token', 'hk_new']);
    assert.equal(p.env.CUBBY_SERVER, undefined);
    assert.equal(p.env.CUBBY_LAUNCHED, '1');
  });
  test('signup to a server you already use matches its version', async () => {
    writeCfg(twoServers());
    const p = await L.plan(['signup', 'cubby.acme.com', '--email', 'e'], deps().d);
    assert.equal(p.target.url, ACME);
    assert.equal(p.version, '0.1.5');
  });
  test('login --wait continues the login started by --no-wait', async () => {
    writeCfg(twoServers());
    writeFileSync(join(home, '.cubby', 'launcher-pending-login.json'), JSON.stringify({ url: ACME }));
    const { d, calls } = deps();
    const p = await L.plan(['login', '--wait', '--json'], d);
    assert.deepEqual(calls.fetch, [ACME]);
    assert.equal(p.version, '0.1.5');
  });
  test('login without a URL targets the current server', async () => {
    writeCfg(twoServers());
    const { d, calls } = deps();
    await L.plan(['login', '--token', 'x'], d);
    assert.deepEqual(calls.fetch, [PRIYA]);
  });
});

describe('plan: what the matched CLI gets', () => {
  test('the same environment, pinned to the server the launcher resolved, and marked so it never dispatches again', async () => {
    writeCfg(twoServers());
    const { d } = deps({ env: { HOME: home, PATH: '/bin', CUBBY_TOKEN: 'hk_ci' } });
    const p = await L.plan(['deploy', '--server', 'cubby.acme.com', '-m', 'x'], d);
    assert.deepEqual(p.args, ['deploy', '--server', 'cubby.acme.com', '-m', 'x'], 'arguments are passed through as they are');
    assert.deepEqual([p.env.HOME, p.env.PATH, p.env.CUBBY_TOKEN], [home, '/bin', 'hk_ci']);
    assert.deepEqual([p.env.CUBBY_SERVER, p.env.CUBBY_LAUNCHED], [ACME, '1']);
  });
  test('local commands run in the bundled CLI without network', async () => {
    writeCfg(twoServers());
    const { d, calls } = deps();
    for (const argv of [['servers'], ['use', 'priya.dev'], ['logout', '--all'], ['skill', 'status'], [], ['--help'], ['bogus']]) {
      assert.equal((await L.plan(argv, d)).run, 'bundled', argv.join(' '));
    }
    assert.equal(calls.fetch.length, 0);
  });
  test('inside a launched child, never dispatch again', async () => {
    writeCfg(twoServers());
    const { d, calls } = deps({ env: { CUBBY_LAUNCHED: '1' } });
    assert.equal((await L.plan(['deploy'], d)).run, 'bundled');
    assert.equal(calls.fetch.length, 0);
  });
});

describe('plan: a config written by a newer launcher', () => {
  const newer = { format: 9, default: 'cubby.acme.com', servers: { 'cubby.acme.com': server(ACME, { token: 'hk_acme' }) } };
  test('config-writing commands are refused with one clear update line', async () => {
    writeCfg(newer);
    for (const argv of [['login', ACME], ['signup', ACME]]) {
      const p = await L.plan(argv, deps().d);
      assert.equal(p.run, 'refuse');
      assert.match(p.message, /written by a newer Cubby CLI\. Update this one first: npm i -g https:\/\/cubby\.acme\.com\/cli\.tgz/);
    }
    assert.equal((await L.plan(['use', 'x'], deps().d)).run, 'bundled', 'local writers: the bundled CLI refuses the write itself');
  });
  test('app commands still resolve their server from the readable fields, and the file is left alone', async () => {
    writeCfg(newer);
    const before = readFileSync(join(home, '.cubby', 'config.json'), 'utf8');
    const p = await L.plan(['deploy'], deps().d);
    assert.equal(p.version, '0.1.5');
    assert.equal(p.env.CUBBY_SERVER, ACME);
    assert.equal(readFileSync(join(home, '.cubby', 'config.json'), 'utf8'), before, 'no version cache written');
  });
});

describe('plan: servers older than the minimum are refused', () => {
  const old = (version) => deps({ fetchVersion: async () => version });
  test('a server below 0.1.1 gets one clear line, for app and account commands alike', async () => {
    writeCfg(twoServers({ name: 'Acme Cubby' }));
    for (const argv of [['deploy', '--server', 'cubby.acme.com'], ['whoami', '--server', 'cubby.acme.com'], ['help', '--server', 'cubby.acme.com']]) {
      const p = await L.plan(argv, old('0.1.0').d);
      assert.equal(p.run, 'refuse', argv[0]);
      assert.equal(p.message, 'Acme Cubby runs Cubby 0.1.0, older than 0.1.1, the oldest this CLI supports. Ask its admin to upgrade (sudo cubby-server upgrade).');
    }
    const login = await L.plan(['login', 'https://new.dev'], old('0.0.9').d);
    assert.match(login.message, /^https:\/\/new\.dev runs Cubby 0\.0\.9/);
  });
  test('an unrecognized version is refused too, and nothing is downloaded', async () => {
    writeCfg(twoServers());
    const { d, calls } = deps({ fetchVersion: async () => 'banana' });
    const p = await L.plan(['deploy', '--server', 'cubby.acme.com'], d);
    assert.equal(p.run, 'refuse');
    assert.match(p.message, /reports an unrecognized Cubby version \("banana"\)/);
    assert.equal(calls.download.length, 0);
  });
  test('the minimum itself, dev builds of it, and the launcher\'s own version are fine', async () => {
    writeCfg(twoServers());
    for (const v of ['0.1.1', '0.1.1-dev+abc1234', '1.0.0']) {
      writeCfg(twoServers()); // no cached version, so each run asks the server
      assert.equal((await L.plan(['deploy', '--server', 'cubby.acme.com'], old(v).d)).run, 'cached', v);
    }
    writeCfg(twoServers());
    const same = await L.plan(['deploy', '--server', 'cubby.acme.com'], deps({ fetchVersion: async () => '0.0.1', bundledVersion: '0.0.1' }).d);
    assert.equal(same.run, 'bundled', 'a server on the launcher\'s own version is the same code');
  });
});

describe('plan: versions, caching and fallbacks', () => {
  test('an unresolvable server falls through to the bundled CLI (which reports it)', async () => {
    assert.equal((await L.plan(['deploy'], deps().d)).run, 'bundled');
  });
  test('same version as bundled: bundled, and the version is cached in config', async () => {
    writeCfg(twoServers());
    const { d, calls } = deps();
    assert.equal((await L.plan(['deploy'], d)).run, 'bundled');
    assert.deepEqual(calls.fetch, [PRIYA]);
    assert.deepEqual([readCfg().servers['priya.dev'].version, readCfg().servers['priya.dev'].version_checked_at], ['0.2.0', NOW]);
  });
  test('a fresh cached version skips the network', async () => {
    writeCfg(twoServers({ version: '0.1.5', version_checked_at: NOW - 1000 }));
    await L.installCli({ home, url: 'u', download: () => cliTgz('0.1.5'), nodeModules });
    const { d, calls } = deps();
    const p = await L.plan(['deploy', '--server', 'cubby.acme.com'], d);
    assert.equal(p.run, 'cached');
    assert.equal(calls.fetch.length + calls.download.length, 0);
  });
  test('a different version downloads that server\'s CLI once', async () => {
    writeCfg(twoServers());
    const { d, calls } = deps();
    const p = await L.plan(['deploy', '--server', 'cubby.acme.com', '-m', 'x'], d);
    assert.equal(p.entry, L.cliEntry(home, '0.1.5'));
    assert.deepEqual(calls.download, [`${ACME}/cli.tgz`]);
    assert.equal(p.skillSrc, join(L.cliPackage(home, '0.1.5'), 'skill', 'cubby'));
    await L.plan(['deploys', '--server', 'cubby.acme.com'], d);
    assert.equal(calls.download.length, 1);
  });
  test('a URL you are not logged in to still dispatches, without a token', async () => {
    const p = await L.plan(['projects', '--server', 'https://new.dev'], deps().d);
    assert.equal(p.run, 'cached');
    assert.equal(p.env.CUBBY_TOKEN, undefined);
  });
  test('offline with a cached CLI for the last known version: uses it, with a note', async () => {
    writeCfg(twoServers({ version: '0.1.5', version_checked_at: NOW - L.VERSION_TTL_MS * 2 }));
    await L.installCli({ home, url: 'u', download: () => cliTgz('0.1.5'), nodeModules });
    const { d } = deps({ fetchVersion: async () => { throw new Error('ECONNREFUSED'); } });
    const p = await L.plan(['deploy', '--server', 'Cubby.Acme.com'], d);
    assert.equal(p.run, 'cached');
    assert.match(p.notes[0], /can't reach https:\/\/cubby\.acme\.com; using the cached CLI for its last known version 0\.1\.5/);
  });
  test('offline with no known version: bundled, silently', async () => {
    writeCfg(twoServers());
    const p = await L.plan(['deploy', '--server', 'cubby.acme.com'], deps({ fetchVersion: async () => { throw new Error('down'); } }).d);
    assert.deepEqual([p.run, p.notes], ['bundled', []]);
  });
  test('offline, known version, nothing cached and the download fails too: bundled with notes', async () => {
    writeCfg(twoServers({ version: '0.1.5' }));
    const { d } = deps({ fetchVersion: async () => { throw new Error('down'); }, download: async () => { throw new Error('down'); } });
    const p = await L.plan(['deploy', '--server', 'cubby.acme.com'], d);
    assert.equal(p.run, 'bundled');
    assert.match(p.notes[1], /couldn't fetch the CLI for https:\/\/cubby\.acme\.com \(v0\.1\.5\): down; using the bundled v0\.2\.0/);
  });
});

describe('skill refresh: forward only', () => {
  const skillSrc = (version) => {
    const dir = mkdtempSync(join(tmpdir(), 'cubby-skill-src-'));
    writeFileSync(join(dir, 'SKILL.md'), `# Cubby\n\n**Skill version: x**\n\nbody ${version}\n`);
    return dir;
  };
  const installed = () => skillStatus(home);
  const install = (version) => L.refreshSkill({ home, version, src: skillSrc(version) });

  test('does nothing when the skill isn\'t installed', () => {
    assert.equal(L.refreshSkill({ home, version: '0.3.0', src: skillSrc('0.3.0') }), null);
    assert.equal(installed().installed, false);
  });
  test('upgrades from a newer CLI, never downgrades, ignores the same version', async () => {
    const { installSkill } = await import('../../cli/src/lib.js');
    installSkill({ home, src: skillSrc('0.2.0'), version: '0.2.0' });
    assert.equal(install('0.1.5'), null, 'older: kept');
    assert.equal(installed().version, '0.2.0');
    assert.equal(install('0.2.0-dev+abc1234'), null, 'same release base: kept');
    assert.equal(install('0.3.0').version, '0.3.0');
    assert.equal(installed().version, '0.3.0');
    assert.match(readFileSync(join(installed().path, 'SKILL.md'), 'utf8'), /body 0\.3\.0/);
  });
  test('the bundled skill ships with the launcher', () => {
    assert.ok(existsSync(join(L.BUNDLED_SKILL, 'SKILL.md')));
  });
});

describe('versionReport', () => {
  test('reports the CLI that runs for the target server (its version), the launcher and the server', async () => {
    writeCfg(twoServers());
    writeFileSync(join(cwd, 'cubby.json'), JSON.stringify({ format: 1, project: 'p', server: ACME }));
    const r = await L.versionReport(['version'], { home, cwd, env: {}, fetchInfo: async (u) => ({ name: 'Acme Cubby', version: VERSIONS[u] }), bundledVersion: '0.2.0' });
    assert.deepEqual(r, { cli: '0.1.5', launcher: '0.2.0', server: ACME, server_name: 'Acme Cubby', server_version: '0.1.5' });
  });
  test('unreachable: falls back to the last known version, then the bundled one', async () => {
    writeCfg(twoServers({ version: '0.1.5', name: 'Acme' }));
    const down = async () => { throw new Error('down'); };
    const a = await L.versionReport(['version', '--server', 'cubby.acme.com'], { home, cwd, env: {}, fetchInfo: down, bundledVersion: '0.2.0' });
    assert.deepEqual([a.cli, a.server_version, a.server_name], ['0.1.5', null, 'Acme']);
    const b = await L.versionReport(['version'], { home, cwd, env: {}, fetchInfo: down, bundledVersion: '0.2.0' });
    assert.equal(b.cli, '0.2.0');
  });
  test('no servers at all', async () => {
    const r = await L.versionReport(['version'], { home, cwd, env: {}, fetchInfo: async () => ({}), bundledVersion: '0.2.0' });
    assert.deepEqual(r, { cli: '0.2.0', launcher: '0.2.0', server: null, server_name: null, server_version: null });
  });
});
