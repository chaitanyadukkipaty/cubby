// docker/cubby-server upgrade/version and docker/ref.sh checkout, run for real against a local git "origin"
// with releases v0.1.0 and v0.1.1 and a branch. Docker and the network are faked: `docker` records what it was
// asked to do and "runs" the version it built; `curl` answers the GitHub releases API and the server's /api/info.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.dev', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.dev' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

let origin, fakebin;

function commitVersion(version, message) {
  writeFileSync(join(origin, 'package.json'), JSON.stringify({ name: 'cubby', version }));
  writeFileSync(join(origin, 'marker.txt'), `${message}\n`);
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', message);
  return git(origin, 'rev-parse', '--short=7', 'HEAD');
}

before(() => {
  origin = mkdtempSync(join(tmpdir(), 'cubby-origin-'));
  mkdirSync(join(origin, 'docker'));
  copyFileSync(join(ROOT, 'docker/ref.sh'), join(origin, 'docker/ref.sh'));
  copyFileSync(join(ROOT, 'docker/cubby-server'), join(origin, 'docker/cubby-server'));
  git(origin, 'init', '-q', '-b', 'main');
  commitVersion('0.1.0', 'first');
  git(origin, 'tag', 'v0.1.0');
  commitVersion('0.1.1', 'second');
  git(origin, 'tag', 'v0.1.1');
  git(origin, 'checkout', '-q', '-b', 'feat/x');
  commitVersion('0.1.1', 'feature');
  git(origin, 'checkout', '-q', 'main');

  fakebin = mkdtempSync(join(tmpdir(), 'cubby-fakes-'));
  // docker: log calls; `build` records the version the image would report; `run` makes it the running one.
  writeFileSync(join(fakebin, 'docker'), `#!/bin/bash
echo "docker $*" >> "$STATE/log"
case "$1" in
  ps) echo abc123 ;;
  exec) [[ "$FAKE_BACKUP_FAIL" == 1 ]] && exit 1; echo "backup ok" ;;
  build)
    commit=""; tag=""; for a in "$@"; do case "$a" in CUBBY_COMMIT=*) commit="\${a#*=}";; CUBBY_TAG=*) tag="\${a#*=}";; esac; done
    src="\${@: -1}"; v="$(sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p' "$src/package.json")"
    if [[ "$tag" == "v$v" ]]; then echo "$v" > "$STATE/built"; else echo "$v-dev+$commit" > "$STATE/built"; fi
    echo "$commit" > "$STATE/built-commit" ;;
  run) cp "$STATE/built" "$STATE/running"; cp "$STATE/built-commit" "$STATE/running-commit" ;;
esac
exit 0
`);
  // curl: GitHub's latest release, or the running server's /api/info.
  writeFileSync(join(fakebin, 'curl'), `#!/bin/bash
if [[ "$*" == *"/api/info"* ]]; then
  [[ -f "$STATE/running" ]] || exit 7
  printf '{"name":"x","version":"%s","commit":"%s"}' "$(cat "$STATE/running")" "$(cat "$STATE/running-commit" 2>/dev/null)"
elif [[ "$*" == *"releases/latest"* ]]; then
  printf '{"tag_name":"%s"}' "\${FAKE_LATEST:-v0.1.1}"
else exit 22; fi
`);
  chmodSync(join(fakebin, 'docker'), 0o755);
  chmodSync(join(fakebin, 'curl'), 0o755);
});

function install(ref, channel, runningVersion) {
  const home = mkdtempSync(join(tmpdir(), 'cubby-home-'));
  const state = join(home, 'state');
  mkdirSync(state);
  const env = baseEnv(home, state);
  const r = spawnSync('bash', ['-c', `source "${join(ROOT, 'docker/ref.sh')}" && cubby_checkout "$CUBBY_HOME/src" "${ref}"`], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  writeFileSync(join(home, 'cubby.env'), `BASE_DOMAIN=example.test\nPUBLIC_URL=http://example.test\nCUBBY_INSTALL_CHANNEL=${channel}\nCUBBY_INSTALL_REF=${ref}\n`);
  mkdirSync(join(home, 'bin'));
  copyFileSync(join(home, 'src/docker/cubby-server'), join(home, 'bin/cubby-server'));
  writeFileSync(join(state, 'running'), `${runningVersion}\n`);
  writeFileSync(join(state, 'log'), '');
  return { home, state, env };
}

function baseEnv(home, state) {
  return {
    ...gitEnv,
    PATH: `${fakebin}:${process.env.PATH}`, HOME: home, STATE: state, CUBBY_HOME: home, CUBBY_BIN: join(home, 'bin/cubby-server'),
    CUBBY_REPO: origin, CUBBY_RELEASES_API: 'https://api.example/releases', CUBBY_TEST_NONROOT: '1', CUBBY_HEALTH_SLEEP: '0', CUBBY_HEALTH_TRIES: '3',
  };
}

function cubbyServer(inst, args, extraEnv = {}) {
  const env = { ...inst.env, ...extraEnv };
  // Safety: these tests must never reach a real docker or curl (a real `cubby` container may be running).
  for (const tool of ['docker', 'curl']) {
    const found = spawnSync('bash', ['-c', `command -v ${tool}`], { env, encoding: 'utf8' }).stdout.trim();
    assert.equal(found, join(fakebin, tool), `${tool} must resolve to the fake`);
  }
  const r = spawnSync('bash', [join(inst.home, 'bin/cubby-server'), ...args], { env, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const envFile = (inst) => readFileSync(join(inst.home, 'cubby.env'), 'utf8');
const srcVersion = (inst) => JSON.parse(readFileSync(join(inst.home, 'src/package.json'), 'utf8')).version;

describe('ref.sh checkout and build info', () => {
  test('a release tag checks out as a release build', () => {
    const inst = install('v0.1.0', 'release', '0.1.0');
    assert.equal(srcVersion(inst), '0.1.0');
    const info = spawnSync('bash', ['-c', `source "${join(ROOT, 'docker/ref.sh')}" && cubby_build_info "$CUBBY_HOME/src"`], { env: inst.env, encoding: 'utf8' }).stdout.trim();
    assert.equal(info, `${git(origin, 'rev-parse', '--short=7', 'v0.1.0')} v0.1.0`);
  });
  test('a branch or a commit has no release tag', () => {
    const inst = install('feat/x', 'ref', '0.1.1-dev+x');
    const info = spawnSync('bash', ['-c', `source "${join(ROOT, 'docker/ref.sh')}" && cubby_build_info "$CUBBY_HOME/src"`], { env: inst.env, encoding: 'utf8' }).stdout.trim();
    assert.equal(info, `${git(origin, 'rev-parse', '--short=7', 'feat/x')} `.trim());
    const sha = git(origin, 'rev-parse', 'v0.1.0');
    const bySha = install(sha, 'ref', '0.1.0');
    assert.equal(srcVersion(bySha), '0.1.0');
  });
  test('an unknown ref fails without touching the checkout', () => {
    const inst = install('v0.1.0', 'release', '0.1.0');
    const r = spawnSync('bash', ['-c', `source "${join(ROOT, 'docker/ref.sh')}" && cubby_checkout "$CUBBY_HOME/src" nope`], { env: inst.env, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Couldn't fetch "nope"/);
    assert.equal(srcVersion(inst), '0.1.0');
  });
});

describe('cubby-server upgrade', () => {
  test('on the release channel: backs up, moves to the latest release, records it, installs its own new copy', () => {
    const inst = install('v0.1.0', 'release', '0.1.0');
    writeFileSync(join(inst.home, 'bin/cubby-server'), readFileSync(join(inst.home, 'bin/cubby-server'), 'utf8') + '\n# old copy\n');
    const r = cubbyServer(inst, ['upgrade']);
    assert.equal(r.status, 0, r.err + r.out);
    assert.match(r.out, /Backing up before upgrading/);
    assert.match(r.out, /Upgraded Cubby 0\.1\.0 → 0\.1\.1 \(v0\.1\.1\)/);
    assert.equal(srcVersion(inst), '0.1.1');
    assert.match(envFile(inst), /CUBBY_INSTALL_CHANNEL=release\nCUBBY_INSTALL_REF=v0\.1\.1\n/);
    const log = readFileSync(join(inst.state, 'log'), 'utf8');
    assert.match(log, /docker exec cubby node \/app\/server\/src\/admin-tasks\.js backup/);
    assert.match(log, /--build-arg CUBBY_TAG=v0\.1\.1/);
    assert.ok(log.indexOf('exec') < log.indexOf('build'), 'backup before build');
    assert.doesNotMatch(readFileSync(join(inst.home, 'bin/cubby-server'), 'utf8'), /# old copy/, 'replaced with the new version\'s script');
  });

  test('already on the latest release: nothing to do', () => {
    const inst = install('v0.1.1', 'release', '0.1.1');
    const r = cubbyServer(inst, ['upgrade']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /Already on Cubby 0\.1\.1 \(v0\.1\.1\)/);
    assert.doesNotMatch(readFileSync(join(inst.state, 'log'), 'utf8'), /build/);
  });

  test('--version pins or rolls back; a missing version changes nothing', () => {
    const inst = install('v0.1.1', 'release', '0.1.1');
    const back = cubbyServer(inst, ['upgrade', '--version', '0.1.0', '--no-backup']);
    assert.equal(back.status, 0, back.err);
    assert.match(back.out, /Upgraded Cubby 0\.1\.1 → 0\.1\.0 \(v0\.1\.0\)/);
    assert.doesNotMatch(readFileSync(join(inst.state, 'log'), 'utf8'), /exec/, '--no-backup skips the backup');
    const missing = cubbyServer(inst, ['upgrade', '--version', '0.9.9']);
    assert.equal(missing.status, 1);
    assert.match(missing.err, /Cubby 0\.9\.9 doesn't exist/);
    assert.equal(srcVersion(inst), '0.1.0');
    assert.match(envFile(inst), /CUBBY_INSTALL_REF=v0\.1\.0/);
  });

  test('--ref switches to a branch, reports a dev version, and later upgrades follow that branch', () => {
    const inst = install('v0.1.1', 'release', '0.1.1');
    const r = cubbyServer(inst, ['upgrade', '--ref', 'feat/x']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /note: "feat\/x" is not a release/);
    const sha = git(origin, 'rev-parse', '--short=7', 'feat/x');
    assert.match(r.out, new RegExp(`Upgraded Cubby 0\\.1\\.1 → 0\\.1\\.1-dev\\+${sha} \\(feat/x\\)`));
    assert.match(envFile(inst), /CUBBY_INSTALL_CHANNEL=ref\nCUBBY_INSTALL_REF=feat\/x\n/);

    git(origin, 'checkout', '-q', 'feat/x');
    const sha2 = commitVersion('0.1.1', 'feature 2');
    git(origin, 'checkout', '-q', 'main');
    const follow = cubbyServer(inst, ['upgrade', '--no-backup']);
    assert.equal(follow.status, 0, follow.err);
    assert.match(follow.out, new RegExp(`→ 0\\.1\\.1-dev\\+${sha2} \\(feat/x\\)`));
  });

  test('a failed backup aborts and leaves the code where it was', () => {
    const inst = install('v0.1.0', 'release', '0.1.0');
    const r = cubbyServer(inst, ['upgrade'], { FAKE_BACKUP_FAIL: '1' });
    assert.equal(r.status, 1);
    assert.match(r.err, /backup failed, so nothing was changed/);
    assert.equal(srcVersion(inst), '0.1.0');
    assert.match(envFile(inst), /CUBBY_INSTALL_REF=v0\.1\.0/);
    assert.doesNotMatch(readFileSync(join(inst.state, 'log'), 'utf8'), /build/);
  });

  test('installs from before channels existed follow main', () => {
    const inst = install('main', 'ref', '0.1.1');
    writeFileSync(join(inst.home, 'cubby.env'), 'BASE_DOMAIN=example.test\n');
    const r = cubbyServer(inst, ['version']);
    assert.match(r.out, /Follows:\s+ref main/);
  });
});

describe('cubby-server version', () => {
  test('shows what runs, what it follows, and an available update', () => {
    const inst = install('v0.1.0', 'release', '0.1.0');
    writeFileSync(join(inst.state, 'running-commit'), 'abc1234');
    const r = cubbyServer(inst, ['version']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /Running:\s+0\.1\.0\nCommit:\s+abc1234\nFollows:\s+release v0\.1\.0\nLatest:\s+v0\.1\.1 \(update available: sudo cubby-server upgrade\)/);
    const current = cubbyServer(inst, ['version'], { FAKE_LATEST: 'v0.1.0' });
    assert.match(current.out, /Latest:\s+v0\.1\.0\n/);
  });
  test('unknown flags and non-root use are refused', () => {
    const inst = install('v0.1.0', 'release', '0.1.0');
    assert.match(cubbyServer(inst, ['upgrade', '--bogus']).err, /unknown option --bogus/);
    const r = spawnSync('bash', [join(inst.home, 'bin/cubby-server'), 'version'], { env: { ...inst.env, CUBBY_TEST_NONROOT: '' }, encoding: 'utf8' });
    if (process.getuid?.() !== 0) assert.match(r.stderr, /Run with sudo/);
    assert.ok(existsSync(join(inst.home, 'cubby.env')));
  });
});
