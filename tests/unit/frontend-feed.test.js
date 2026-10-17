// Unit tests for the activity feed's view model (server/public/js/feed.js): who did it, grouping by day, which
// entries can be rolled back, and the fixed prompt templates. Pure, so it's imported directly.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as feed from '../../server/public/js/feed.js';

test('the feed module has no DOM state, network access or imports beyond pure modules', () => {
  const src = readFileSync(new URL('../../server/public/js/feed.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bfetch\(|localStorage|location\.|document\.|window\./);
  for (const m of src.matchAll(/^import .* from '(.*)';$/gm)) assert.match(m[1], /^\.\/(helpers|routes)\.js$/);
});

describe('monogram()', () => {
  test('known agent tools get their usual two letters', () => {
    assert.equal(feed.monogram('Claude Code'), 'CC');
    assert.equal(feed.monogram('Codex'), 'CX');
    assert.equal(feed.monogram('Cursor'), 'CU');
    assert.equal(feed.monogram('OpenCode'), 'OC');
  });
  test('an agent named "<tool> · <machine>" is badged by its tool', () => {
    assert.equal(feed.monogram('Claude Code · priya-mbp'), 'CC');
    assert.equal(feed.monogram('Codex · work-laptop'), 'CX');
  });
  test('anything else: initials of the first two words, or the first two letters of one word', () => {
    assert.equal(feed.monogram("Priya's laptop"), 'PL');
    assert.equal(feed.monogram('Manual token'), 'MT');
    assert.equal(feed.monogram('windsurf'), 'WI');
    assert.equal(feed.monogram('  '), '?');
    assert.equal(feed.monogram(null), '?');
  });
});

describe('groupByDay()', () => {
  const now = new Date(2026, 9, 17, 15, 0); // local time, like the browser's
  const at = (...d) => new Date(...d).toISOString();
  test('newest first, one group per local day: Today, Yesterday, then dates', () => {
    const rows = [
      { id: 'a', at: at(2026, 9, 17, 14, 0) }, { id: 'b', at: at(2026, 9, 17, 0, 5) },
      { id: 'c', at: at(2026, 9, 16, 23, 59) }, { id: 'd', at: at(2026, 9, 11, 9, 0) },
      { id: 'e', at: at(2025, 11, 30, 9, 0) },
    ];
    const groups = feed.groupByDay(rows, now);
    assert.deepEqual(groups.map((g) => [g.label, g.rows.map((r) => r.id)]),
      [['Today', ['a', 'b']], ['Yesterday', ['c']], ['Oct 11', ['d']], ['Dec 30, 2025', ['e']]]);
  });
  test('no rows, no groups', () => assert.deepEqual(feed.groupByDay([], now), []));
});

describe('prompt templates', () => {
  const apps = [
    { slug: 'book-club', name: 'Book Club', last_deployed: '2026-10-15 09:00:00.000Z', current_deploy: 'b1' },
    { slug: 'friend-polls', name: 'Friend Polls', last_deployed: '2026-10-17 09:00:00.000Z', current_deploy: 'f1' },
    { slug: 'draft', name: 'Draft', last_deployed: '', current_deploy: '' },
  ];
  test('with no apps yet, the next steps are app ideas for this server', () => {
    const p = feed.nextPrompts({ apps: [], serverName: "Priya's Cubby" });
    assert.deepEqual(p, [
      "Build me a polls app for my friends and host it on Priya's Cubby.",
      "Build a shared grocery list for my flatmates and host it on Priya's Cubby.",
    ]);
  });
  test('with apps, they build on the most recently deployed one and end with a new idea', () => {
    const p = feed.nextPrompts({ apps, serverName: "Priya's Cubby" });
    assert.equal(p.length, 4);
    assert.match(p[0], /^Add a dark mode toggle to Friend Polls and redeploy it on Priya's Cubby\.$/);
    for (const prompt of p.slice(0, 3)) assert.match(prompt, /Friend Polls/);
    assert.match(p[3], /grocery list/);
  });
  test("an unnamed server is called Cubby", () => assert.match(feed.nextPrompts({ apps: [] })[0], /host it on Cubby\.$/));

  test('fix-it prompt for a failed job names the app, the job and how to read its log', () => {
    assert.equal(feed.fixItPrompt({ kind: 'job', app: 'friend-polls', job: 'weekly-digest', status: 'error' }),
      'The scheduled job "weekly-digest" of my Cubby app friend-polls failed (error). Read its recent logs with `cubby jobs logs weekly-digest` in the app folder, find the cause, fix it and redeploy.');
  });
  test('fix-it prompt for API errors names the app, how many and the rate', () => {
    assert.equal(feed.fixItPrompt({ kind: 'errors', app: 'friend-polls', errors: 9, rate: 0.12, range: '24h' }),
      'My Cubby app friend-polls had 9 API errors (12% of requests) in the last 24h. Check `cubby metrics friend-polls` and `cubby deploys`, find what changed, fix the cause and redeploy.');
  });

  test("empty states suggest what to ask the agent, naming the app", () => {
    for (const tab of ['overview', 'activity', 'deploys', 'jobs', 'env']) {
      const p = feed.emptyPrompt(tab, { slug: 'friend-polls', name: 'Friend Polls' });
      assert.match(p, /Friend Polls/, tab);
    }
  });
});

describe('needsAttention()', () => {
  test('failed scheduled jobs and apps with many API errors, each with a fix-it prompt', () => {
    const items = feed.needsAttention({
      jobs: [{ app: 'friend-polls', name: 'weekly-digest', last_run: { status: 'error', started: '2026-10-17 08:00:00.000Z' } },
        { app: 'friend-polls', name: 'ok-job', last_run: { status: 'ok' } }, { app: 'x', name: 'new', last_run: null },
        { app: 'x', name: 'paused', paused: true, last_run: { status: 'error' } }],
      metrics: [{ app: 'friend-polls', api_requests: 75, api_errors: 9, api_error_rate: 0.12, range: '24h' },
        { app: 'book-club', api_requests: 1000, api_errors: 2, api_error_rate: 0.002 },
        { app: 'tiny', api_requests: 2, api_errors: 1, api_error_rate: 0.5 }],
    });
    assert.deepEqual(items.map((i) => [i.app, i.text]), [
      ['friend-polls', 'Job weekly-digest failed (error)'],
      ['friend-polls', '9 API errors in the last 24h (12% of requests)'],
    ]);
    assert.match(items[0].prompt, /weekly-digest/);
    assert.match(items[1].prompt, /9 API errors/);
  });
});

describe('feedEntries()', () => {
  test("after a rollback, the older deploy that's live again doesn't offer Roll back: only an app's newest deploy can", () => {
    const apps = [{ slug: 'polls', name: 'Polls', current_deploy: 'd1' }];
    const rows = [
      { id: 'r3', at: '2026-10-17 10:00:00.000Z', via: 'dashboard', app: 'polls', action: 'rollback', summary: 'Rolled back to d1' },
      { id: 'r2', at: '2026-10-17 09:00:00.000Z', via: 'dashboard', app: 'polls', action: 'deploy', summary: 'Deployed d2 (1 file)' },
      { id: 'r1', at: '2026-10-17 08:00:00.000Z', via: 'dashboard', app: 'polls', action: 'deploy', summary: 'Deployed d1 (1 file)' },
    ];
    assert.deepEqual(feed.feedEntries(rows, { apps }).map((e) => e.rollback), [false, false, false]);
    apps[0].current_deploy = 'd2';
    assert.deepEqual(feed.feedEntries(rows.slice(1), { apps }).map((e) => e.rollback), [true, false]);
  });
});

describe('summaries from the activity log', () => {
  const rows = [ // newest first, as GET /api/activity returns them
    { app: 'polls', action: 'deploy', via: 'agent', agent: { id: 'k1', name: 'Claude Code · mbp' }, summary: 'Deployed d3 (2 files)' },
    { app: 'polls', action: 'deploy', via: 'agent', agent: { id: 'k2', name: 'Codex · wl' }, summary: 'Deployed d2 (2 files)' },
    { app: 'club', action: 'env.set', via: 'agent', agent: { id: 'k2', name: 'Codex · wl' }, summary: 'Added secret KEY' },
    { app: 'club', action: 'deploy', via: 'dashboard', agent: null, summary: 'Deployed c1 (2 files)' },
    { app: null, action: 'agent.rename', via: 'dashboard', agent: null, summary: 'Renamed agent' },
  ];
  test('who deployed each app last', () => {
    const last = feed.lastDeployers(rows);
    assert.equal(last.polls.name, 'Claude Code · mbp');
    assert.equal(last.club.name, 'Dashboard');
    assert.equal(last.other, undefined);
  });
  test('which apps each agent touched, most recent first', () => {
    const touched = feed.appsByAgent(rows);
    assert.deepEqual(touched.k1, ['polls']);
    assert.deepEqual(touched.k2, ['polls', 'club']);
    assert.deepEqual(touched.dashboard, ['club']);
  });
});

describe('rollbackTarget()', () => {
  const deploys = [{ id: 'd3', current: true }, { id: 'd2' }, { id: 'd1' }]; // GET /deploys: newest first
  test('rolling back a deploy restores the one before it', () => assert.equal(feed.rollbackTarget(deploys, 'd3').id, 'd2'));
  test('nothing before the first deploy, or an unknown one', () => {
    assert.equal(feed.rollbackTarget(deploys, 'd1'), null);
    assert.equal(feed.rollbackTarget(deploys, 'nope'), null);
  });
});

describe('feedEntry()', () => {
  const apps = [{ slug: 'friend-polls', name: 'Friend Polls', current_deploy: 'd12' }];
  const agents = [{ id: 'k1', name: 'Work laptop', tool: 'Codex', machine: 'wl' }];
  const row = (over) => ({ id: 'r1', at: '2026-10-17 09:30:00.000Z', via: 'agent', agent: { id: 'k1', name: 'Codex · wl' }, app: 'friend-polls', action: 'app.update', summary: 'Updated "friend-polls": made it unlisted', ...over });

  test("an agent's entry shows its current name, its tool's badge and links to its page", () => {
    const e = feed.feedEntry(row(), { apps, agents });
    assert.deepEqual(e.actor, { name: 'Work laptop', mono: 'CX', href: '/agents/k1' });
    assert.equal(e.text, 'Updated "friend-polls": made it unlisted');
    assert.deepEqual(e.app, { slug: 'friend-polls', name: 'Friend Polls', href: '/apps/friend-polls' });
  });
  test('a revoked agent keeps the name it had, without a link', () => {
    const e = feed.feedEntry(row({ agent: { id: 'gone', name: 'Claude Code · mbp' } }), { apps, agents });
    assert.deepEqual(e.actor, { name: 'Claude Code · mbp', mono: 'CC', href: null });
  });
  test('changes made from the dashboard (or the manual token) say so', () => {
    const e = feed.feedEntry(row({ via: 'dashboard', agent: null }), { apps, agents });
    assert.deepEqual(e.actor, { name: 'Dashboard', mono: 'DB', href: null });
  });
  test("an app that's gone (or isn't yours) is named by its slug, without a link; account-wide actions have no app", () => {
    assert.deepEqual(feed.feedEntry(row({ app: 'old-app' }), { apps, agents }).app, { slug: 'old-app', name: 'old-app', href: null });
    assert.equal(feed.feedEntry(row({ app: null, action: 'agent.rename' }), { apps, agents }).app, null);
  });
  test('deploys and rollbacks read as a verb on the app, without raw deploy ids', () => {
    const d = feed.feedEntry(row({ action: 'deploy', summary: 'Deployed d12 (4 files)' }), { apps, agents });
    assert.deepEqual([d.verb, d.detail], ['deployed', '4 files']);
    const r = feed.feedEntry(row({ action: 'rollback', summary: 'Rolled back to d11' }), { apps, agents });
    assert.deepEqual([r.verb, r.detail], ['rolled back', 'to an earlier deploy']);
    assert.equal(feed.feedEntry(row(), { apps, agents }).verb, undefined); // anything else: the summary as written
  });
  test("only the deploy that's live now offers Roll back", () => {
    const live = feed.feedEntry(row({ action: 'deploy', summary: 'Deployed d12 (4 files)' }), { apps, agents });
    assert.equal(live.kind, 'deploy');
    assert.equal(live.deployId, 'd12');
    assert.equal(live.rollback, true);
    const old = feed.feedEntry(row({ action: 'deploy', summary: 'Deployed d11 (4 files)' }), { apps, agents });
    assert.equal(old.rollback, false);
    const notMine = feed.feedEntry(row({ app: 'other', action: 'deploy', summary: 'Deployed d12 (4 files)' }), { apps, agents });
    assert.equal(notMine.rollback, false);
  });
  test('a job run that failed or timed out is marked failed and names the job', () => {
    for (const status of ['error', 'timeout']) {
      const e = feed.feedEntry(row({ action: 'job.run', summary: `Ran job "weekly-digest" now (${status})` }), { apps, agents });
      assert.equal(e.kind, 'failed');
      assert.equal(e.job, 'weekly-digest');
    }
    assert.equal(feed.feedEntry(row({ action: 'job.run', summary: 'Ran job "weekly-digest" now (ok)' }), { apps, agents }).kind, 'other');
  });
});
