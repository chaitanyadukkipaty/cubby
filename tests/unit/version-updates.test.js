// Server version identity (version.js) and the daily update check (updates.js). No network, no git.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeVersion, buildInfo, versionCore, compareCores, isUpdateAvailable } from '../../server/src/version.js';
import { createUpdateChecker, fetchLatestRelease, updateView, scheduleUpdateChecks, CHECK_INTERVAL_MS } from '../../server/src/updates.js';

describe('computeVersion: different code never reports the same version', () => {
  const pkgVersion = '0.1.1';
  test('a build of the matching release tag reports the plain version', () => {
    assert.equal(computeVersion({ pkgVersion, commit: 'abc1234', tag: 'v0.1.1' }), '0.1.1');
  });
  test('any other build with a commit reports X.Y.Z-dev+<sha>', () => {
    assert.equal(computeVersion({ pkgVersion, commit: 'abc1234', tag: null }), '0.1.1-dev+abc1234');
    assert.equal(computeVersion({ pkgVersion, commit: 'abc1234', tag: 'v0.1.0' }), '0.1.1-dev+abc1234', 'a tag that disagrees with package.json is not a release build');
    assert.equal(computeVersion({ pkgVersion, commit: 'abc1234', tag: '0.1.1' }), '0.1.1-dev+abc1234', 'tags need the v prefix');
  });
  test('without build info it falls back to package.json', () => {
    assert.equal(computeVersion({ pkgVersion, commit: null, tag: null }), '0.1.1');
  });
  test('CUBBY_VERSION_OVERRIDE wins over everything', () => {
    assert.equal(computeVersion({ pkgVersion, override: '0.0.9', commit: 'abc1234', tag: 'v0.1.1' }), '0.0.9');
  });
});

describe('buildInfo', () => {
  const noGit = () => assert.fail('git must not run when the build provided the info');
  test('env set by the Docker build wins, and empty means "unknown"', () => {
    assert.deepEqual(buildInfo({ CUBBY_COMMIT: 'abc1234', CUBBY_TAG: 'v0.1.1' }, '/nowhere', noGit), { commit: 'abc1234', tag: 'v0.1.1' });
    assert.deepEqual(buildInfo({ CUBBY_COMMIT: '', CUBBY_TAG: '' }, '/nowhere', noGit), { commit: null, tag: null });
    assert.deepEqual(buildInfo({ CUBBY_COMMIT: 'abc1234' }, '/nowhere', noGit), { commit: 'abc1234', tag: null });
  });
  test('otherwise it asks git, but only inside a checkout', () => {
    const plain = mkdtempSync(join(tmpdir(), 'cubby-nogit-'));
    assert.deepEqual(buildInfo({}, plain, noGit), { commit: null, tag: null });

    const repo = mkdtempSync(join(tmpdir(), 'cubby-git-'));
    mkdirSync(join(repo, '.git'));
    const calls = [];
    const git = (root, args) => {
      calls.push(args[0]);
      return args[0] === 'rev-parse' ? 'abc1234' : 'v0.1.1\nv0.1.1-rc';
    };
    assert.deepEqual(buildInfo({}, repo, git), { commit: 'abc1234', tag: 'v0.1.1' });
    assert.deepEqual(calls, ['rev-parse', 'tag']);
    assert.deepEqual(buildInfo({}, repo, () => ''), { commit: null, tag: null }, 'git failures mean unknown');
  });
  test('the real git runner returns nothing for a non-repo instead of throwing', () => {
    const fake = mkdtempSync(join(tmpdir(), 'cubby-fakegit-'));
    mkdirSync(join(fake, '.git'));
    const info = buildInfo({}, fake);
    assert.equal(info.tag, null);
  });
});

describe('versionCore / isUpdateAvailable', () => {
  test('parses versions and release tags, rejects junk', () => {
    assert.deepEqual(versionCore('v0.1.2'), [0, 1, 2]);
    assert.deepEqual(versionCore('0.1.2-dev+abc1234'), [0, 1, 2]);
    assert.deepEqual(versionCore(' 10.0.3 '), [10, 0, 3]);
    for (const bad of ['', null, undefined, 'main', '1.2', 'v1.2.x', '1.2.3.4']) assert.equal(versionCore(bad), null, String(bad));
  });
  test('compareCores orders numerically, not alphabetically', () => {
    assert.equal(compareCores([0, 1, 10], [0, 1, 9]), 1);
    assert.equal(compareCores([0, 2, 0], [0, 10, 0]), -1);
    assert.equal(compareCores([1, 0, 0], [1, 0, 0]), 0);
  });
  test('newer releases are updates; dev builds compare by their base', () => {
    assert.equal(isUpdateAvailable('0.1.1', 'v0.1.2'), true);
    assert.equal(isUpdateAvailable('0.1.1', 'v0.2.0'), true);
    assert.equal(isUpdateAvailable('0.1.1', 'v0.1.1'), false);
    assert.equal(isUpdateAvailable('0.1.2', 'v0.1.1'), false);
    assert.equal(isUpdateAvailable('0.1.1-dev+abc1234', 'v0.1.1'), false, 'main after the 0.1.1 release is not behind it');
    assert.equal(isUpdateAvailable('0.1.1-dev+abc1234', 'v0.1.2'), true);
    assert.equal(isUpdateAvailable('0.1.1', null), false);
    assert.equal(isUpdateAvailable('weird', 'v9.9.9'), false);
  });
});

describe('fetchLatestRelease', () => {
  const respond = (status, body) => async (url, opts) => {
    assert.equal(opts.headers['user-agent'], 'cubby-update-check');
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  test('reads the tag and the release page', async () => {
    assert.deepEqual(await fetchLatestRelease('u', { fetchImpl: respond(200, { tag_name: 'v0.1.2', html_url: 'https://gh/r' }) }), { tag: 'v0.1.2', url: 'https://gh/r' });
    assert.deepEqual(await fetchLatestRelease('u', { fetchImpl: respond(200, { tag_name: 'v0.1.2' }) }), { tag: 'v0.1.2', url: null });
  });
  test('no release yet is not an error', async () => {
    assert.equal(await fetchLatestRelease('u', { fetchImpl: respond(404, {}) }), null);
  });
  test('errors and odd responses throw', async () => {
    await assert.rejects(fetchLatestRelease('u', { fetchImpl: respond(500, {}) }), /HTTP 500/);
    await assert.rejects(fetchLatestRelease('u', { fetchImpl: respond(200, { nope: 1 }) }), /unexpected response/);
  });
});

describe('createUpdateChecker', () => {
  test('checks at most once a day unless forced', async () => {
    let t = 1_000;
    let calls = 0;
    const checker = createUpdateChecker({ current: '0.1.1', now: () => t, fetchLatest: async () => (calls++, { tag: 'v0.1.2', url: 'https://gh/r' }) });
    assert.deepEqual(checker.status(), { current: '0.1.1', latest: null, update_available: false, release_url: null, checked_at: null, error: null });
    const s = await checker.check();
    assert.equal(s.update_available, true);
    assert.equal(s.latest, 'v0.1.2');
    assert.equal(s.release_url, 'https://gh/r');
    assert.equal(s.checked_at, new Date(1_000).toISOString());
    t += CHECK_INTERVAL_MS - 1;
    await checker.check();
    assert.equal(calls, 1, 'cached within a day');
    await checker.check({ force: true });
    assert.equal(calls, 2);
    t += CHECK_INTERVAL_MS;
    await checker.check();
    assert.equal(calls, 3);
  });
  test('concurrent checks share one request', async () => {
    let calls = 0;
    let release;
    const checker = createUpdateChecker({ current: '0.1.1', fetchLatest: () => (calls++, new Promise((r) => (release = r))) });
    const a = checker.check();
    const b = checker.check();
    release({ tag: 'v0.1.1', url: null });
    await Promise.all([a, b]);
    assert.equal(calls, 1);
    assert.equal(checker.status().update_available, false);
  });
  test('a failed check keeps the last answer and records the error', async () => {
    let fail = false;
    const checker = createUpdateChecker({ current: '0.1.1', fetchLatest: async () => { if (fail) throw new Error('offline'); return { tag: 'v0.1.2', url: null }; } });
    await checker.check();
    fail = true;
    const s = await checker.check({ force: true });
    assert.equal(s.latest, 'v0.1.2');
    assert.equal(s.update_available, true);
    assert.equal(s.error, 'offline');
  });
});

describe('updateView and scheduling', () => {
  const checker = createUpdateChecker({ current: '0.1.1', fetchLatest: async () => null });
  test('reports why the check is off', () => {
    assert.deepEqual(updateView({ envEnabled: false, settingEnabled: true, checker }), { enabled: false, reason: 'env', current: '0.1.1' });
    assert.deepEqual(updateView({ envEnabled: true, settingEnabled: false, checker }), { enabled: false, reason: 'setting', current: '0.1.1' });
    assert.equal(updateView({ envEnabled: true, settingEnabled: true, checker }).enabled, true);
  });
  test('checks at start-up and on every tick, only while enabled, and never throws', async () => {
    let enabled = true;
    let checks = 0;
    let tickFn;
    const fake = { check: async () => { checks++; throw new Error('boom'); } };
    const { tick } = scheduleUpdateChecks({ checker: fake, isEnabled: async () => enabled, setIntervalImpl: (fn, ms) => { tickFn = fn; assert.equal(ms, CHECK_INTERVAL_MS); return null; } });
    await tick();
    assert.equal(tickFn, tick);
    enabled = false;
    await tick();
    assert.ok(checks >= 1 && checks <= 2, 'the start-up check plus the enabled tick');
    const before = checks;
    await tick();
    assert.equal(checks, before, 'no check while disabled');
  });
});
