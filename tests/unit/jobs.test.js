import { test, describe, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// jobs.js reads DATA_DIR at import time.
const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'cubby-jobs-')));
process.env.DATA_DIR = dataDir;
const jobs = await import('../../server/src/jobs.js');
const { admin } = await import('../../server/src/pb.js');
const { updateSettings } = await import('../../server/src/settings.js');

after(() => rmSync(dataDir, { recursive: true, force: true }));

const writeJob = (slug, deploy, files) => {
  const dir = jobs.jobsDir(slug, deploy);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
};
const manifest = (list) => JSON.stringify({ format: 1, jobs: list });

// In-memory stand-in for the few PocketBase record calls jobs.js makes. Filters are ignored: tests keep tables small.
function fakeAdmin(tables) {
  let n = 0;
  const table = (name) => {
    const rows = (tables[name] ??= []);
    return {
      rows,
      async create(data) { const r = { id: `r${++n}`, ...data }; rows.push(r); return { ...r }; },
      async update(id, data) {
        const r = rows.find((x) => x.id === id);
        if (!r) throw Object.assign(new Error('not found'), { status: 404 });
        Object.assign(r, data);
        return { ...r };
      },
      async delete(id) { rows.splice(rows.findIndex((x) => x.id === id), 1); },
      async getOne(id) { const r = rows.find((x) => x.id === id); if (!r) throw new Error('404'); return { ...r }; },
      async getFullList() { return rows.map((r) => ({ ...r })); },
      async getList(page, perPage) { return { items: rows.slice((page - 1) * perPage, page * perPage).map((r) => ({ ...r })) }; },
    };
  };
  const orig = admin.collection;
  admin.collection = (name) => table(name);
  return { table, restore: () => { admin.collection = orig; } };
}

describe('checkManifest', () => {
  test('returns names and trimmed schedules', () => {
    assert.deepEqual(jobs.checkManifest({ format: 1, jobs: [{ name: 'daily', schedule: ' 0 9 * * * ' }] }, ['daily.mjs', 'jobs.json']), [{ name: 'daily', schedule: '0 9 * * *' }]);
  });
  test('rejects an unknown shape', () => {
    for (const bad of [null, {}, { format: 2, jobs: [] }, { format: 1, jobs: {} }]) assert.throws(() => jobs.checkManifest(bad, []), /Invalid __cubby_jobs\/jobs\.json/);
  });
  test('collects every problem', () => {
    const many = Array.from({ length: jobs.MAX_JOBS + 1 }, (_, i) => ({ name: `j${i}`, schedule: '* * * * *' }));
    const files = [...many.map((j) => `${j.name}.mjs`), 'a.mjs', 'evil.node', 'chunks/x.mjs'];
    try {
      jobs.checkManifest({ format: 1, jobs: [...many, { name: 'Bad_Name', schedule: '* * * * *' }, { name: 'a', schedule: 'nope' }, { name: 'a', schedule: '* * * * *' }, { name: 'gone', schedule: '* * * * *' }, null] }, files);
      assert.fail('should throw');
    } catch (err) {
      assert.equal(err.status, 400);
      const text = err.details.join('\n');
      assert.match(text, /at most 20 jobs/);
      assert.match(text, /Job name "Bad_Name"/);
      assert.match(text, /Job name ""/);
      assert.match(text, /Job "a": schedule needs 5 fields/);
      assert.match(text, /Job "a" is defined twice/);
      assert.match(text, /Job "gone": gone\.mjs is missing/);
      assert.match(text, /evil\.node: jobs may only contain/);
      assert.doesNotMatch(text, /chunks\/x\.mjs/);
    }
  });
});

describe('readJobsBundle / deployJobs', () => {
  test('null without a jobs folder', async () => assert.equal(await jobs.readJobsBundle(join(dataDir, 'nope')), null));
  test('reads nested files and validates the manifest', async () => {
    const dir = writeJob('bundle', 'd1', { 'jobs.json': manifest([{ name: 'a', schedule: '* * * * *' }]), 'a.mjs': '', 'chunks/c.mjs': '' });
    assert.deepEqual(await jobs.readJobsBundle(dir), [{ name: 'a', schedule: '* * * * *' }]);
  });
  test('broken jobs.json is a 400', async () => {
    const dir = writeJob('bundle', 'd2', { 'jobs.json': '{nope', 'a.mjs': '' });
    await assert.rejects(jobs.readJobsBundle(dir), (err) => err.status === 400 && /Invalid __cubby_jobs\/jobs\.json/.test(err.message));
  });
  test('deployJobs reads the current deploy once and caches it', async () => {
    assert.deepEqual(await jobs.deployJobs('cache', null), []);
    assert.deepEqual(await jobs.deployJobs('cache', 'missing'), []);
    writeJob('cache', 'd1', { 'jobs.json': manifest([{ name: 'x', schedule: '0 0 * * *', extra: 1 }]) });
    assert.deepEqual(await jobs.deployJobs('cache', 'd1'), [{ name: 'x', schedule: '0 0 * * *' }]);
    writeJob('cache', 'd1', { 'jobs.json': manifest([]) });
    assert.deepEqual(await jobs.deployJobs('cache', 'd1'), [{ name: 'x', schedule: '0 0 * * *' }], 'deploys are immutable');
  });
});

describe('jobRequestAllowed', () => {
  const index = async () => ({ ids: new Set(['pbc_own']) });
  const allowed = (method, path) => jobs.jobRequestAllowed('my-app', method, path, index);
  test("this app's records and their files", async () => {
    assert.equal(await allowed('GET', '/api/collections/my_app__tasks/records'), true);
    assert.equal(await allowed('PATCH', '/api/collections/my_app__tasks/records/abc123'), true);
    assert.equal(await allowed('GET', '/api/files/my_app__tasks/abc123/photo.png'), true);
    assert.equal(await allowed('GET', '/api/files/pbc_own/abc123/photo.png'), true);
  });
  test('nothing else', async () => {
    for (const [method, path] of [
      ['GET', '/api/collections/other__tasks/records'], ['GET', '/api/collections/users/records'], ['GET', '/api/collections/cubby_projects/records'],
      ['GET', '/api/collections/my_app__tasks'], ['DELETE', '/api/collections/my_app__tasks/truncate'], ['POST', '/api/collections/my_app__users/impersonate/x'],
      ['POST', '/api/collections/my_app__users/auth-with-password'], ['GET', '/api/collections/my_app__tasks/records/a/b'], ['GET', '/api/collections/my_app__tasks/records/a%2Fb'],
      ['POST', '/api/batch'], ['GET', '/api/collections'], ['GET', '/api/health'], ['GET', '/api/files/pbc_other/abc/x.png'], ['POST', '/api/files/my_app__tasks/abc/x.png'],
    ]) assert.equal(await allowed(method, path), false, `${method} ${path}`);
  });
});

describe('forwardJobRequest', () => {
  const index = async () => ({ ids: new Set() });
  const decode = (res) => JSON.parse(Buffer.from(res.body, 'base64').toString());
  const forward = (msg, send = async () => { throw new Error('should not be called'); }) => jobs.forwardJobRequest('my-app', msg, { send, index });

  test('bad requests are refused before anything is sent', async () => {
    for (const msg of [null, { method: 'PUT', path: '/x' }, { method: 'GET' }]) assert.equal((await forward(msg)).status, 400);
    assert.equal((await forward({ method: 'POST', path: '/api/collections/my_app__a/records', body: 'x'.repeat(40 * 1024 * 1024 + 1) })).status, 413);
  });
  test('other apps, platform collections and path tricks get 403 with a reason', async () => {
    const res = await forward({ method: 'GET', path: '/api/collections/users/records' });
    assert.equal(res.status, 403);
    assert.match(decode(res).message, /only reach this app's records \(collections starting with "my_app__"\)/);
    assert.equal((await forward({ method: 'GET', path: '/api/collections/my_app__a/records/../../../api/collections/users/records' })).status, 403);
  });
  test('@collection refs to other apps in the query are refused', async () => {
    const res = await forward({ method: 'GET', path: `/api/collections/my_app__a/records?filter=${encodeURIComponent('@collection.users.id != ""')}` });
    assert.equal(res.status, 403);
    assert.match(decode(res).message, /Cannot reference collection "users"/);
  });
  test("password hashes and token keys can't be filtered or sorted on (the job's requests run as superuser)", async () => {
    for (const q of [`filter=${encodeURIComponent('owner.password ~ "$2a"')}`, 'sort=-owner.tokenKey']) {
      const res = await forward({ method: 'GET', path: `/api/collections/my_app__a/records?${q}` });
      assert.equal(res.status, 403, q);
      assert.match(decode(res).message, /password hashes and token keys/);
    }
  });
  test('allowed requests go to PocketBase as superuser, body and type intact', async () => {
    const calls = [];
    admin.authStore.save('superuser-token', null);
    const res = await forward({ method: 'POST', path: '/api/collections/my_app__a/records?expand=x', contentType: 'application/json', body: Buffer.from('{"a":1}').toString('base64') }, async (url, init) => {
      calls.push({ url, init });
      return new Response('{"id":"r1"}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    admin.authStore.clear();
    assert.match(calls[0].url, /\/api\/collections\/my_app__a\/records\?expand=x$/);
    assert.equal(calls[0].init.headers.authorization, 'superuser-token');
    assert.equal(calls[0].init.headers['content-type'], 'application/json');
    assert.equal(calls[0].init.body.toString(), '{"a":1}');
    assert.deepEqual({ status: res.status, type: res.contentType, body: decode(res) }, { status: 200, type: 'application/json', body: { id: 'r1' } });
  });
  test('GETs carry no body or type; an unreachable PocketBase is a 502', async () => {
    let init;
    await forward({ method: 'GET', path: '/api/collections/my_app__a/records' }, async (url, i) => { init = i; return new Response(null, { status: 204 }); });
    assert.equal(init.body, undefined);
    assert.equal(init.headers['content-type'], undefined);
    assert.equal((await forward({ method: 'GET', path: '/api/collections/my_app__a/records' }, async () => { throw new Error('down'); })).status, 502);
  });
});

describe('runnerArgs / logTail', () => {
  test('permission model, read-only paths, memory cap, no writes', () => {
    const dir = writeJob('args', 'd1', { 'a.mjs': '' });
    const args = jobs.runnerArgs(dir);
    assert.match(args[0], /^--(experimental-)?permission$/);
    assert.ok(args.includes(`--allow-fs-read=${realpathSync(dir)}`));
    assert.ok(args.includes('--max-old-space-size=128'));
    assert.ok(args.at(-1).endsWith('job-runner.js'));
    assert.ok(!args.some((a) => a.startsWith('--allow-fs-write') || a.startsWith('--allow-child') || a.startsWith('--allow-worker')));
  });
  test('keeps the end of long output', () => {
    const short = jobs.logTail(10);
    short.push('hello');
    assert.equal(short.text(), 'hello');
    const long = jobs.logTail(10);
    long.push('0123456789abc');
    assert.equal(long.text(), '[earlier output cut]\n3456789abc');
    for (let i = 0; i < 5; i++) long.push('0123456789');
    assert.equal(long.text(), '[earlier output cut]\n0123456789');
  });
});

describe('runJob (real child processes)', () => {
  const run = (code, opts = {}) => {
    const dir = writeJob('run', `d${Math.random().toString(36).slice(2)}`, { 'job.mjs': code });
    return jobs.runJob({ dir, name: 'job', prefix: 'run__', timeoutMs: 10_000, onRequest: async () => ({ status: 200, contentType: 'application/json', body: Buffer.from('{"page":1,"items":[],"totalItems":3}').toString('base64') }), ...opts });
  };

  test('ok: output, env and an IPC PocketBase request with a prefixed name', async () => {
    const seen = [];
    const r = await run(`export default async ({ pb, env, log }) => {
      log('secret', env.TOKEN, 'process env keys', Object.keys(process.env).filter((k) => !k.startsWith('__CF') && k !== 'NODE_V8_COVERAGE').length);
      const list = await pb.collection('tasks').getList(1, 1);
      log('total', list.totalItems);
    };`, { env: { TOKEN: 't0k' }, onRequest: async (msg) => { seen.push(msg); return { status: 200, contentType: 'application/json', body: Buffer.from('{"page":1,"items":[],"totalItems":3}').toString('base64') }; } });
    assert.equal(r.status, 'ok', r.log);
    assert.match(r.log, /secret t0k process env keys 0/);
    assert.match(r.log, /total 3/);
    assert.match(seen[0].path, /^\/api\/collections\/run__tasks\/records\?/);
    assert.equal(typeof r.duration_ms, 'number');
  });
  test('a thrown error is a failed run with its stack', async () => {
    const r = await run(`export default async () => { console.error('about to fail'); throw new Error('boom'); };`);
    assert.equal(r.status, 'error');
    assert.match(r.log, /about to fail\nError: boom/);
  });
  test('a non-Error throw', async () => {
    const r = await run(`export default async () => { throw 'plain'; };`);
    assert.equal(r.status, 'error');
    assert.match(r.log, /plain/);
  });
  test('a module without a default function', async () => {
    const r = await run(`export const schedule = '* * * * *';`);
    assert.equal(r.status, 'error');
    assert.match(r.log, /must `export default async \(ctx\)/);
  });
  test('files outside the job and child processes are off limits', async () => {
    const r = await run(`import fs from 'node:fs';
      export default async ({ log }) => {
        try { fs.readFileSync(${JSON.stringify(join(dataDir, 'secret.txt'))}); log('read'); } catch (e) { log('read', e.code); }
        try { (await import('node:child_process')).execSync('id'); log('exec'); } catch (e) { log('exec', e.code); }
      };`);
    assert.equal(r.status, 'ok', r.log);
    assert.match(r.log, /read ERR_ACCESS_DENIED/);
    assert.match(r.log, /exec ERR_ACCESS_DENIED/);
  });
  test('loopback is unreachable from a job', async () => {
    const r = await run(`export default async ({ log, fetch }) => {
      try { await fetch('http://127.0.0.1:8090/api/health'); log('reached'); } catch (e) { log('fetch', e.cause?.message); }
    };`);
    assert.match(r.log, /fetch Jobs can only connect to public internet addresses \(blocked: 127\.0\.0\.1\)/);
  });
  test('a job that runs too long is killed', async () => {
    const r = await run(`export default () => new Promise(() => setInterval(() => {}, 1000));`, { timeoutMs: 800 });
    assert.equal(r.status, 'timeout');
    assert.match(r.log, /Stopped after 0\.8s/);
  });
  test('a job that kills its own process', async () => {
    const r = await run(`export default async () => { console.log('bye'); process.exit(3); };`);
    assert.equal(r.status, 'error');
    assert.match(r.log, /bye\nThe job process ended \(exit code 3\) before the job finished/);
  });
  test('a reply to a process that already ended is dropped', async () => {
    const r = await run(`export default async ({ pb }) => { pb.collection('a').getList(1, 1).catch(() => {}); setTimeout(() => process.exit(0), 50); await new Promise(() => {}); };`,
      { onRequest: () => new Promise((res) => setTimeout(() => res({ status: 200 }), 400)) });
    assert.equal(r.status, 'error');
    assert.match(r.log, /exit code 0/);
  });
});

describe('scheduleJobs', () => {
  test('acts once per wall-clock minute, never for the minute it started in', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      let clock = new Date('2026-10-13T09:00:30Z');
      const minutes = [];
      jobs.scheduleJobs({ now: () => clock, onMinute: async (m) => minutes.push(m.toISOString()) });
      mock.timers.tick(5_000);
      clock = new Date('2026-10-13T09:01:02Z');
      mock.timers.tick(5_000);
      mock.timers.tick(5_000);
      clock = new Date('2026-10-13T09:04:00Z'); // the server was busy: 09:02 and 09:03 are skipped, not caught up
      mock.timers.tick(5_000);
      assert.deepEqual(minutes, ['2026-10-13T09:01:00.000Z', '2026-10-13T09:04:00.000Z']);
    } finally {
      mock.timers.reset();
    }
  });
  test('a failing minute is logged, not thrown', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    const errors = mock.method(console, 'error', () => {});
    try {
      let clock = new Date('2026-10-13T09:00:00Z');
      jobs.scheduleJobs({ now: () => clock, onMinute: async () => { throw new Error('db down'); } });
      clock = new Date('2026-10-13T09:01:00Z');
      mock.timers.tick(5_000);
      await new Promise((r) => setImmediate(r));
      assert.match(errors.mock.calls[0].arguments.join(' '), /job scheduler: db down/);
    } finally {
      errors.mock.restore();
      mock.timers.reset();
    }
  });
});

describe('scheduler, queue and runs (PocketBase stubbed)', () => {
  let fake;
  before(() => {
    fake = fakeAdmin({ cubby_settings: [{ id: 's1', jobs_off: false, job_timeout_s: 10 }] });
  });
  after(() => fake.restore());

  const project = (slug, extra = {}) => ({ id: `p-${slug}`, slug, current_deploy: 'd1', expand: { owner: { disabled: false } }, ...extra });

  test('tick starts due, unpaused jobs of enabled owners; failures to start are logged', async () => {
    writeJob('ticky', 'd1', { 'jobs.json': manifest([{ name: 'due', schedule: '* * * * *' }, { name: 'held', schedule: '* * * * *' }, { name: 'later', schedule: '0 0 1 1 *' }]) });
    writeJob('banned', 'd1', { 'jobs.json': manifest([{ name: 'due', schedule: '* * * * *' }]) });
    fake.table('cubby_projects').rows.push(project('ticky', { jobs_paused: ['held'] }), project('banned', { expand: { owner: { disabled: true } } }), project('plain'));
    const errors = mock.method(console, 'error', () => {});
    const items = [];
    const started = await jobs.tick(new Date('2026-10-13T09:00:00Z'), { run: async (item) => { items.push(item); throw new Error('nope'); } });
    await new Promise((r) => setImmediate(r));
    errors.mock.restore();
    assert.deepEqual(started, ['ticky/due']);
    assert.equal(items[0].trigger, 'cron');
    assert.equal(items[0].deploy, 'd1');
    assert.match(errors.mock.calls[0].arguments.join(' '), /job ticky\/due: nope/);
  });
  test('tick does nothing while jobs are turned off', async () => {
    await updateSettings({ jobs_off: true });
    assert.deepEqual(await jobs.tick(new Date(), { run: async () => assert.fail('ran') }), []);
    await assert.rejects(jobs.runNow(project('ticky'), 'due'), /turned off/);
    await updateSettings({ jobs_off: false });
  });

  test('a run is recorded, executed in the sandbox and finished; a job never overlaps itself', async () => {
    writeJob('q', 'd1', { 'jobs.json': manifest([{ name: 'slow', schedule: '* * * * *' }]), 'slow.mjs': `export default async ({ log }) => { await new Promise((r) => setTimeout(r, 300)); log('done slow'); };` });
    const p = project('q');
    const job = { name: 'slow', schedule: '* * * * *' };
    const first = jobs.enqueue({ project: p, job, deploy: 'd1', trigger: 'manual' });
    await assert.rejects(jobs.enqueue({ project: p, job, deploy: 'd1', trigger: 'manual' }), (err) => err.status === 409);
    const skipped = await jobs.enqueue({ project: p, job, deploy: 'd1', trigger: 'cron' });
    assert.equal(skipped.status, 'skipped');
    const run = await first;
    assert.equal(run.status, 'ok', run.log);
    assert.match(run.log, /done slow/);
    assert.equal(run.trigger, 'manual');
    const rows = fake.table('cubby_job_runs').rows.filter((r) => r.project === p.id);
    assert.deepEqual(rows.map((r) => r.status).sort(), ['ok', 'skipped']);
  });
  test('more runs than the concurrency limit wait their turn', async () => {
    writeJob('many', 'd1', { 'jobs.json': manifest([]), 'a.mjs': 'export default async () => {};', 'b.mjs': 'export default async () => {};', 'c.mjs': 'export default async () => {};' });
    const p = project('many');
    const results = await Promise.all(['a', 'b', 'c'].map((name) => jobs.enqueue({ project: p, job: { name }, deploy: 'd1', trigger: 'cron' })));
    assert.deepEqual(results.map((r) => r.status), ['ok', 'ok', 'ok']);
  });
  test('a run that cannot start (undecryptable secrets) fails with the reason', async () => {
    fake.table('cubby_app_env').rows.push({ id: 'e1', project: 'p-broken', key: 'API_KEY', value: 'v1:AAAA:AAAA:AAAA' });
    const r = await jobs.enqueue({ project: project('broken'), job: { name: 'x' }, deploy: 'd1', trigger: 'manual' });
    fake.table('cubby_app_env').rows.length = 0;
    assert.equal(r.status, 'error');
    assert.match(r.log, /Could not decrypt secret API_KEY/);
  });
  test('the app was deleted mid-run: the run still reports, nothing throws', async () => {
    writeJob('gone', 'd1', { 'jobs.json': manifest([]), 'x.mjs': 'export default async () => {};' });
    const runs = fake.table('cubby_job_runs');
    const origUpdate = runs.update;
    const origCollection = admin.collection;
    admin.collection = (name) => (name === 'cubby_job_runs' ? { ...fake.table(name), update: async () => { throw new Error('404'); } } : origCollection(name));
    try {
      const r = await jobs.enqueue({ project: project('gone'), job: { name: 'x' }, deploy: 'd1', trigger: 'manual' });
      assert.equal(r.status, 'ok');
    } finally {
      admin.collection = origCollection;
      assert.equal(runs.update, origUpdate);
    }
  });
  test('runs beyond the last 100 per job are pruned', async () => {
    const runs = fake.table('cubby_job_runs');
    runs.rows.length = 0;
    for (let i = 0; i < jobs.KEEP_RUNS + 3; i++) runs.rows.push({ id: `old${i}`, project: 'p-prune', job: 'x', status: 'ok' });
    writeJob('prune', 'd1', { 'jobs.json': manifest([]), 'x.mjs': 'export default async () => {};' });
    await jobs.enqueue({ project: project('prune'), job: { name: 'x' }, deploy: 'd1', trigger: 'manual' });
    assert.equal(runs.rows.length, jobs.KEEP_RUNS);
  });
  test('recoverRuns fails runs left running by a restart', async () => {
    const runs = fake.table('cubby_job_runs');
    runs.rows.length = 0;
    runs.rows.push({ id: 'stuck', status: 'running', log: 'half\n' }, { id: 'stuck2', status: 'running' });
    await jobs.recoverRuns();
    assert.equal(runs.rows[0].status, 'error');
    assert.equal(runs.rows[0].log, 'half\nThe server restarted while this job was running.\n');
    assert.equal(runs.rows[1].log, 'The server restarted while this job was running.\n');
  });
});
