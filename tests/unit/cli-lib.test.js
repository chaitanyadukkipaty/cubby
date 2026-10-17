import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync, readlinkSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as lib from '../../cli/src/lib.js';

const SKILL_SRC = new URL('../../cli/skill/cubby/', import.meta.url).pathname;
const TEMPLATE = new URL('../../cli/template/', import.meta.url).pathname;

describe('agent login hint', () => {
  test('detectTool names the agent from its environment, else Terminal', () => {
    assert.equal(lib.detectTool({ CLAUDECODE: '1' }), 'Claude Code');
    assert.equal(lib.detectTool({ CODEX_SANDBOX: 'seatbelt' }), 'Codex');
    assert.equal(lib.detectTool({ CURSOR_TRACE_ID: 'x' }), 'Cursor');
    assert.equal(lib.detectTool({ CLAUDECODE: '1', CURSOR_TRACE_ID: 'x' }), 'Claude Code', 'an agent running inside an editor wins');
    assert.equal(lib.detectTool({ CLAUDECODE: '' }), 'Terminal');
    assert.equal(lib.detectTool({}), 'Terminal');
  });
  test('loginHint sends the tool (--client / CUBBY_CLIENT win over detection) and the short hostname', () => {
    assert.deepEqual(lib.loginHint({ env: { CLAUDECODE: '1' }, hostname: 'chaitanya-mbp.local' }), { tool: 'Claude Code', machine: 'chaitanya-mbp' });
    assert.deepEqual(lib.loginHint({ client: 'my-bot', env: { CLAUDECODE: '1' }, hostname: 'box' }), { tool: 'my-bot', machine: 'box' });
    assert.deepEqual(lib.loginHint({ env: { CUBBY_CLIENT: 'ci' }, hostname: 'runner.LOCAL' }), { tool: 'ci', machine: 'runner' });
  });
});

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
  test('formatAgents lists id, name, tool, machine, created date and last seen, and marks this agent', () => {
    const now = Date.parse('2026-10-17T12:00:00Z');
    const t = lib.formatAgents([
      { id: 'k0', name: 'Manual token', tool: null, machine: null, created: '2026-10-01 10:00:00.000Z', last_used_at: '2026-10-15 09:00:00.000Z', current: false },
      { id: 'a1', name: 'Claude Code · mbp', tool: 'Claude Code', machine: 'mbp', created: '2026-10-17 09:00:00.000Z', last_used_at: '2026-10-17 11:59:30.000Z', current: true },
      { id: 'a2', name: 'Codex', tool: 'Codex', machine: null, created: '2026-10-17 09:00:00.000Z', last_used_at: null, current: false },
    ], now);
    const w = 'Claude Code · mbp'.length + 2;
    assert.equal(t, [
      `  ${'ID'.padEnd(4)}${'NAME'.padEnd(w)}${'TOOL'.padEnd(13)}${'MACHINE'.padEnd(9)}${'CREATED'.padEnd(12)}LAST SEEN`,
      `  ${'k0'.padEnd(4)}${'Manual token'.padEnd(w)}${'-'.padEnd(13)}${'-'.padEnd(9)}${'2026-10-01'.padEnd(12)}2 days ago`,
      `* ${'a1'.padEnd(4)}${'Claude Code · mbp'.padEnd(w)}${'Claude Code'.padEnd(13)}${'mbp'.padEnd(9)}${'2026-10-17'.padEnd(12)}just now`,
      `  ${'a2'.padEnd(4)}${'Codex'.padEnd(w)}${'Codex'.padEnd(13)}${'-'.padEnd(9)}${'2026-10-17'.padEnd(12)}never`,
      '* = this agent. Rename one with `cubby agents rename <id> <name>`, revoke it with `cubby agents revoke <id> --yes`.',
    ].join('\n'));
    assert.equal(lib.formatAgents([]), 'No agents yet. Connect one with `cubby login <server-url>`.');
  });
  test('lastSeen says how long ago a key was used, in rough units', () => {
    const now = Date.parse('2026-10-17T12:00:00Z');
    const at = (ms) => new Date(now - ms).toISOString();
    assert.equal(lib.lastSeen(null, now), 'never');
    assert.equal(lib.lastSeen(at(59_000), now), 'just now');
    assert.equal(lib.lastSeen(at(60_000), now), '1 min ago');
    assert.equal(lib.lastSeen(at(59 * 60_000), now), '59 min ago');
    assert.equal(lib.lastSeen(at(60 * 60_000), now), '1 hour ago');
    assert.equal(lib.lastSeen(at(5 * 3600_000), now), '5 hours ago');
    assert.equal(lib.lastSeen(at(24 * 3600_000), now), '1 day ago');
    assert.equal(lib.lastSeen(at(40 * 24 * 3600_000), now), '40 days ago');
    assert.equal(lib.lastSeen(at(-5000), now), 'just now', 'a server clock slightly ahead');
    assert.equal(lib.lastSeen('garbage', now), 'never');
  });

  test('formatActivity shows when, which app, who (agent or dashboard) and what, newest first as given', () => {
    const rows = [
      { at: '2026-10-17 09:30:12.000Z', app: 'todo', via: 'agent', agent: { id: 'k1', name: 'Claude Code · mbp' }, user: 'a@x.dev', summary: 'Deployed d2 (3 files)' },
      { at: '2026-10-16 08:00:00.000Z', app: null, via: 'dashboard', agent: null, user: 'a@x.dev', summary: 'Disabled user b@x.dev' },
    ];
    assert.equal(lib.formatActivity(rows), [
      '2026-10-17 09:30  todo  Claude Code · mbp  Deployed d2 (3 files)',
      '2026-10-16 08:00  -     dashboard          Disabled user b@x.dev',
    ].join('\n'));
    assert.equal(lib.formatActivity(rows, { users: true }).split('\n')[0], '2026-10-17 09:30  a@x.dev  todo  Claude Code · mbp  Deployed d2 (3 files)');
    assert.equal(lib.formatActivity([]), 'No activity in the last 30 days');
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

describe('jobs and env helpers', () => {
  test('jobEntries: one job per top-level file; _helpers and .d.ts are not jobs', () => {
    assert.deepEqual(lib.jobEntries(['weekly-digest.ts', 'ping.mjs', '_shared.ts', 'types.d.ts', 'README.md', 'b.js', 'c.mts']),
      { 'b': 'b.js', 'c': 'c.mts', ping: 'ping.mjs', 'weekly-digest': 'weekly-digest.ts' });
    assert.deepEqual(lib.jobEntries([]), {});
  });
  test('jobEntries rejects bad names and two files for one job', () => {
    try {
      lib.jobEntries(['Daily.ts', 'two--dashes.ts', 'a.ts', 'a.js', `${'x'.repeat(41)}.ts`]);
      assert.fail('should throw');
    } catch (err) {
      assert.equal(err.message, 'Invalid jobs');
      assert.equal(err.details.length, 4);
      assert.match(err.details.join('\n'), /cubby\/jobs\/Daily\.ts: job file names/);
      assert.match(err.details.join('\n'), /cubby\/jobs\/a\.ts: another file is already job "a"/);
    }
  });
  test('jobSchedule reads `export const schedule` with any quote style', () => {
    assert.equal(lib.jobSchedule("import x from 'y';\nexport const schedule = '0 9 * * 1';\n", 'f'), '0 9 * * 1');
    assert.equal(lib.jobSchedule('export const schedule="*/5 * * * *"', 'f'), '*/5 * * * *');
    assert.equal(lib.jobSchedule('export  const  schedule = ` 0 0 * * * `;', 'f'), '0 0 * * *');
    assert.throws(() => lib.jobSchedule('const schedule = "x"', 'cubby/jobs/a.ts'), /cubby\/jobs\/a\.ts: add `export const schedule/);
  });
  test('jobsBuildScript bundles every entry as ESM with its dependencies', () => {
    const s = lib.jobsBuildScript({ a: '/app/cubby/jobs/a.ts' }, '/app/dist/__cubby_jobs');
    assert.match(s, /import \{ build \} from 'vite'/);
    assert.match(s, /noExternal: true/);
    assert.match(s, /"a":"\/app\/cubby\/jobs\/a\.ts"/);
    assert.match(s, /outDir: "\/app\/dist\/__cubby_jobs"/);
    assert.match(s, /entryFileNames: '\[name\]\.mjs'/);
  });
  test('formatJobs', () => {
    const text = lib.formatJobs([
      { name: 'digest', schedule: '0 9 * * 1', paused: false, next_run: '2026-10-19T09:00:00.000Z', last_run: { status: 'ok', started: 'S', duration_ms: 1500 } },
      { name: 'ping', schedule: '* * * * *', paused: true, next_run: null, last_run: { status: 'error', started: 'T', duration_ms: 20 } },
      { name: 'never', schedule: '0 0 30 2 *', paused: false, next_run: null, last_run: null },
      { name: 'odd', schedule: '* * * * *', paused: false, next_run: null, last_run: { status: 'skipped', started: 'U', duration_ms: null } },
    ]);
    assert.match(text, /digest\s+0 9 \* \* 1\s+next: 2026-10-19T09:00:00.000Z  last: ok S \(1\.5s\)/);
    assert.match(text, /ping\s+\* \* \* \* \*\s+paused  last: error T \(20ms\)/);
    assert.match(text, /never.*next: never  never run/);
    assert.match(text, /odd.*last: skipped U \(\)/);
    assert.match(lib.formatJobs([]), /No jobs\. Add one in cubby\/jobs/);
  });
  test('formatRun and formatEnv', () => {
    assert.equal(lib.formatRun({ job: 'a', id: 'r1', status: 'ok', trigger: 'manual', started: 'S', duration_ms: 5, log: 'hi\n' }), 'a r1  ok  manual  S  5ms\nhi');
    assert.match(lib.formatRun({ job: 'a', id: 'r1', status: 'skipped', trigger: 'cron', started: 'S', duration_ms: 0, log: '' }), /\(no output\)$/);
    assert.match(lib.formatRun({ job: 'a', id: 'r1', status: 'ok', trigger: 'cron', started: 'S', duration_ms: 0 }), /\(no output\)$/);
    assert.match(lib.formatEnv([{ key: 'API_KEY', updated: 'U' }]), /^API_KEY\s+set U$/);
    assert.match(lib.formatEnv([]), /No secrets/);
  });
  test('formatMetrics: totals for the range, live and API numbers, accounts, then each UTC day', () => {
    const text = lib.formatMetrics({
      app: 'polls', range: '24h', views: 1234, visitors: 3,
      active_now: 2, peak_active: 7, api_requests: 1500, api_errors: 3, api_error_rate: 0.002,
      days: [{ start: '2026-10-16T00:00:00.000Z', views: 4, visitors: 1 }, { start: '2026-10-17T00:00:00.000Z', views: 1230, visitors: 2 }],
      accounts: { total: 42, new: 5, days: [{ start: '2026-10-16T00:00:00.000Z', signups: 1 }, { start: '2026-10-17T00:00:00.000Z', signups: 4 }] },
    });
    assert.equal(text, [
      'polls: 1234 views, 3 visitors in the last 24h',
      '  Active now 2, peak 7',
      '  API: 1500 requests, 3 errors (0.2%)',
      '  Accounts: 42, 5 new',
      '  2026-10-16      4 views     1 visitors     1 signups',
      '  2026-10-17   1230 views     2 visitors     4 signups',
    ].join('\n'));
  });
  test('formatMetricsList: one line per app', () => {
    const text = lib.formatMetricsList([
      { app: 'polls', range: '7d', views: 12, visitors: 5, active_now: 1, api_errors: 2 },
      { app: 'a-much-longer-app-name', range: '7d', views: 0, visitors: 0, active_now: 0, api_errors: 0 },
    ]);
    assert.match(text, /^Last 7d\n/);
    assert.match(text, /\n {2}polls\s+12 views\s+5 visitors\s+1 active\s+2 API errors\n/);
    assert.match(text, /a-much-longer-app-name\s+0 views\s+0 visitors\s+0 active\s+0 API errors$/);
    assert.match(lib.formatMetricsList([]), /No apps yet/);
  });
  test('parseEnvAssignment splits at the first =', () => {
    assert.deepEqual(lib.parseEnvAssignment('API_KEY=a=b'), { key: 'API_KEY', value: 'a=b' });
    assert.deepEqual(lib.parseEnvAssignment('EMPTY='), { key: 'EMPTY', value: '' });
    for (const bad of ['NOVALUE', '=x', undefined]) assert.throws(() => lib.parseEnvAssignment(bad), /Usage: cubby env set/, String(bad));
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
  test('never downgrades: an older CLI keeps the newer installed skill', () => {
    lib.installSkill(opts());
    const r = lib.installSkill({ home, src: SKILL_SRC, version: '1.0.0' });
    assert.deepEqual([r.kept, r.version], [true, '9.8.7']);
    assert.equal(lib.skillStatus(home).version, '9.8.7');
    assert.equal(lib.installSkill({ home, src: SKILL_SRC, version: '9.9.0' }).version, '9.9.0', 'newer replaces it');
  });
  test('isNewerVersion compares X.Y.Z only; junk is never newer', () => {
    assert.equal(lib.isNewerVersion('0.1.10', '0.1.9'), true);
    assert.equal(lib.isNewerVersion('v1.0.0', '0.9.9-dev+abc'), true);
    assert.equal(lib.isNewerVersion('0.1.1-dev+abc', '0.1.1'), false);
    assert.equal(lib.isNewerVersion('0.1.1', 'junk'), true);
    assert.equal(lib.isNewerVersion('junk', '0.0.1'), false);
    assert.deepEqual(lib.versionCore('0.2.3-dev+x'), [0, 2, 3]);
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

describe('admin output', () => {
  test('formatBytes uses binary units with one decimal above bytes', () => {
    assert.equal(lib.formatBytes(0), '0 B');
    assert.equal(lib.formatBytes(1023), '1023 B');
    assert.equal(lib.formatBytes(1536), '1.5 KB');
    assert.equal(lib.formatBytes(5 * 1024 ** 3), '5.0 GB');
    assert.equal(lib.formatBytes(null), '-');
  });
  test('formatStorage shows each category, the disk, and apps biggest first', () => {
    const text = lib.formatStorage({
      computed_at: '2026-10-17T09:00:00.000Z',
      disk: { total_bytes: 10 * 1024 ** 3, free_bytes: 4 * 1024 ** 3 },
      data_bytes: 3 * 1024 ** 2,
      breakdown: { database_bytes: 1024 ** 2, uploads_bytes: 0, sites_current_bytes: 512 * 1024, sites_older_bytes: 512 * 1024, backups_bytes: 1024 ** 2, other_bytes: 0 },
      apps: [{ slug: 'blog', owner: 'a@x.dev', total_bytes: 2048, current_deploy_bytes: 1024, older_deploys_bytes: 1024, uploads_bytes: 0 }],
    });
    assert.match(text, /Database\s+1\.0 MB/);
    assert.match(text, /Current deploys\s+512\.0 KB/);
    assert.match(text, /Older deploys \(rollback\)\s+512\.0 KB/);
    assert.match(text, /Backups\s+1\.0 MB/);
    assert.match(text, /Total\s+3\.0 MB/);
    assert.match(text, /Disk: 4\.0 GB free of 10\.0 GB/);
    assert.match(text, /blog\s+2\.0 KB\s+current 1\.0 KB · older 1\.0 KB · uploads 0 B\s+a@x\.dev/);
    assert.match(text, /as of 2026-10-17T09:00:00\.000Z/);
  });
  test('formatStorage says when there are no apps, and leaves out a missing owner', () => {
    const base = { computed_at: 'now', disk: { total_bytes: 1, free_bytes: 1 }, data_bytes: 0, breakdown: {} };
    assert.match(lib.formatStorage({ ...base, apps: [] }), /No apps yet$/);
    const line = lib.formatStorage({ ...base, apps: [{ slug: 'orphan', owner: null, total_bytes: 0, current_deploy_bytes: 0, older_deploys_bytes: 0, uploads_bytes: 0 }] }).split('\n').at(-1);
    assert.match(line, /uploads 0 B$/);
  });
  test('formatBackups lists pairs by date, flags half pairs, and shows a running or failed backup', () => {
    const text = lib.formatBackups({
      keep: 7,
      running: { date: '2026-10-17', started_at: '2026-10-17T09:00:00.000Z' },
      last: { date: '2026-10-16', ok: false, error: 'disk full' },
      backups: [
        { date: '2026-10-16', db_bytes: 2048, sites_bytes: 1024, total_bytes: 3072, complete: true },
        { date: '2026-10-15', db_bytes: 2048, sites_bytes: null, total_bytes: 2048, complete: false },
      ],
    });
    assert.match(text, /2026-10-16\s+database 2\.0 KB\s+sites 1\.0 KB\s+total 3\.0 KB/);
    assert.match(text, /2026-10-15\s+database 2\.0 KB\s+sites -\s+total 2\.0 KB\s+\(incomplete\)/);
    assert.match(text, /A backup is running \(started 2026-10-17T09:00:00\.000Z\)/);
    assert.match(text, /The last backup failed: disk full/);
    assert.match(text, /sudo cubby-server restore <date>/);
    assert.match(lib.formatBackups({ keep: 7, running: null, last: null, backups: [] }), /^No backups yet/);
    assert.doesNotMatch(lib.formatBackups({ keep: 7, running: null, last: { ok: true, error: null }, backups: [] }), /failed|running/);
  });
  test('formatRetention says what a keep count deletes and frees, or roughly how much more it takes', () => {
    assert.equal(lib.formatRetention({ keep: 1, backups: 3, delete: ['2026-10-02', '2026-10-01'], frees_bytes: 2048, adds_bytes: 0 }),
      'the next nightly backup deletes 2 (2026-10-02, 2026-10-01), freeing 2.0 KB');
    assert.equal(lib.formatRetention({ keep: 9, backups: 3, delete: [], frees_bytes: 0, adds_bytes: 6144 }),
      'nothing is deleted; 6 more nightly backups take about 6.0 KB');
    assert.equal(lib.formatRetention({ keep: 3, backups: 3, delete: [], frees_bytes: 0, adds_bytes: 0 }), 'nothing is deleted');
  });
});
