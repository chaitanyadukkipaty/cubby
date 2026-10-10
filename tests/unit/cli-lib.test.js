import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync, readlinkSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as lib from '../../cli/src/lib.js';

const SKILL_SRC = new URL('../../cli/skill/cubby/', import.meta.url).pathname;
const TEMPLATE = new URL('../../cli/template/', import.meta.url).pathname;

describe('normalizeServerArg', () => {
  test('keeps explicit schemes', () => { assert.equal(lib.normalizeServerArg('http://1-2-3-4.sslip.io'), 'http://1-2-3-4.sslip.io'); assert.equal(lib.normalizeServerArg('https://a.b'), 'https://a.b'); });
  test('defaults bare hosts to https', () => assert.equal(lib.normalizeServerArg('cubby.example.com'), 'https://cubby.example.com'));
});

describe('schema file helpers', () => {
  test('parseSchemaText returns the schema and a stable content hash', () => {
    const a = lib.parseSchemaText('{"collections":[]}', 'f');
    assert.deepEqual(a.schema, { collections: [] });
    assert.equal(a.hash, lib.sha256('{"collections":[]}'));
    assert.match(a.hash, /^[0-9a-f]{64}$/);
    assert.notEqual(lib.parseSchemaText('{"collections": []}', 'f').hash, a.hash, 'any edit changes the hash');
  });
  test('parseSchemaText names the file on invalid JSON', () => assert.throws(() => lib.parseSchemaText('{oops', 'cubby/schema.json'), (e) => e instanceof lib.CliError && /^cubby\/schema\.json: /.test(e.message)));
  test('describeSchemaChanges summarises created/updated', () => {
    assert.equal(lib.describeSchemaChanges({ created: ['a'], updated: ['b', 'c'], kept: [] }), 'Schema applied. created: a | updated: b, c');
    assert.equal(lib.describeSchemaChanges({ created: [], updated: [], kept: [] }), 'Schema applied. No changes.');
  });
  test('describeSchemaChanges explains kept data and how to delete it', () => {
    const t = lib.describeSchemaChanges({ created: [], updated: ['tasks'], kept: ['tasks.color'] });
    assert.match(t, /kept \(not in schema\.json, data preserved\): tasks\.color/);
    assert.match(t, /cubby schema drop <name> --yes/);
  });
});

describe('serverLabel', () => {
  test('shows the name with the URL', () => assert.equal(lib.serverLabel("Priya's Cubby", 'https://p.dev'), "Priya's Cubby (https://p.dev)"));
  test('falls back to the URL for servers without a name', () => assert.equal(lib.serverLabel(null, 'https://p.dev'), 'https://p.dev'));
});

describe('versionWarning', () => {
  test('silent when versions match or the server sent none', () => { assert.equal(lib.versionWarning('1.0.0', '1.0.0', 's'), null); assert.equal(lib.versionWarning('1.0.0', null, 's'), null); });
  test('tells you how to update from this server', () => assert.equal(lib.versionWarning('1.0.0', '1.1.0', 'https://s'), 'warning: CLI 1.0.0 differs from server 1.1.0. Update with: npm i -g https://s/cli.tgz'));
});

describe('deployParams', () => {
  test('maps flags to query params', () => {
    assert.equal(lib.deployParams({ message: 'v2 fix', unlisted: true, description: 'Polls' }).toString(), 'message=v2+fix&unlisted=1&description=Polls');
    assert.equal(lib.deployParams({ listed: true }).toString(), 'unlisted=0');
    assert.equal(lib.deployParams().toString(), '');
  });
});

describe('formatters', () => {
  test('formatDeploys marks the current deploy and the agent', () => {
    const t = lib.formatDeploys([
      { id: 'd2', created: 't2', files: 3, message: 'two', client: 'claude-code', current: true },
      { id: 'd1', created: 't1', files: 1, message: 'one', current: false },
    ]);
    assert.equal(t, '* d2  t2  3 files  [claude-code] two\n  d1  t1  1 files  one');
    assert.equal(lib.formatDeploys([]), 'No deploys');
  });
  test('formatProjects flags undeployed apps', () => {
    assert.equal(lib.formatProjects([{ slug: 'a', url: 'u1', current_deploy: 'd' }, { slug: 'b', url: 'u2' }]),
      `${'a'.padEnd(24)} u1\n${'b'.padEnd(24)} u2  (not deployed)`);
    assert.equal(lib.formatProjects([]), 'No projects yet');
  });
  test('formatError lists details', () => {
    assert.equal(lib.formatError(new lib.CliError('bad')), 'error: bad');
    assert.equal(lib.formatError(new lib.CliError('bad', ['x', 'y'])), 'error: bad\n  - x\n  - y');
    assert.equal(lib.formatError(new lib.CliError('bad', 'one')), 'error: bad\n  - one');
  });
});

describe('waitForApproval', () => {
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };
  test('returns the token once approved, polling at the interval', async () => {
    const c = clock();
    const responses = [{ status: 'pending' }, { status: 'pending' }, { status: 'approved', token: 'hk_ok' }];
    let polls = 0;
    const token = await lib.waitForApproval({ poll: async () => responses[polls++], expiresIn: 600, interval: 2, ...c });
    assert.equal(token, 'hk_ok');
    assert.equal(polls, 3);
    assert.equal(c.now(), 4000);
  });
  test('gives up with a clear error after expiry', async () => {
    const c = clock();
    let polls = 0;
    await assert.rejects(lib.waitForApproval({ poll: async () => (polls++, { status: 'pending' }), expiresIn: 10, interval: 2, ...c }), (e) => e instanceof lib.CliError && /expired/.test(e.message));
    assert.equal(polls, 5);
  });
  test('propagates poll errors (e.g. server says expired)', async () => {
    await assert.rejects(lib.waitForApproval({ poll: async () => { throw new lib.CliError('Login request expired'); }, expiresIn: 600, ...clock() }), /Login request expired/);
  });
});

describe('copyTemplate', () => {
  let dest;
  beforeEach(() => { dest = mkdtempSync(join(tmpdir(), 'cubby-tpl-')); });
  afterEach(() => rmSync(dest, { recursive: true, force: true }));
  test('fills {{VARS}}, keeps unknown placeholders, renames _gitignore', () => {
    const src = mkdtempSync(join(tmpdir(), 'cubby-src-'));
    mkdirSync(join(src, 'nested'));
    writeFileSync(join(src, 'a.txt'), 'app={{SLUG}} prefix={{PREFIX}} keep={{UNKNOWN}} style={{ x: 1 }}');
    writeFileSync(join(src, 'nested', 'b.txt'), '{{URL}}');
    writeFileSync(join(src, '_gitignore'), 'dist/');
    lib.copyTemplate(src, join(dest, 'out'), { SLUG: 'my-app', PREFIX: 'my_app__', URL: 'https://my-app.ex.com' });
    assert.equal(readFileSync(join(dest, 'out', 'a.txt'), 'utf8'), 'app=my-app prefix=my_app__ keep={{UNKNOWN}} style={{ x: 1 }}');
    assert.equal(readFileSync(join(dest, 'out', 'nested', 'b.txt'), 'utf8'), 'https://my-app.ex.com');
    assert.ok(existsSync(join(dest, 'out', '.gitignore')) && !existsSync(join(dest, 'out', '_gitignore')));
    rmSync(src, { recursive: true, force: true });
  });
  test('the real app template leaves no placeholders behind', () => {
    lib.copyTemplate(TEMPLATE, dest, { SLUG: 'demo-app', PREFIX: 'demo_app__', SERVER: 'https://s', URL: 'https://demo-app.s' });
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of walk(dest)) assert.doesNotMatch(readFileSync(f, 'utf8'), /\{\{[A-Z_]+\}\}/, f);
    assert.match(readFileSync(join(dest, 'package.json'), 'utf8'), /"name": "demo-app"/);
    assert.match(readFileSync(join(dest, 'AGENTS.md'), 'utf8'), /demo_app__/);
    for (const want of ['.gitignore', 'index.html', 'vite.config.ts', 'src/lib/pb.ts', 'cubby/schema.json', 'CLAUDE.md']) assert.ok(existsSync(join(dest, want)), want);
    JSON.parse(readFileSync(join(dest, 'cubby/schema.json'), 'utf8'));
  });
});

describe('agent skill install/remove/status', () => {
  let home;
  const opts = () => ({ home, src: SKILL_SRC, version: '9.8.7' });
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cubby-home-')); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test('status before install', () => {
    const s = lib.skillStatus(home);
    assert.equal(s.installed, false);
    assert.equal(s.version, null);
    assert.ok(s.links.every((l) => l.state === 'agent not installed'));
  });
  test('installs the canonical server-neutral copy with the version stamped, links only installed agents', () => {
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    const r = lib.installSkill(opts());
    assert.deepEqual(r.agents, ['claude-code', 'opencode']);
    const md = readFileSync(join(home, '.agents/skills/cubby/SKILL.md'), 'utf8');
    assert.match(md, /\*\*Skill version: 9\.8\.7\*\*/);
    assert.doesNotMatch(md, /\{\{/);
    assert.match(md, /cubby servers --json/, 'the skill finds servers through the CLI');
    const link = join(home, '.claude/skills/cubby');
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), r.path);
    assert.ok(!existsSync(join(home, '.codex')), 'does not create agents that are not installed');
    const s = lib.skillStatus(home);
    assert.equal(s.installed, true);
    assert.equal(s.version, '9.8.7');
    assert.deepEqual(Object.fromEntries(s.links.map((l) => [l.agent, l.state])), { 'claude-code': 'linked', codex: 'agent not installed', cursor: 'agent not installed', opencode: 'linked' });
  });
  test('reinstall is idempotent and replaces stale links, but leaves user-managed copies alone', () => {
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(home, '.codex', 'skills', 'cubby'), { recursive: true }); // someone's own copy
    symlinkSync('/nonexistent/old', join(home, '.claude', 'skills', 'cubby'));
    assert.equal(lib.skillStatus(home).links.find((l) => l.agent === 'claude-code').state, 'other link');
    assert.equal(lib.skillStatus(home).links.find((l) => l.agent === 'codex').state, 'separate copy');
    lib.installSkill(opts());
    const r = lib.installSkill(opts());
    assert.deepEqual(r.agents, ['claude-code']);
    assert.equal(lib.skillStatus(home).links.find((l) => l.agent === 'claude-code').state, 'linked');
    assert.ok(lstatSync(join(home, '.codex', 'skills', 'cubby')).isDirectory());
  });
  test('not-linked agents get linked on install', () => {
    mkdirSync(join(home, '.cursor'));
    assert.equal(lib.skillStatus(home).links.find((l) => l.agent === 'cursor').state, 'not linked');
    assert.deepEqual(lib.installSkill(opts()).agents, ['cursor']);
  });
  test('remove unlinks only our links and deletes the copy', () => {
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.codex', 'skills', 'cubby'), { recursive: true });
    lib.installSkill(opts());
    assert.deepEqual(lib.removeSkill(home), { removed: ['claude-code'] });
    assert.ok(!existsSync(join(home, '.agents/skills/cubby')));
    assert.ok(!existsSync(join(home, '.claude/skills/cubby')));
    assert.ok(existsSync(join(home, '.codex/skills/cubby')), 'user copy untouched');
    assert.deepEqual(lib.removeSkill(home), { removed: [] }, 'removing twice is harmless');
  });
  test('fails clearly when the skill files are missing from the install', () => {
    assert.throws(() => lib.installSkill({ ...opts(), src: join(home, 'nope') }), (e) => e instanceof lib.CliError && /Skill files missing/.test(e.message));
  });
});
