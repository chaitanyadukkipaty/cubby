// Activity log (cubby_activity): who did what, by which agent, through the real API and PocketBase.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, ADMIN } from '../helpers/server.js';
import { api, signup, deployTo, adminToken } from '../helpers/integration.js';

let srv, anon, alice, aliceToken;
before(async () => {
  srv = await startServer();
  anon = api(srv.url);
  aliceToken = await signup(srv.url, 'alice-activity@test.dev');
  alice = api(srv.url, aliceToken);
});
after(() => srv?.stop());

// Start → approve as `user` → poll; returns the token the CLI would get.
async function deviceLogin(user, body) {
  const d = (await anon('POST', '/api/device/start', { body })).data;
  assert.equal((await user('POST', '/api/device/approve', { body: { code: d.user_code } })).status, 200);
  return (await anon('POST', '/api/device/poll', { body: { device_id: d.device_id } })).data.token;
}

describe('activity log', () => {
  test('a deploy made by an agent is attributed to that agent', async () => {
    const agent = api(srv.url, await deviceLogin(alice, { tool: 'Claude Code', machine: 'laptop' }));
    assert.equal((await agent('POST', '/api/projects', { body: { slug: 'act-one' } })).status, 200);
    const d = await deployTo(agent, 'act-one', { 'index.html': 'hi', 'a.js': '1' });
    assert.equal(d.status, 200);
    const list = (await alice('GET', '/api/activity')).data;
    const row = list.find((r) => r.action === 'deploy');
    assert.equal(row.app, 'act-one');
    assert.equal(row.via, 'agent');
    assert.equal(row.agent.name, 'Claude Code · laptop');
    assert.match(row.summary, new RegExp(`${d.data.id}.*2 files`));
  });
  test('dashboard actions (the manual token) are attributed to the user via the dashboard; newest first', async () => {
    assert.equal((await alice('POST', '/api/projects', { body: { slug: 'act-dash' } })).status, 200);
    assert.equal((await alice('PATCH', '/api/projects/act-dash', { body: { unlisted: true } })).status, 200);
    assert.equal((await alice('DELETE', '/api/projects/act-dash')).status, 200);
    const rows = (await alice('GET', '/api/activity?app=act-dash')).data;
    assert.deepEqual(rows.map((r) => r.action), ['app.delete', 'app.update', 'app.create']);
    assert.ok(rows.every((r) => r.via === 'dashboard' && r.agent === null && r.user === 'alice-activity@test.dev'));
    assert.match(rows[1].summary, /unlisted/);
  });
  test('env set/unset record the key name, never the value', async () => {
    const secret = 'sk-live-very-secret-value-123';
    assert.equal((await alice('PUT', '/api/projects/act-one/env/STRIPE_KEY', { body: { value: secret } })).status, 200);
    assert.equal((await alice('DELETE', '/api/projects/act-one/env/STRIPE_KEY')).status, 200);
    const r = await alice('GET', '/api/activity?app=act-one');
    const env = r.data.filter((x) => x.action.startsWith('env.'));
    assert.deepEqual(env.map((x) => x.action), ['env.unset', 'env.set']);
    assert.ok(env.every((x) => x.summary.includes('STRIPE_KEY')));
    assert.ok(!r.text.includes(secret), 'the value never reaches the log');
    assert.ok(!r.text.includes('sk-live'));
  });
  test('rollback, schema push (added/kept) and schema drop are recorded', async () => {
    const first = (await alice('GET', '/api/projects/act-one/deploys')).data.at(-1).id;
    await deployTo(alice, 'act-one', { 'index.html': 'v2' });
    assert.equal((await alice('POST', '/api/projects/act-one/rollback', { body: { deploy: first } })).status, 200);
    const schema = (fields) => ({ collections: [{ name: 'notes', type: 'base', fields }] });
    assert.equal((await alice('PUT', '/api/projects/act-one/schema', { body: schema([{ name: 'title', type: 'text' }, { name: 'body', type: 'text' }]) })).status, 200);
    assert.equal((await alice('PUT', '/api/projects/act-one/schema', { body: schema([{ name: 'title', type: 'text' }]) })).status, 200);
    assert.equal((await alice('DELETE', '/api/projects/act-one/schema/notes.body')).status, 200);
    const rows = (await alice('GET', '/api/activity?app=act-one')).data;
    assert.match(rows.find((r) => r.action === 'rollback').summary, new RegExp(first));
    const pushes = rows.filter((r) => r.action === 'schema.push');
    assert.match(pushes[1].summary, /created notes/);
    assert.match(pushes[0].summary, /kept notes\.body/);
    assert.match(rows.find((r) => r.action === 'schema.drop').summary, /notes\.body/);
  });
  test('running, pausing and resuming a job are recorded', async () => {
    const files = {
      'index.html': 'jobs',
      '__cubby_jobs/jobs.json': JSON.stringify({ format: 1, jobs: [{ name: 'tick', schedule: '0 3 * * *' }] }),
      '__cubby_jobs/tick.mjs': 'export default async ({ log }) => log("ok");',
    };
    assert.equal((await deployTo(alice, 'act-one', files)).status, 200);
    assert.equal((await alice('POST', '/api/projects/act-one/jobs/tick/run')).status, 200);
    assert.equal((await alice('PATCH', '/api/projects/act-one/jobs/tick', { body: { paused: true } })).status, 200);
    assert.equal((await alice('PATCH', '/api/projects/act-one/jobs/tick', { body: { paused: false } })).status, 200);
    const rows = (await alice('GET', '/api/activity?app=act-one')).data.filter((r) => r.action.startsWith('job.'));
    assert.deepEqual(rows.map((r) => r.action), ['job.resume', 'job.pause', 'job.run']);
    assert.match(rows[2].summary, /tick.*ok/);
  });
  test('approving an agent login is recorded under that agent, without an app', async () => {
    await deviceLogin(alice, { tool: 'Codex', machine: 'desk' });
    const row = (await alice('GET', '/api/activity')).data.find((r) => r.action === 'agent.login' && r.agent.name === 'Codex · desk');
    assert.equal(row.via, 'agent');
    assert.equal(row.app, null);
    assert.match(row.summary, /Codex · desk/);
  });
  test('users never see each other\'s activity; admins see everyone\'s', async () => {
    const bob = api(srv.url, await signup(srv.url, 'bob-activity@test.dev'));
    assert.equal((await bob('POST', '/api/projects', { body: { slug: 'act-bob' } })).status, 200);
    const bobs = (await bob('GET', '/api/activity')).data;
    assert.deepEqual(bobs.map((r) => r.app), ['act-bob']);
    assert.ok(!(await alice('GET', '/api/activity')).data.some((r) => r.app === 'act-bob'));
    assert.deepEqual((await alice('GET', '/api/activity?app=act-bob')).data, [], 'not even by naming the app');
    assert.equal((await bob('GET', '/api/admin/activity')).status, 403);
    assert.equal((await anon('GET', '/api/activity')).status, 401);
    const all = (await api(srv.url, await adminToken(srv.url, ADMIN))('GET', '/api/admin/activity?limit=500')).data;
    assert.ok(all.some((r) => r.user === 'bob-activity@test.dev') && all.some((r) => r.user === 'alice-activity@test.dev'));
  });
  test('filters: by agent (or "dashboard" for the manual token) and a limit', async () => {
    const mine = (await alice('GET', '/api/agents')).data;
    const laptop = mine.find((a) => a.name === 'Claude Code · laptop');
    const byAgent = (await alice('GET', `/api/activity?agent=${laptop.id}`)).data;
    assert.deepEqual(byAgent.map((r) => r.action).sort(), ['agent.login', 'app.create', 'deploy']);
    const dash = (await alice('GET', '/api/activity?agent=dashboard')).data;
    assert.ok(dash.length > 0 && dash.every((r) => r.via === 'dashboard'));
    assert.equal((await alice('GET', '/api/activity?limit=2')).data.length, 2);
  });
  test('admin actions on users and apps are recorded under the admin', async () => {
    const adminCall = api(srv.url, await adminToken(srv.url, ADMIN));
    const carol = api(srv.url, await signup(srv.url, 'carol-activity@test.dev'));
    const carolId = (await carol('GET', '/api/me')).data.id;
    for (const slug of ['act-carol', 'act-carol2']) assert.equal((await carol('POST', '/api/projects', { body: { slug } })).status, 200);
    assert.equal((await adminCall('DELETE', '/api/admin/apps/act-carol')).status, 200);
    assert.equal((await adminCall('PATCH', `/api/admin/users/${carolId}`, { body: { disabled: true } })).status, 200);
    assert.equal((await adminCall('PATCH', `/api/admin/users/${carolId}`, { body: { disabled: false } })).status, 200);
    assert.equal((await adminCall('DELETE', `/api/admin/users/${carolId}`)).status, 200);
    const rows = (await adminCall('GET', '/api/activity')).data;
    assert.deepEqual(rows.slice(0, 4).map((r) => r.action), ['admin.user.delete', 'admin.user.enable', 'admin.user.disable', 'admin.app.delete']);
    assert.ok(rows.slice(0, 4).every((r) => r.user === ADMIN.email));
    assert.match(rows[0].summary, /carol-activity@test\.dev.*act-carol2/);
    assert.match(rows[3].summary, /act-carol.*carol-activity@test\.dev/);
    assert.equal(rows[3].app, 'act-carol');
  });
});
