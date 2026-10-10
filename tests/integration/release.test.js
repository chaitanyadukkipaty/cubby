// scripts/release.mjs against a real (temporary) git repo, running the same commands as
// .github/workflows/release.yml's "Decide" step, plus `bump` preparing a release PR.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../helpers/server.js';

const SCRIPT = join(ROOT, 'scripts', 'release.mjs');
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.dev', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.dev' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

function repo({ version, changelog }) {
  const dir = mkdtempSync(join(tmpdir(), 'cubby-release-'));
  mkdirSync(join(dir, 'cli'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'cubby', version }, null, 2));
  writeFileSync(join(dir, 'cli', 'package.json'), JSON.stringify({ name: 'cubby-cli', version }, null, 2));
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

// The workflow's Decide step: list tags and releases, then plan.
function decide(dir, releases = []) {
  writeFileSync(join(dir, 'tags.txt'), git(dir, 'tag', '--list', 'v*'));
  writeFileSync(join(dir, 'releases.txt'), releases.join('\n'));
  const out = join(dir, 'gh-output');
  writeFileSync(out, '');
  const r = spawnSync(process.execPath, [SCRIPT, 'plan', '--root', dir, '--tags', join(dir, 'tags.txt'), '--releases', join(dir, 'releases.txt'), '--notes', join(dir, 'notes.md')],
    { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, output: readFileSync(out, 'utf8') };
}

describe('release workflow decision on a real repo', () => {
  const changelog = '# Changelog\n\n## [Unreleased]\n\n## [0.1.1] - 2026-10-12\n\n### Fixed\n\n- A bug.\n\n## [0.1.0] - 2026-10-11\n\nFirst.\n';
  let dir;
  before(() => {
    dir = repo({ version: '0.1.1', changelog });
    git(dir, 'tag', 'v0.1.0');
  });

  test('a version bump on main means: tag it and publish the changelog section', () => {
    const r = decide(dir, ['v0.1.0']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.output, 'action=release\ntag=v0.1.1\n');
    assert.equal(readFileSync(join(dir, 'notes.md'), 'utf8'), '### Fixed\n\n- A bug.\n');
  });

  test('once tagged and released, later pushes do nothing', () => {
    git(dir, 'tag', 'v0.1.1');
    assert.equal(decide(dir, ['v0.1.1']).output, 'action=skip\ntag=v0.1.1\n');
    assert.equal(decide(dir, []).output, 'action=publish\ntag=v0.1.1\n', 'tag without a release: publish only');
  });

  test('refuses to release a version the changelog does not describe', () => {
    const bad = repo({ version: '0.1.2', changelog });
    const r = decide(bad);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /CHANGELOG\.md has no "## \[0\.1\.2\]" section/);
    assert.equal(r.output, '', 'no outputs, so no tag is pushed');
  });
});

describe('bump prepares a release PR', () => {
  test('next patch: both package.json files and the changelog move together', () => {
    const dir = repo({ version: '0.1.1', changelog: '## [Unreleased]\n\n### Added\n\n- New.\n\n## [0.1.1] - x\n\n- Old.\n' });
    const r = spawnSync(process.execPath, [SCRIPT, 'bump', '--root', dir, '--date', '2026-10-20', '--skip-lock'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Prepared v0\.1\.2/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '0.1.2');
    assert.equal(JSON.parse(readFileSync(join(dir, 'cli', 'package.json'), 'utf8')).version, '0.1.2');
    assert.match(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), /## \[Unreleased\]\n\n## \[0\.1\.2\] - 2026-10-20\n\n### Added\n\n- New\./);
  });
  test('a minor bump without the maintainer\'s decision changes nothing', () => {
    const dir = repo({ version: '0.1.1', changelog: '## [Unreleased]\n\n- New.\n' });
    const r = spawnSync(process.execPath, [SCRIPT, 'bump', 'minor', '--root', dir, '--skip-lock'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Normal releases bump the patch only/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '0.1.1');
    assert.equal(git(dir, 'status', '--porcelain'), '');
  });
});
