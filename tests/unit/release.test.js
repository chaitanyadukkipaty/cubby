// Release tooling (scripts/release.mjs): when to tag, release notes, the versioning rule, changelog moves.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changelogSection, planRelease, nextVersion, moveUnreleased, verifyTested, REQUIRED_CHECKS, main } from '../../scripts/release.mjs';

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- Something new.

## [0.1.1] - 2026-10-12

### Fixed

- A bug.

## [0.1.0] - 2026-10-11

First public version.

[0.1.1]: https://example.com/compare/v0.1.0...v0.1.1
`;

describe('changelogSection', () => {
  test('a middle section stops at the next heading', () => {
    assert.equal(changelogSection(CHANGELOG, '0.1.1'), '### Fixed\n\n- A bug.');
  });
  test('the last section runs to the end, without link references', () => {
    assert.equal(changelogSection(CHANGELOG, '0.1.0'), 'First public version.');
  });
  test('missing or empty sections are null', () => {
    assert.equal(changelogSection(CHANGELOG, '9.9.9'), null);
    assert.equal(changelogSection('## [0.2.0] - x\n\n## [0.1.0]\n- y', '0.2.0'), null);
  });
  test('0.1 does not match 0.1.1', () => {
    assert.equal(changelogSection('## [0.1.10] - x\n- ten', '0.1.1'), null);
  });
});

describe('planRelease', () => {
  const base = { version: '0.1.1', changelog: CHANGELOG };
  test('a version without a tag needs a tag and a release, with notes from the changelog', () => {
    assert.deepEqual(planRelease({ ...base, tags: ['v0.1.0'], releases: ['v0.1.0'] }), { action: 'release', tag: 'v0.1.1', notes: '### Fixed\n\n- A bug.' });
  });
  test('a tag without a release only needs the release (a previous run stopped halfway)', () => {
    assert.equal(planRelease({ ...base, tags: ['v0.1.1'], releases: [] }).action, 'publish');
  });
  test('already released: skip, so pushes to main without a version bump are no-ops', () => {
    assert.deepEqual(planRelease({ ...base, tags: ['v0.1.1'], releases: ['v0.1.1'] }), { action: 'skip', tag: 'v0.1.1', reason: 'v0.1.1 is already released' });
  });
  test('refuses to release without a changelog section', () => {
    assert.throws(() => planRelease({ version: '0.1.2', changelog: CHANGELOG, tags: [], releases: [] }), /no "## \[0.1.2\]" section/);
  });
  test('rejects versions that are not X.Y.Z', () => {
    for (const v of ['0.1', '0.1.1-dev+abc', 'v0.1.1', 'latest']) {
      assert.throws(() => planRelease({ version: v, changelog: CHANGELOG, tags: [], releases: [] }), /not a release version/, v);
    }
  });
});

describe('nextVersion: the versioning rule', () => {
  test('normal releases bump the patch', () => {
    assert.equal(nextVersion('0.1.0'), '0.1.1');
    assert.equal(nextVersion('0.1.9', 'patch'), '0.1.10');
    assert.equal(nextVersion('0.1.1', '0.1.5'), '0.1.5');
  });
  test('minor and major bumps need the maintainer\'s --major-change decision', () => {
    assert.throws(() => nextVersion('0.1.1', 'minor'), /bumps the minor or major version.*0\.1\.2/);
    assert.throws(() => nextVersion('0.1.1', 'major'), /--major-change/);
    assert.throws(() => nextVersion('0.1.1', '0.2.0'), /--major-change/);
    assert.equal(nextVersion('0.1.1', 'minor', { majorChange: true }), '0.2.0');
    assert.equal(nextVersion('0.9.3', 'major', { majorChange: true }), '1.0.0');
  });
  test('never goes backwards or sideways', () => {
    assert.throws(() => nextVersion('0.1.1', '0.1.1'), /not newer/);
    assert.throws(() => nextVersion('0.2.0', '0.1.9', { majorChange: true }), /not newer/);
    assert.throws(() => nextVersion('0.1.1', 'banana'), /not a release version/);
  });
});

describe('moveUnreleased', () => {
  test('moves the entries under a dated heading and leaves an empty [Unreleased]', () => {
    const out = moveUnreleased(CHANGELOG, '0.1.2', '2026-10-20');
    assert.match(out, /## \[Unreleased\]\n\n## \[0\.1\.2\] - 2026-10-20\n\n### Added\n\n- Something new\.\n\n## \[0\.1\.1\]/);
    assert.equal(changelogSection(out, '0.1.2'), '### Added\n\n- Something new.');
    assert.equal(changelogSection(out, '0.1.1'), '### Fixed\n\n- A bug.', 'older sections untouched');
  });
  test('refuses an empty [Unreleased], a duplicate version, or a missing section', () => {
    assert.throws(() => moveUnreleased('## [Unreleased]\n\n## [0.1.0]\n- x', '0.1.1', 'd'), /Nothing under \[Unreleased\]/);
    assert.throws(() => moveUnreleased(CHANGELOG, '0.1.1', 'd'), /already has a 0.1.1 section/);
    assert.throws(() => moveUnreleased('# Changelog', '0.1.1', 'd'), /no "## \[Unreleased\]"/);
  });
  test('works when [Unreleased] is the only section', () => {
    assert.equal(moveUnreleased('## [Unreleased]\n\n- only\n', '0.0.1', 'd'), '## [Unreleased]\n\n## [0.0.1] - d\n\n- only\n');
  });
});

test('every package.json carrying a version agrees with the root (release PRs bump them together)', () => {
  const read = (p) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));
  const root = read('package.json').version;
  assert.equal(read('cli/package.json').version, root);
  const lock = read('package-lock.json');
  assert.equal(lock.version, root);
  assert.equal(lock.packages[''].version, root);
  assert.equal(lock.packages.cli.version, root);
});

test('the current CHANGELOG has a section for the current version (it was released through a release PR)', () => {
  const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  assert.ok(changelogSection(readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'), version));
});

describe('verifyTested: releasing without running CI again on main', () => {
  // A squash merge of an up-to-date PR has exactly the tree CI tested on the PR's head.
  const sha = 'm'.repeat(40);
  const head = 'h'.repeat(40);
  const prs = [{ number: 55, merged_at: '2026-10-18T19:53:35Z', merge_commit_sha: sha, base: { ref: 'main' }, head: { sha: head } }];
  const passed = REQUIRED_CHECKS.map((name, i) => ({ id: i + 1, name, head_sha: head, status: 'completed', conclusion: 'success' }));
  const ok = { sha, tree: 't1', headTree: 't1', prs, checks: passed };

  test('the merged PR\'s head has the same tree and every required check passed: release', () => {
    assert.deepEqual(verifyTested(ok), { ok: true, pr: 55, head });
  });
  test('a commit that no merged PR made (a direct push) is refused', () => {
    assert.match(verifyTested({ ...ok, prs: [] }).reason, /isn't the merge of a pull request/);
    assert.match(verifyTested({ ...ok, prs: [{ ...prs[0], merged_at: null }] }).reason, /isn't the merge of a pull request/);
    assert.match(verifyTested({ ...ok, prs: [{ ...prs[0], merge_commit_sha: 'x'.repeat(40) }] }).reason, /isn't the merge of a pull request/);
  });
  test('different code than CI tested (the PR was behind main) is refused', () => {
    assert.match(verifyTested({ ...ok, headTree: 't2' }).reason, /differs from what CI tested on #55/);
  });
  test('a required check missing, failed, still running or for another commit is refused', () => {
    assert.match(verifyTested({ ...ok, checks: passed.slice(1) }).reason, new RegExp(`${REQUIRED_CHECKS[0]}: missing`));
    assert.match(verifyTested({ ...ok, checks: [{ ...passed[0], conclusion: 'failure' }, ...passed.slice(1)] }).reason, /: failure/);
    assert.match(verifyTested({ ...ok, checks: [{ ...passed[0], status: 'in_progress', conclusion: null }, ...passed.slice(1)] }).reason, /: in_progress/);
    assert.match(verifyTested({ ...ok, checks: passed.map((c) => ({ ...c, head_sha: 'z'.repeat(40) })) }).reason, /missing/);
  });
  test('a re-run counts: the newest run of each check decides', () => {
    const rerun = [{ ...passed[0], id: 1, conclusion: 'failure' }, { ...passed[0], id: 99, conclusion: 'success' }, ...passed.slice(1)];
    assert.equal(verifyTested({ ...ok, checks: rerun }).ok, true);
    const regressed = [{ ...passed[0], id: 99, conclusion: 'failure' }, { ...passed[0], id: 1 }, ...passed.slice(1)];
    assert.equal(verifyTested({ ...ok, checks: regressed }).ok, false);
  });
  test('the required checks are exactly the CI jobs, so renaming a job can\'t silently skip one', () => {
    const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const jobs = [...ci.matchAll(/^    name: (.+)$/gm)].map((m) => m[1].trim());
    assert.deepEqual([...REQUIRED_CHECKS].sort(), jobs.sort());
  });

  test('verify reads what the workflow fetched (check runs one per line) and refuses with the reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cubby-verify-'));
    writeFileSync(join(dir, 'prs.json'), JSON.stringify(prs));
    writeFileSync(join(dir, 'checks.ndjson'), passed.map((c) => JSON.stringify(c)).join('\n') + '\n');
    const args = (headTree) => ['verify', '--sha', sha, '--tree', 't1', '--head-tree', headTree, '--prs', join(dir, 'prs.json'), '--checks', join(dir, 'checks.ndjson')];
    const log = console.log;
    let out = '';
    console.log = (m) => { out += m; };
    try { main(args('t1')); } finally { console.log = log; }
    assert.match(out, /CI passed on #55 .* releasing without running it again/);
    assert.throws(() => main(args('t2')), /differs from what CI tested on #55.*Not releasing/);
  });
});
