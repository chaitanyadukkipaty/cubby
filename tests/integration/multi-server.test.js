// Several servers on different versions: skill.sh registers them, the launcher picks the matching CLI per server,
// and every app stays pinned to its own server.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, ROOT } from '../helpers/server.js';
import { api, signup } from '../helpers/integration.js';

const LAUNCHER = join(ROOT, 'cli/src/launcher.js');
const BUNDLED = JSON.parse(readFileSync(join(ROOT, 'cli/package.json'), 'utf8')).version;
let alpha, beta, home, work, tokenA, tokenB;

function cubby(args, { cwd = work, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LAUNCHER, ...args], { cwd, env: { ...process.env, HOME: home, CUBBY_TOKEN: '', CUBBY_SERVER: '', CUBBY_CLIENT: '', ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch { return null; } })() }));
  });
}
const ok = (r) => { assert.equal(r.code, 0, `exit ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`); return r; };
const config = () => JSON.parse(readFileSync(join(home, '.cubby/config.json'), 'utf8'));
const idOf = (srv) => `localhost:${srv.port}`;

before(async () => {
  [alpha, beta] = await Promise.all([
    startServer({ CUBBY_SERVER_NAME: 'Alpha Cubby' }),
    startServer({ CUBBY_SERVER_NAME: 'Beta Cubby', CUBBY_VERSION_OVERRIDE: '0.1.2' }),
  ]);
  home = mkdtempSync(join(tmpdir(), 'cubby-multi-home-'));
  work = mkdtempSync(join(tmpdir(), 'cubby-multi-work-'));
  mkdirSync(join(home, '.claude'));
  [tokenA, tokenB] = await Promise.all([signup(alpha.url, 'me@alpha.dev'), signup(beta.url, 'me@beta.dev')]);
});
after(async () => {
  await Promise.all([alpha?.stop(), beta?.stop()]);
  for (const d of [home, work]) if (d) rmSync(d, { recursive: true, force: true });
});

describe('several servers on different versions', () => {
  test('each server\'s skill.sh adds it to config.json by name; the first one stays the default', async () => {
    for (const srv of [alpha, beta]) {
      const script = await (await fetch(`${srv.url}/skill.sh`)).text();
      const r = spawnSync('sh', ['-c', script], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /added this server to ~\/\.cubby\/config\.json/);
    }
    const cfg = config();
    assert.equal(cfg.default, idOf(alpha));
    assert.deepEqual(cfg.servers[idOf(beta)], { name: 'Beta Cubby', email: null, token: null, version: null, url: beta.url });
    const list = ok(await cubby(['servers', '--json'])).json;
    assert.deepEqual(list.map((s) => [s.name, s.logged_in, s.default]), [['Alpha Cubby', false, true], ['Beta Cubby', false, false]]);
  });

  test('logging in to both keeps both; names work for --server and `use`', async () => {
    ok(await cubby(['login', alpha.url, '--token', tokenA, '--no-skill']));
    ok(await cubby(['login', beta.url, '--token', tokenB, '--no-skill']));
    assert.deepEqual(ok(await cubby(['servers', '--json'])).json.map((s) => s.logged_in), [true, true]);
    assert.equal(ok(await cubby(['whoami', '--server', 'beta cubby', '--json'])).json.email, 'me@beta.dev');
    assert.equal(ok(await cubby(['whoami', '--json'])).json.email, 'me@alpha.dev', 'default is still Alpha');
    ok(await cubby(['use', 'Beta Cubby']));
    assert.equal(ok(await cubby(['whoami', '--json'])).json.email, 'me@beta.dev');
    ok(await cubby(['use', alpha.url]));
    const bad = await cubby(['whoami', '--server', 'Gamma']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /No server called "Gamma"\. Known servers: Alpha Cubby .*Beta Cubby/);
  });

  test('a server on another version gets its own CLI, downloaded once into ~/.cubby/cli/<version>', async () => {
    ok(await cubby(['init', 'app-a', '--server', 'Alpha Cubby', '--no-install']));
    const b = ok(await cubby(['init', 'app-b', '--server', 'Beta Cubby', '--no-install', '--json']));
    assert.equal(b.json.server, beta.url);
    assert.ok(existsSync(join(home, '.cubby/cli/0.1.2/package/src/index.js')), "Beta's CLI was cached");
    assert.ok(!existsSync(join(home, '.cubby/cli', BUNDLED)), 'the bundled version is never downloaded');
    assert.deepEqual(JSON.parse(readFileSync(join(work, 'app-b/cubby.json'), 'utf8')), { format: 1, project: 'app-b', server: beta.url });

    const va = ok(await cubby(['version', '--json'], { cwd: join(work, 'app-a') })).json;
    const vb = ok(await cubby(['version', '--json'], { cwd: join(work, 'app-b') })).json;
    assert.deepEqual([va.cli, va.server_version, va.server_name], [BUNDLED, BUNDLED, 'Alpha Cubby']);
    assert.deepEqual([vb.cli, vb.server_version, vb.server_name], ['0.1.2', '0.1.2', 'Beta Cubby']);
    assert.equal(config().servers[idOf(beta)].version, '0.1.2', 'version cached in config');
  });

  test('deploys go to the server each app is pinned to, whatever the default', async () => {
    for (const app of ['app-a', 'app-b']) {
      mkdirSync(join(work, app, 'dist'), { recursive: true });
      writeFileSync(join(work, app, 'dist/index.html'), `<h1>${app}</h1>`);
      const r = ok(await cubby(['deploy', '--no-build', '-m', app, '--json'], { cwd: join(work, app) }));
      assert.match(r.json.server_name, app === 'app-a' ? /Alpha/ : /Beta/);
    }
    const slugs = async (srv, token) => (await api(srv.url, token)('GET', '/api/projects')).data.map((p) => p.slug);
    assert.deepEqual(await slugs(alpha, tokenA), ['app-a']);
    assert.deepEqual(await slugs(beta, tokenB), ['app-b']);
    // An explicit --server wins over cubby.json: listing Beta's apps from inside app-a.
    assert.match(ok(await cubby(['projects', '--server', 'Beta Cubby'], { cwd: join(work, 'app-a') })).stdout, /app-b/);
  });

  test('every command, account ones included, runs the CLI matching the server it talks to', async () => {
    const helpVersion = async (args, cwd = work) => ok(await cubby(['help', '--json', ...args], { cwd })).json.version;
    // In an app folder: that app's server (cubby.json), for every command.
    assert.equal(await helpVersion([], join(work, 'app-b')), '0.1.2');
    assert.equal(await helpVersion([], join(work, 'app-a')), BUNDLED);
    assert.equal(ok(await cubby(['whoami', '--json'], { cwd: join(work, 'app-b') })).json.email, 'me@beta.dev');
    // Outside an app folder: the named server, else the default.
    assert.equal(await helpVersion(['--server', 'Beta Cubby']), '0.1.2');
    assert.equal(await helpVersion([]), BUNDLED, 'default is Alpha');
    // help lists commands and flags, from the same table as /docs.md.
    const h = ok(await cubby(['help', 'deploy', '--json'], { cwd: join(work, 'app-b') })).json;
    assert.equal(h.command.name, 'deploy');
    assert.match(await (await fetch(`${beta.url}/docs.md`)).text(), /\| `cubby deploy \[-m <message>\]/);
  });

  test('logging in to the older server through its own CLI stores a correct entry', async () => {
    ok(await cubby(['login', beta.url, '--token', tokenB, '--no-skill', '--json']));
    const entry = config().servers[idOf(beta)];
    assert.deepEqual([entry.url, entry.email, entry.token, entry.name, entry.version], [beta.url, 'me@beta.dev', tokenB, 'Beta Cubby', '0.1.2']);
    assert.equal(config().default, idOf(alpha), 'the default stays');
    assert.deepEqual(Object.keys(config().servers).sort(), [idOf(alpha), idOf(beta)].sort());
  });

  test('the skill only moves forward: an older server\'s CLI never downgrades it', async () => {
    const skillVersion = () => readFileSync(join(home, '.agents/skills/cubby/SKILL.md'), 'utf8').match(/Skill version: ([^*]+)\*\*/)[1];
    // The first test ran Alpha's skill.sh, then Beta's (0.1.2): the newest won.
    assert.equal(skillVersion(), '0.1.2');
    assert.match(ok(await cubby(['skill', 'install'])).stdout, /Kept the installed cubby skill 0\.1\.2/, 'the older bundled CLI keeps it');
    ok(await cubby(['whoami'], { cwd: join(work, 'app-a') })); // runs the older bundled CLI
    assert.equal(skillVersion(), '0.1.2');
    const again = spawnSync('sh', ['-c', await (await fetch(`${alpha.url}/skill.sh`)).text()], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.match(again.stdout, /Kept your newer cubby skill \(v0\.1\.2\)/, "an older server's skill.sh never downgrades it");
    assert.equal(skillVersion(), '0.1.2');
    const gamma = await startServer({ CUBBY_SERVER_NAME: 'Gamma Cubby', CUBBY_VERSION_OVERRIDE: '9.9.9' });
    try {
      ok(await cubby(['help', '--server', gamma.url])); // runs the 9.9.9 CLI: refreshes the skill forward
      assert.equal(skillVersion(), '9.9.9');
      ok(await cubby(['whoami'], { cwd: join(work, 'app-b') }));
      assert.equal(skillVersion(), '9.9.9', 'still 9.9.9 after running an older CLI');
    } finally {
      await gamma.stop();
    }
  });

  test('a server older than the minimum (0.1.1) is refused with one clear line, before anything is downloaded', async () => {
    // The bundled CLI here may itself be 0.1.0 until the release bump, so the old server reports 0.0.9.
    const old = await startServer({ CUBBY_SERVER_NAME: 'Old Cubby', CUBBY_VERSION_OVERRIDE: '0.0.9' });
    try {
      for (const args of [['whoami', '--server', old.url], ['login', old.url, '--token', 'hk_x'], ['projects', '--server', old.url]]) {
        const r = await cubby(args);
        assert.equal(r.code, 1, args[0]);
        assert.match(r.stderr, /runs Cubby 0\.0\.9, older than 0\.1\.1, the oldest this CLI supports\. Ask its admin to upgrade \(sudo cubby-server upgrade\)\./);
      }
      assert.ok(!existsSync(join(home, '.cubby/cli/0.0.9')), 'its CLI is never downloaded');
      assert.ok(!(idOf(old) in config().servers), 'and no login is stored');
    } finally {
      await old.stop();
    }
  });

  test('when a server is unreachable, its last known CLI version is used with a note', async () => {
    const cfg = config();
    cfg.servers[idOf(beta)].version_checked_at = 0; // stale, so the launcher has to ask the server
    writeFileSync(join(home, '.cubby/config.json'), JSON.stringify(cfg));
    await beta.stop();
    const r = await cubby(['deploys'], { cwd: join(work, 'app-b') });
    assert.match(r.stderr, /can't reach http:\/\/localhost:\d+; using the cached CLI for its last known version 0\.1\.2/);
    const v = ok(await cubby(['version', '--json'], { cwd: join(work, 'app-b') })).json;
    assert.equal(v.cli, '0.1.2');
    assert.equal(v.server_version, null);
  });

  test('skill.sh migrates an old single-server config and leaves a newer format alone', async () => {
    const script = await (await fetch(`${alpha.url}/skill.sh`)).text();
    const runIn = (h) => spawnSync('sh', ['-c', script], { env: { ...process.env, HOME: h }, encoding: 'utf8' });
    const legacy = mkdtempSync(join(tmpdir(), 'cubby-legacy-'));
    const newer = mkdtempSync(join(tmpdir(), 'cubby-newer-'));
    try {
      mkdirSync(join(legacy, '.cubby'));
      writeFileSync(join(legacy, '.cubby/config.json'), JSON.stringify({ server: 'https://Old.Example.com/', token: 'hk_old', email: 'o@x.co' }));
      assert.equal(runIn(legacy).status, 0);
      const cfg = JSON.parse(readFileSync(join(legacy, '.cubby/config.json'), 'utf8'));
      assert.equal(cfg.default, 'old.example.com', 'the old server stays the default');
      assert.deepEqual(cfg.servers['old.example.com'], { name: null, url: 'https://old.example.com', email: 'o@x.co', token: 'hk_old', version: null });
      assert.equal(cfg.servers[idOf(alpha)].name, 'Alpha Cubby');

      mkdirSync(join(newer, '.cubby'));
      const future = JSON.stringify({ format: 2, whatever: true });
      writeFileSync(join(newer, '.cubby/config.json'), future);
      const r = runIn(newer);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /written by a newer Cubby CLI/);
      assert.equal(readFileSync(join(newer, '.cubby/config.json'), 'utf8'), future, 'untouched');
    } finally {
      for (const d of [legacy, newer]) rmSync(d, { recursive: true, force: true });
    }
  });

  test('logout --server forgets one server; the other keeps working', async () => {
    assert.match(ok(await cubby(['logout', '--server', 'Beta Cubby'])).stdout, /Logged out of Beta Cubby/);
    assert.deepEqual(ok(await cubby(['servers', '--json'])).json.map((s) => s.name), ['Alpha Cubby']);
    assert.equal(ok(await cubby(['whoami', '--json'])).json.email, 'me@alpha.dev');
    const r = await cubby(['info'], { cwd: join(work, 'app-b') });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /This app lives on http:\/\/localhost:\d+ \(cubby\.json\), and you're not logged in there/);
  });
});
