// CLI ↔ server: the `cubby` command run as a real process against a real server.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, ROOT, SIGNUP_CODE } from '../helpers/server.js';
import { api, signup } from '../helpers/integration.js';

// The real entry point: the launcher (same version as the server here, so it runs the bundled CLI in-process).
const CLI = join(ROOT, 'cli/src/launcher.js');
let srv, home, work, token;

function cubby(args, { cwd = work, env = {}, home: h = home, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, HOME: h, CUBBY_TOKEN: '', CUBBY_SERVER: '', CUBBY_CLIENT: '', ...env } });
    child.stdin.end(input ?? '');
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch { return null; } })() }));
  });
}
const ok = (r) => { assert.equal(r.code, 0, `exit ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`); return r; };

before(async () => {
  srv = await startServer();
  home = mkdtempSync(join(tmpdir(), 'cubby-cli-home-'));
  work = mkdtempSync(join(tmpdir(), 'cubby-cli-work-'));
  mkdirSync(join(home, '.claude'));
  token = await signup(srv.url, 'cli@test.dev');
});
after(async () => {
  await srv?.stop();
  for (const d of [home, work]) if (d) rmSync(d, { recursive: true, force: true });
});

describe('basics', () => {
  test('help and unknown commands', async () => {
    const h = await cubby(['--help']);
    assert.equal(h.code, 0);
    assert.match(h.stdout, /^cubby \S+: build and host apps/);
    assert.equal((await cubby(['frobnicate'])).code, 1);
  });
  test('help --json lists every command for the version that runs', async () => {
    const h = ok(await cubby(['help', '--json', '--server', srv.url])).json;
    const pkg = JSON.parse(readFileSync(join(ROOT, 'cli/package.json'), 'utf8'));
    assert.equal(h.version, pkg.version);
    assert.ok(h.commands.some((c) => c.name === 'deploy'));
    assert.equal(ok(await cubby(['help', 'rollback', '--json', '--server', srv.url])).json.command.name, 'rollback');
    assert.match((await cubby(['help', 'nope', '--server', srv.url])).stderr, /No command "nope"/);
  });
  test('the CLI\'s own version command (what a matched CLI answers when launched)', async () => {
    const r = ok(await cubby(['version', '--json'], { env: { CUBBY_LAUNCHED: '1', CUBBY_SERVER: srv.url } })).json;
    assert.equal(r.server, srv.url);
    assert.equal(r.server_version, r.cli);
  });
  test('a config written by a newer CLI is never rewritten: logins are refused with an update hint', async () => {
    const h = mkdtempSync(join(tmpdir(), 'cubby-newer-'));
    mkdirSync(join(h, '.cubby'));
    const future = JSON.stringify({ format: 9, default: 'x', servers: { x: { url: srv.url, token: 'hk_x' } } });
    writeFileSync(join(h, '.cubby/config.json'), future);
    const r = await cubby(['login', srv.url, '--token', token], { home: h });
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`written by a newer Cubby CLI\\. Update this one first: npm i -g ${srv.url}/cli\\.tgz`));
    const use = await cubby(['use', 'x'], { home: h });
    assert.equal(use.code, 1);
    assert.match(use.stderr, /newer Cubby CLI \(format 9\)/);
    assert.equal(readFileSync(join(h, '.cubby/config.json'), 'utf8'), future);
    rmSync(h, { recursive: true, force: true });
  });
  test('commands that need a login say how to log in', async () => {
    const r = await cubby(['whoami']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Not logged in\. Run `cubby login/);
    const j = await cubby(['projects', '--json']);
    assert.match(j.json.error, /Not logged in/);
  });
  test('unreachable servers produce a readable error', async () => {
    const r = await cubby(['whoami'], { env: { CUBBY_TOKEN: 'hk_x', CUBBY_SERVER: 'http://127.0.0.1:1' } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Cannot reach http:\/\/127\.0\.0\.1:1/);
  });
});

describe('login', () => {
  test('--token saves the session and installs the skill for detected agents', async () => {
    const r = ok(await cubby(['login', srv.url, '--token', token, '--json']));
    assert.equal(r.json.status, 'logged_in');
    assert.deepEqual(r.json.skill.agents, ['claude-code']);
    const cfg = JSON.parse(readFileSync(join(home, '.cubby/config.json'), 'utf8'));
    const id = `localhost:${srv.port}`;
    assert.equal(cfg.format, 1);
    assert.equal(cfg.default, id);
    const { version_checked_at, ...saved } = cfg.servers[id];
    assert.deepEqual(saved, { name: "admin's Cubby", url: srv.url, email: 'cli@test.dev', token, version: r.json.skill.version });
    assert.ok(version_checked_at > 0);
    assert.ok(lstatSync(join(home, '.claude/skills/cubby')).isSymbolicLink());
    assert.doesNotMatch(readFileSync(join(home, '.agents/skills/cubby/SKILL.md'), 'utf8'), /\{\{/);
    assert.deepEqual(ok(await cubby(['whoami', '--json'])).json, { email: 'cli@test.dev', is_admin: false, server: srv.url, server_name: "admin's Cubby" });
    assert.ok(ok(await cubby(['whoami'])).stdout.includes(`cli@test.dev @ admin's Cubby (${srv.url})`));
    const st = ok(await cubby(['skill', 'status', '--json'])).json;
    assert.equal(st.installed, true);
  });
  test('browser approval: --no-wait prints the link, --wait finishes after approval', async () => {
    const h2 = mkdtempSync(join(tmpdir(), 'cubby-cli-home2-'));
    try {
      const start = ok(await cubby(['login', srv.url, '--no-wait', '--json', '--no-skill'], { home: h2 })).json;
      assert.equal(start.status, 'approval_required');
      assert.match(start.verify_url, /\/connect\?code=/);
      assert.ok(existsSync(join(h2, '.cubby/pending-login.json')));
      const waiting = cubby(['login', '--wait', '--json', '--no-skill'], { home: h2 });
      await new Promise((r) => setTimeout(r, 500));
      assert.equal((await api(srv.url, token)('POST', '/api/device/approve', { body: { code: start.user_code } })).status, 200);
      const done = await waiting;
      ok(done);
      assert.equal(done.json.email, 'cli@test.dev');
      assert.ok(!existsSync(join(h2, '.cubby/pending-login.json')), 'pending login cleaned up');
      assert.equal(JSON.parse(readFileSync(join(h2, '.cubby/config.json'), 'utf8')).servers[`localhost:${srv.port}`].token, token);
    } finally {
      rmSync(h2, { recursive: true, force: true });
    }
  });
  test('--wait without a pending login explains what to do', async () => {
    const r = await cubby(['login', '--wait'], { home: mkdtempSync(join(tmpdir(), 'cubby-h3-')) });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No login in progress/);
  });
  test('signup and email/password login commands', async () => {
    const h4 = mkdtempSync(join(tmpdir(), 'cubby-h4-'));
    try {
      ok(await cubby(['signup', srv.url, '--email', 'new@test.dev', '--password', 'password1234', '--code', SIGNUP_CODE], { home: h4 }));
      const l = ok(await cubby(['login', srv.url, '--email', 'new@test.dev', '--password', 'password1234', '--no-skill', '--json'], { home: h4 }));
      assert.equal(l.json.email, 'new@test.dev');
      assert.match(ok(await cubby(['logout'], { home: h4 })).stdout, /Logged out of admin's Cubby/);
      assert.deepEqual(ok(await cubby(['servers', '--json'], { home: h4 })).json, []);
      assert.equal((await cubby(['logout'], { home: h4 })).code, 1, 'nothing left to log out of');
      ok(await cubby(['login', srv.url, '--email', 'new@test.dev', '--password', 'password1234', '--no-skill'], { home: h4 }));
      assert.match(ok(await cubby(['logout', '--all'], { home: h4 })).stdout, /Logged out of every server/);
      assert.ok(!existsSync(join(h4, '.cubby/config.json')));
    } finally {
      rmSync(h4, { recursive: true, force: true });
    }
  });
});

describe('app lifecycle', () => {
  const dir = () => join(work, 'cli-app');
  const inApp = (args, opts = {}) => cubby(args, { cwd: dir(), ...opts });

  test('init scaffolds the template and creates the project', async () => {
    const r = ok(await cubby(['init', 'cli-app', '--no-install', '--json']));
    assert.equal(r.json.prefix, 'cli_app__');
    assert.deepEqual(JSON.parse(readFileSync(join(dir(), 'cubby.json'), 'utf8')), { format: 1, project: 'cli-app', server: srv.url });
    assert.match(readFileSync(join(dir(), 'AGENTS.md'), 'utf8'), /cli_app__/);
    assert.ok(existsSync(join(dir(), '.gitignore')));
    const again = await cubby(['init', 'cli-app', '--no-install']);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /is not empty/);
  });
  test('deploy pushes the schema first, and only when it changed', async () => {
    mkdirSync(join(dir(), 'dist'));
    writeFileSync(join(dir(), 'dist/index.html'), '<h1>one</h1>');
    const pkg = JSON.parse(readFileSync(join(dir(), 'package.json'), 'utf8'));
    writeFileSync(join(dir(), 'package.json'), JSON.stringify({ ...pkg, description: 'CLI test app' }));
    const first = ok(await inApp(['deploy', '--no-build', '-m', 'one', '--client', 'test-agent']));
    assert.match(first.stdout, /Schema applied\. created: users, tasks/);
    assert.match(first.stdout, /Deployed \w+ to admin's Cubby \(http:\/\/localhost:\d+\) \(1 files/);
    const second = ok(await inApp(['deploy', '--no-build', '-m', 'two', '--unlisted']));
    assert.doesNotMatch(second.stdout, /Schema applied/);
    const info = ok(await inApp(['info', '--json'])).json;
    assert.equal(info.unlisted, true);
    assert.equal(info.description, 'CLI test app');
    const deploys = ok(await inApp(['deploys'])).stdout.trim().split('\n');
    assert.equal(deploys.length, 2);
    assert.match(deploys[0], /^\* .*two$/);
    assert.match(deploys[1], /\[test-agent\] one$/);
  });
  test('rollback', async () => {
    const list = ok(await inApp(['deploys', '--json'])).json;
    const one = list.find((d) => d.message === 'one');
    ok(await inApp(['rollback', one.id]));
    assert.equal(ok(await inApp(['info', '--json'])).json.current_deploy, one.id);
    assert.equal((await inApp(['rollback'])).code, 1);
  });
  test('schema pull / push / drop', async () => {
    const schemaFile = join(dir(), 'cubby/schema.json');
    const s = JSON.parse(readFileSync(schemaFile, 'utf8'));
    s.collections.find((c) => c.name === 'tasks').fields.push({ name: 'color', type: 'text' });
    writeFileSync(schemaFile, JSON.stringify(s, null, 2));
    assert.match(ok(await inApp(['schema', 'push'])).stdout, /updated: users, tasks/);
    const guard = await inApp(['schema', 'drop', 'tasks.color']);
    assert.equal(guard.code, 1);
    assert.match(guard.stderr, /Re-run with --yes/);
    assert.match(ok(await inApp(['schema', 'drop', 'tasks.color', '--yes'])).stdout, /Dropped tasks\.color/);
    ok(await inApp(['schema', 'pull', '--file', 'pulled.json']));
    const pulled = JSON.parse(readFileSync(join(dir(), 'pulled.json'), 'utf8'));
    assert.ok(!pulled.collections.find((c) => c.name === 'tasks').fields.some((f) => f.name === 'color'));
    writeFileSync(join(dir(), 'broken.json'), '{nope');
    const bad = await inApp(['schema', 'push', '--file', 'broken.json']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /broken\.json/);
    assert.equal((await inApp(['schema', 'frob'])).code, 1);
  });
  test('link and projects, and commands outside an app folder', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'cubby-link-'));
    try {
      const outside = await cubby(['info'], { cwd: elsewhere });
      assert.equal(outside.code, 1);
      assert.match(outside.stderr, /No cubby\.json here/);
      ok(await cubby(['link', 'cli-app'], { cwd: elsewhere }));
      assert.equal(ok(await cubby(['info', '--json'], { cwd: elsewhere })).json.slug, 'cli-app');
      assert.match(ok(await cubby(['projects'])).stdout, /cli-app/);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
  test('cubby.json pins the app to its server: an unknown server is reported, never silently replaced', async () => {
    const pinned = JSON.parse(readFileSync(join(dir(), 'cubby.json'), 'utf8'));
    writeFileSync(join(dir(), 'cubby.json'), JSON.stringify({ project: 'cli-app', server: 'http://old-server.invalid' }));
    const r = await inApp(['info']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /This app lives on http:\/\/old-server\.invalid .*cubby login.*cubby link cli-app --server/);
    assert.equal(JSON.parse(readFileSync(join(dir(), 'cubby.json'), 'utf8')).server, 'http://old-server.invalid', 'not rewritten');
    // The fix the message suggests: re-link to the server it lives on now.
    ok(await inApp(['link', 'cli-app', '--server', srv.url]));
    assert.deepEqual(JSON.parse(readFileSync(join(dir(), 'cubby.json'), 'utf8')), pinned);
    assert.match(ok(await inApp(['info'])).stdout, /server: {2}admin's Cubby/);
  });
  test('delete needs --yes', async () => {
    const guard = await cubby(['delete', 'cli-app']);
    assert.equal(guard.code, 1);
    assert.match(guard.stderr, /Re-run with --yes/);
    ok(await cubby(['delete', 'cli-app', '--yes']));
    assert.match(ok(await cubby(['projects'])).stdout, /No projects yet/);
  });
  test('server errors are shown with details', async () => {
    const r = await cubby(['init', 'Bad_Name', '--no-install', '--dir', join(work, 'bad')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /error: App name must be 3-40 chars/);
  });
});

describe('more commands', () => {
  test('skill install / remove / bad subcommand', async () => {
    const r = ok(await cubby(['skill', 'install']));
    assert.match(r.stdout, /Installed cubby skill [\s\S]* linked for: claude-code/);
    assert.match(ok(await cubby(['skill', 'remove'])).stdout, /Removed cubby skill \(unlinked from claude-code\)/);
    assert.match(ok(await cubby(['skill'])).stdout, /not installed \(run: cubby skill install\)/);
    assert.equal((await cubby(['skill', 'frob'])).code, 1);
  });
  test('blocking login prints the link on stderr and completes after approval', async () => {
    const h5 = mkdtempSync(join(tmpdir(), 'cubby-h5-'));
    try {
      const child = spawn(process.execPath, [CLI, 'login', srv.url, '--no-skill'], { env: { ...process.env, HOME: h5, CUBBY_TOKEN: '' } });
      let stderr = '', stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      const code = await new Promise((resolve) => {
        child.stderr.on('data', async (d) => {
          stderr += d;
          const m = stderr.match(/code: (\S+)/);
          if (m && !child.approved) {
            child.approved = true;
            await api(srv.url, token)('POST', '/api/device/approve', { body: { code: m[1] } });
          }
        });
        child.on('close', resolve);
      });
      assert.equal(code, 0, stderr);
      assert.match(stderr, /Open this link to approve/);
      assert.match(stderr, /Waiting for approval/);
      assert.match(stdout, /Logged in as cli@test\.dev/);
    } finally {
      rmSync(h5, { recursive: true, force: true });
    }
  });
  test('deploy runs `npm run build` and stops if the build fails', async () => {
    const d = join(work, 'build-app');
    ok(await cubby(['init', 'build-app', '--no-install', '--dir', d]));
    rmSync(join(d, 'cubby'), { recursive: true, force: true }); // no schema file: skip the schema step
    const pkg = (build) => writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'build-app', scripts: { build } }));
    pkg(`node -e "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.html','built')"`);
    assert.match(ok(await cubby(['deploy', '--json'], { cwd: d })).json.url, /build-app/);
    pkg('node -e "process.exit(3)"');
    const failed = await cubby(['deploy'], { cwd: d });
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /`npm run build` failed/);
    rmSync(join(d, 'dist'), { recursive: true, force: true });
    const missing = await cubby(['deploy', '--no-build'], { cwd: d });
    assert.match(missing.stderr, /index\.html not found/);
  });
  test('warns once when the server runs a different version', async () => {
    const http = await import('node:http');
    const fake = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-cubby-version': '99.0.0' });
      res.end(JSON.stringify(req.url === '/api/me' ? { email: 'x@y.z', is_admin: false } : []));
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${fake.address().port}`;
    try {
      const r = ok(await cubby(['whoami'], { env: { CUBBY_TOKEN: 'hk_fake', CUBBY_SERVER: url } }));
      assert.equal(r.stderr.match(/warning: CLI \S+ differs from server 99\.0\.0/g).length, 1);
      assert.match(r.stderr, new RegExp(`npm i -g ${url}/cli\\.tgz`));
    } finally {
      fake.close();
    }
  });
});

describe('jobs and secrets', () => {
  const d = () => join(work, 'job-app');
  const inApp = (args, opts = {}) => cubby(args, { cwd: d(), ...opts });
  const job = (name, code) => writeFileSync(join(d(), 'cubby/jobs', name), code);

  before(async () => {
    ok(await cubby(['init', 'job-app', '--no-install', '--dir', d()]));
    rmSync(join(d(), 'cubby/schema.json'));
    writeFileSync(join(d(), 'package.json'), JSON.stringify({ name: 'job-app', type: 'module', scripts: {
      build: `node -e "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.html','built')"`,
    } }));
    // A stand-in for the app's Vite: "bundles" each job by copying it, so this test needs no npm install.
    mkdirSync(join(d(), 'node_modules/vite'), { recursive: true });
    writeFileSync(join(d(), 'node_modules/vite/package.json'), JSON.stringify({ name: 'vite', type: 'module', main: 'index.js' }));
    writeFileSync(join(d(), 'node_modules/vite/index.js'), `import { mkdirSync, copyFileSync } from 'node:fs';
export async function build({ build: { outDir, rollupOptions: { input } } }) {
  mkdirSync(outDir, { recursive: true });
  for (const [name, file] of Object.entries(input)) copyFileSync(file, outDir + '/' + name + '.mjs');
}`);
    mkdirSync(join(d(), 'cubby/jobs'), { recursive: true }); // the template ships cubby/jobs/_context.ts
  });

  test('secrets: set (inline or from stdin), list names, unset with --yes', async () => {
    assert.match(ok(await inApp(['env', 'set', 'TOKEN=abc=123'])).stdout, /Set TOKEN\. Jobs read it as env\.TOKEN/);
    assert.equal(ok(await inApp(['env', 'set', 'OTHER', '--from-stdin', '--json'], { input: 'from stdin\n' })).json.key, 'OTHER');
    assert.deepEqual(ok(await inApp(['env', '--json'])).json.map((e) => e.key), ['OTHER', 'TOKEN']);
    assert.match(ok(await inApp(['env', 'list'])).stdout, /^OTHER\s+set /);
    const guard = await inApp(['env', 'unset', 'OTHER']);
    assert.equal(guard.code, 1);
    assert.match(guard.stderr, /Re-run with --yes/);
    assert.match(ok(await inApp(['env', 'unset', 'OTHER', '--yes'])).stdout, /Removed OTHER/);
    for (const args of [['env', 'set', 'NOVALUE'], ['env', 'unset'], ['env', 'frob']]) assert.match((await inApp(args)).stderr, /Usage: cubby env/, args.join(' '));
    assert.match((await inApp(['env', 'set', 'lower=x'])).stderr, /capital letters/);
  });
  test('a folder with only helpers ships no jobs', async () => {
    job('_shared.js', 'export const x = 1;');
    const r = ok(await inApp(['deploy', '--json']));
    assert.deepEqual(r.json.jobs, []);
  });
  test('deploy bundles cubby/jobs; jobs lists, runs (exit 1 on failure), shows logs, pauses and resumes', async () => {
    job('hello.js', "export const schedule = '*/30 * * * *';\nexport default async ({ log, env }) => log('hi', env.TOKEN);\n");
    job('boom.js', 'export const schedule = "0 0 * * *";\nexport default async () => { throw new Error("kaboom"); };\n');
    assert.match(ok(await inApp(['deploy'])).stdout, /jobs: boom, hello \(see `cubby jobs`\)/);

    assert.match(ok(await inApp(['jobs'])).stdout, /hello\s+\*\/30 \* \* \* \*\s+next: \S+\s+never run/);
    assert.match(ok(await inApp(['jobs', 'logs', 'hello'])).stdout, /No runs of hello yet/);
    const run = ok(await inApp(['jobs', 'run', 'hello']));
    assert.match(run.stdout, /^hello \w+  ok  manual .*\nhi abc=123$/m);
    const failed = await inApp(['jobs', 'run', 'boom', '--json']);
    assert.equal(failed.code, 1);
    assert.equal(failed.json.status, 'error');
    assert.match(failed.json.log, /kaboom/);

    ok(await inApp(['jobs', 'run', 'hello']));
    const logs = ok(await inApp(['jobs', 'logs', 'hello', '--limit', '5', '--json'])).json;
    assert.equal(logs.length, 2);
    assert.equal(ok(await inApp(['jobs', 'logs', 'hello', '--run', logs[1].id, '--json'])).json[0].id, logs[1].id);
    assert.match(ok(await inApp(['jobs', 'logs', 'hello'])).stdout, /hi abc=123/);
    assert.match(ok(await inApp(['jobs', 'logs', 'boom', '--limit', '1'])).stdout, /kaboom/);

    assert.match(ok(await inApp(['jobs', 'pause', 'hello'])).stdout, /hello paused/);
    assert.equal(ok(await inApp(['jobs', 'list', '--json'])).json.find((j) => j.name === 'hello').paused, true);
    assert.match(ok(await inApp(['jobs', 'resume', 'hello'])).stdout, /hello resumed/);
    assert.match((await inApp(['jobs', 'frob'])).stderr, /Usage: cubby jobs \[run\|logs/);
    assert.match((await inApp(['jobs', 'run'])).stderr, /Usage: cubby jobs run <job>/);
    assert.match((await inApp(['jobs', 'run', 'nope'])).stderr, /No job "nope"/);
  });
  test('unknown runs, and jobs that are wrong are caught before upload', async () => {
    assert.match((await inApp(['jobs', 'logs', 'hello', '--run', 'x'])).stderr, /Run x not found/);
    job('Bad_Name.js', 'export default async () => {};');
    const badName = await inApp(['deploy']);
    assert.equal(badName.code, 1);
    assert.match(badName.stderr, /Invalid jobs\n  - cubby\/jobs\/Bad_Name\.js/);
    rmSync(join(d(), 'cubby/jobs/Bad_Name.js'));
    job('nosched.js', 'export default async () => {};');
    assert.match((await inApp(['deploy'])).stderr, /cubby\/jobs\/nosched\.js: add `export const schedule/);
    rmSync(join(d(), 'cubby/jobs/nosched.js'));
    job('bad-cron.js', "export const schedule = 'whenever';\nexport default async () => {};");
    const badCron = await inApp(['deploy']);
    assert.equal(badCron.code, 1);
    assert.match(badCron.stderr, /Job "bad-cron": schedule needs 5 fields/);
  });
});
