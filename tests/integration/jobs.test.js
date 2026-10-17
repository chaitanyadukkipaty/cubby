// Scheduled jobs and app secrets: deploy → manifest → sandboxed run against the real PocketBase, through the API.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, ADMIN } from '../helpers/server.js';
import { api, signup, adminToken, deployTo, app } from '../helpers/integration.js';

let srv, alice, bob, admin;
const manifest = (jobs) => JSON.stringify({ format: 1, jobs });
const bundle = (jobs, extra = {}) => ({
  'index.html': '<h1>jobs</h1>',
  '__cubby_jobs/jobs.json': manifest(Object.entries(jobs).map(([name, { schedule = '0 3 * * *' }]) => ({ name, schedule }))),
  ...Object.fromEntries(Object.entries(jobs).map(([name, { code }]) => [`__cubby_jobs/${name}.mjs`, code])),
  ...extra,
});

const WORKER = `
export const schedule = '*/5 * * * *';
export default async ({ pb, env, log, col }) => {
  log('secret:', env.API_KEY, 'collection:', col('notes'));
  const note = await pb.collection('notes').create({ text: 'from a job' });
  const form = new FormData();
  form.append('text', 'with a file');
  form.append('doc', new Blob(['hello']), 'hello.txt');
  const withFile = await pb.collection('notes').create(form);
  log('file:', withFile.doc.startsWith('hello'));
  log('notes:', (await pb.collection('notes').getFullList()).length);
  log('locked (superuser-only) readable:', (await pb.collection('vault').getList(1, 1)).totalItems);
  await pb.collection('notes').update(note.id, { text: 'edited' });
  for (const [what, call] of [
    ['other app', () => pb.send('/api/collections/bobs__notes/records', {})],
    ['platform users', () => pb.send('/api/collections/users/records', {})],
    ['schema', () => pb.send('/api/collections', {})],
    ['foreign join', () => pb.collection('notes').getList(1, 1, { filter: '@collection.users.id != ""' })],
  ]) {
    try { await call(); log(what, 'REACHED'); } catch (e) { log(what, 'blocked', e.status); }
  }
};`;

before(async () => {
  srv = await startServer();
  alice = api(srv.url, await signup(srv.url, 'alice-jobs@test.dev'));
  bob = api(srv.url, await signup(srv.url, 'bob-jobs@test.dev'));
  admin = api(srv.url, await adminToken(srv.url, ADMIN));
  assert.equal((await alice('POST', '/api/projects', { body: { slug: 'worker' } })).status, 200);
  assert.equal((await bob('POST', '/api/projects', { body: { slug: 'bobs' } })).status, 200);
  const schema = { collections: [
    { name: 'notes', fields: [{ name: 'text', type: 'text' }, { name: 'doc', type: 'file', maxSelect: 1 }], listRule: '' },
    { name: 'vault', fields: [{ name: 'v', type: 'text' }] },
  ] };
  assert.equal((await alice('PUT', '/api/projects/worker/schema', { body: schema })).status, 200);
  assert.equal((await bob('PUT', '/api/projects/bobs/schema', { body: schema })).status, 200);
});
after(() => srv?.stop());

describe('deploying jobs', () => {
  test('/api/info says the server has jobs', async () => {
    assert.deepEqual((await api(srv.url)('GET', '/api/info')).data.features, ['jobs']);
  });
  test('a deploy carries its jobs; they are listed but their code is never served', async () => {
    assert.equal((await alice('PUT', '/api/projects/worker/env/API_KEY', { body: { value: 's3cret' } })).status, 200);
    const d = await deployTo(alice, 'worker', bundle({ work: { code: WORKER }, fail: { code: 'export default async () => { throw new Error("nope"); };' } }));
    assert.equal(d.status, 200, JSON.stringify(d.data));
    assert.deepEqual(d.data.jobs, ['work', 'fail']);
    const jobs = (await alice('GET', '/api/projects/worker/jobs')).data;
    assert.deepEqual(jobs.map((j) => [j.name, j.schedule, j.paused, j.last_run]), [['work', '0 3 * * *', false, null], ['fail', '0 3 * * *', false, null]]);
    assert.match(jobs[0].next_run, /T03:00:00\.000Z$/);
    const site = app(srv, 'worker');
    assert.notEqual((await site('GET', '/__cubby_jobs/jobs.json')).status, 200);
    assert.doesNotMatch((await site('GET', '/__cubby_jobs/work.mjs')).text, /export default/);
    assert.equal((await alice('GET', '/api/projects')).data.find((p) => p.slug === 'worker').jobs, 2);
  });
  test('invalid jobs are refused and nothing is deployed', async () => {
    const before = (await alice('GET', '/api/projects/worker/deploys')).data.length;
    const bad = await deployTo(alice, 'worker', bundle({ ok: { code: '', schedule: 'every day' } }, { '__cubby_jobs/addon.node': 'x' }));
    assert.equal(bad.status, 400);
    assert.match(bad.data.details.join('\n'), /Job "ok": schedule needs 5 fields/);
    assert.match(bad.data.details.join('\n'), /addon\.node/);
    const broken = await deployTo(alice, 'worker', { 'index.html': 'x', '__cubby_jobs/jobs.json': '{' });
    assert.equal(broken.status, 400);
    assert.equal((await alice('GET', '/api/projects/worker/deploys')).data.length, before);
  });
});

describe('running jobs', () => {
  test("a run uses this app's data as superuser, sees its secrets, and can't reach anything else", async () => {
    const r = await alice('POST', '/api/projects/worker/jobs/work/run');
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'ok', r.data.log);
    assert.equal(r.data.trigger, 'manual');
    const log = r.data.log;
    assert.match(log, /secret: s3cret collection: worker__notes/);
    assert.match(log, /file: true/);
    assert.match(log, /notes: 2/);
    assert.match(log, /locked \(superuser-only\) readable: 0/);
    for (const what of ['other app', 'platform users', 'schema', 'foreign join']) assert.match(log, new RegExp(`${what} blocked 403`));
    const notes = await app(srv, 'worker')('GET', '/pb/api/collections/worker__notes/records?sort=created');
    assert.deepEqual(notes.data.items.map((n) => n.text), ['edited', 'with a file']);
  });
  test('a failing run, its history, and one run by id', async () => {
    const r = (await alice('POST', '/api/projects/worker/jobs/fail/run')).data;
    assert.equal(r.status, 'error');
    assert.match(r.log, /Error: nope/);
    await alice('POST', '/api/projects/worker/jobs/fail/run');
    const latest = (await alice('GET', '/api/projects/worker/jobs/fail/runs')).data;
    assert.equal(latest.length, 1);
    const two = (await alice('GET', '/api/projects/worker/jobs/fail/runs?limit=5')).data;
    assert.equal(two.length, 2);
    assert.ok(two[0].started >= two[1].started);
    assert.equal((await alice('GET', `/api/projects/worker/jobs/fail/runs?run=${r.id}`)).data[0].id, r.id);
    assert.equal((await alice('GET', `/api/projects/worker/jobs/work/runs?run=${r.id}`)).status, 404, 'a run of another job');
    assert.equal((await alice('GET', '/api/projects/worker/jobs/fail/runs?run=nope')).status, 404);
    const listed = (await alice('GET', '/api/projects/worker/jobs')).data.find((j) => j.name === 'fail');
    assert.equal(listed.last_run.status, 'error');
    assert.equal(listed.last_run.log, undefined, 'lists leave logs out');
  });
  test('a job never runs twice at once, and the time limit stops it', async () => {
    assert.equal((await admin('PATCH', '/api/admin/settings', { body: { job_timeout_s: 5 } })).status, 200);
    const d = await deployTo(alice, 'worker', bundle({ hang: { code: 'export default () => new Promise(() => setInterval(() => {}, 1000));' } }));
    assert.equal(d.status, 200);
    const first = alice('POST', '/api/projects/worker/jobs/hang/run');
    await new Promise((r) => setTimeout(r, 300));
    const second = await alice('POST', '/api/projects/worker/jobs/hang/run');
    assert.equal(second.status, 409);
    assert.match(second.data.error, /already running/);
    const r = (await first).data;
    assert.equal(r.status, 'timeout');
    assert.match(r.log, /Stopped after 5s/);
    await admin('PATCH', '/api/admin/settings', { body: { job_timeout_s: 60 } });
  });
  test('pause and resume survive deploys; unknown jobs and bad bodies are refused', async () => {
    assert.deepEqual((await alice('PATCH', '/api/projects/worker/jobs/hang', { body: { paused: true } })).data, { name: 'hang', paused: true });
    let hang = (await alice('GET', '/api/projects/worker/jobs')).data[0];
    assert.equal(hang.paused, true);
    assert.equal(hang.next_run, null);
    await deployTo(alice, 'worker', bundle({ hang: { code: 'export default async () => {};' } }));
    hang = (await alice('GET', '/api/projects/worker/jobs')).data[0];
    assert.equal(hang.paused, true, 'still paused after a deploy');
    await alice('PATCH', '/api/projects/worker/jobs/hang', { body: { paused: false } });
    assert.equal((await alice('GET', '/api/projects/worker/jobs')).data[0].paused, false);
    assert.equal((await alice('PATCH', '/api/projects/worker/jobs/hang', { body: { paused: 'yes' } })).status, 400);
    assert.equal((await alice('PATCH', '/api/projects/worker/jobs/nope', { body: { paused: true } })).status, 404);
    assert.equal((await alice('POST', '/api/projects/worker/jobs/nope/run')).status, 404);
  });
  test('the admin kill switch stops manual runs too', async () => {
    await admin('PATCH', '/api/admin/settings', { body: { jobs: false } });
    const r = await alice('POST', '/api/projects/worker/jobs/hang/run');
    assert.equal(r.status, 403);
    assert.match(r.data.error, /turned off/);
    assert.equal((await admin('GET', '/api/admin/overview')).data.settings.jobs, false);
    await admin('PATCH', '/api/admin/settings', { body: { jobs: true } });
  });
  test('rollback brings back the jobs a deploy shipped; a deploy without jobs has none', async () => {
    const deploys = (await alice('GET', '/api/projects/worker/deploys')).data;
    const withWork = deploys.find((d) => d.files === 4);
    assert.ok(withWork, JSON.stringify(deploys));
    await alice('POST', '/api/projects/worker/rollback', { body: { deploy: withWork.id } });
    assert.deepEqual((await alice('GET', '/api/projects/worker/jobs')).data.map((j) => j.name), ['work', 'fail']);
    await deployTo(alice, 'worker', { 'index.html': 'no jobs' });
    assert.deepEqual((await alice('GET', '/api/projects/worker/jobs')).data, []);
    assert.equal((await alice('GET', '/api/projects')).data.find((p) => p.slug === 'worker').jobs, 0);
  });
  test("only the owner sees an app's jobs", async () => {
    assert.equal((await bob('GET', '/api/projects/worker/jobs')).status, 404);
    assert.equal((await bob('POST', '/api/projects/worker/jobs/work/run')).status, 404);
  });
});

describe('secrets', () => {
  test('set, list (names only), overwrite and unset', async () => {
    assert.deepEqual((await alice('PUT', '/api/projects/worker/env/OTHER', { body: { value: 'x' } })).data, { key: 'OTHER', created: true });
    assert.deepEqual((await alice('PUT', '/api/projects/worker/env/OTHER', { body: { value: 'y' } })).data, { key: 'OTHER', created: false });
    const list = (await alice('GET', '/api/projects/worker/env')).data;
    assert.deepEqual(list.map((e) => e.key), ['API_KEY', 'OTHER']);
    assert.ok(list.every((e) => !('value' in e)));
    assert.equal((await alice('DELETE', '/api/projects/worker/env/OTHER')).status, 200);
    assert.equal((await alice('DELETE', '/api/projects/worker/env/OTHER')).status, 404);
  });
  test('bad names and values are refused; other users get 404', async () => {
    assert.equal((await alice('PUT', '/api/projects/worker/env/lower', { body: { value: 'x' } })).status, 400);
    assert.equal((await alice('PUT', '/api/projects/worker/env/OK', { body: {} })).status, 400);
    assert.equal((await bob('GET', '/api/projects/worker/env')).status, 404);
    assert.equal((await bob('PUT', '/api/projects/worker/env/X', { body: { value: 'x' } })).status, 404);
  });
});

describe('admin', () => {
  test("the admin sees every app's jobs; others can't", async () => {
    await deployTo(bob, 'bobs', bundle({ nightly: { code: 'export default async () => {};', schedule: '0 1 * * *' } }));
    const all = (await admin('GET', '/api/admin/jobs')).data;
    assert.deepEqual(all.map((j) => [j.app, j.name, j.owner]), [['bobs', 'nightly', 'bob-jobs@test.dev']]);
    assert.equal((await alice('GET', '/api/admin/jobs')).status, 403);
  });
});
