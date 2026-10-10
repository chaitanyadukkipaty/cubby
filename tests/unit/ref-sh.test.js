// docker/ref.sh (sourced by install.sh and cubby-server): which code to install. Runs real bash with fake
// `curl` (GitHub's releases API) and `git` (ls-remote) first on PATH, so there's no network.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REF_SH = resolve(import.meta.dirname, '../../docker/ref.sh');
let bin;

before(() => {
  bin = mkdtempSync(join(tmpdir(), 'cubby-fakebin-'));
  // curl: prints FAKE_RELEASE_JSON, or fails like curl -f on an HTTP error when FAKE_CURL_FAIL=1.
  writeFileSync(join(bin, 'curl'), '#!/bin/bash\necho "$*" >> "$FAKE_LOG"\n[[ "$FAKE_CURL_FAIL" == 1 ]] && exit 22\nprintf "%s" "$FAKE_RELEASE_JSON"\n');
  // git ls-remote --exit-code --tags <repo> refs/tags/<tag>: succeeds for tags listed in FAKE_TAGS.
  writeFileSync(join(bin, 'git'), '#!/bin/bash\nfor t in $FAKE_TAGS; do [[ "$*" == *"refs/tags/$t" ]] && exit 0; done\nexit 2\n');
  chmodSync(join(bin, 'curl'), 0o755);
  chmodSync(join(bin, 'git'), 0o755);
});

function sh(script, env = {}) {
  const log = join(bin, `log-${Math.random()}`);
  writeFileSync(log, '');
  const r = spawnSync('bash', ['-c', `source "${REF_SH}"\n${script}`], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_LOG: log, FAKE_TAGS: 'v0.1.0 v0.1.1', FAKE_RELEASE_JSON: '', FAKE_CURL_FAIL: '0', ...env },
  });
  return { ...r, out: r.stdout.trim(), err: r.stderr.trim() };
}
const resolveWith = (version, ref, env) =>
  sh(`cubby_resolve "${version}" "${ref}"; echo "rc=$?|$CUBBY_TARGET_REF|$CUBBY_TARGET_CHANNEL|$CUBBY_TARGET_NOTE"`, env);

const PRETTY = '{\n  "url": "x",\n  "tag_name": "v0.1.1",\n  "name": "v0.1.1"\n}';

describe('cubby_resolve', () => {
  test('default: the latest release, from GitHub\'s releases API', () => {
    const r = resolveWith('', '', { FAKE_RELEASE_JSON: PRETTY });
    assert.equal(r.out, 'rc=0|v0.1.1|release|');
  });
  test('the API answer can be on one line too', () => {
    assert.equal(resolveWith('', '', { FAKE_RELEASE_JSON: '{"id":1,"tag_name":"v0.1.2","draft":false}' }).out, 'rc=0|v0.1.2|release|');
  });
  test('no releases or GitHub unreachable: main, with a clear note, still on the release channel', () => {
    for (const env of [{ FAKE_CURL_FAIL: '1' }, { FAKE_RELEASE_JSON: '{"message":"Not Found"}' }]) {
      const r = resolveWith('', '', env);
      assert.match(r.out, /^rc=0\|main\|release\|No Cubby release found/);
    }
  });
  test('--version picks that release (with or without the v)', () => {
    assert.equal(resolveWith('0.1.0', '').out, 'rc=0|v0.1.0|release|');
    assert.equal(resolveWith('v0.1.1', '').out, 'rc=0|v0.1.1|release|');
  });
  test('--version that does not exist fails clearly', () => {
    const r = resolveWith('0.9.9', '');
    assert.match(r.out, /^rc=1\|\|\|$/);
    assert.match(r.err, /Cubby 0\.9\.9 doesn't exist \(no v0\.9\.9 release\)/);
  });
  test('--version must look like X.Y.Z', () => {
    for (const bad of ['0.1', 'latest', '0.1.1-dev', 'main']) {
      const r = resolveWith(bad, '');
      assert.match(r.out, /^rc=1/, bad);
      assert.match(r.err, /isn't a release version/, bad);
    }
  });
  test('--ref installs any ref on the ref channel, with a warning', () => {
    const r = resolveWith('', 'feat/try-this');
    assert.match(r.out, /^rc=0\|feat\/try-this\|ref\|"feat\/try-this" is not a release/);
  });
  test('--version and --ref together are refused', () => {
    const r = resolveWith('0.1.1', 'main');
    assert.match(r.out, /^rc=1/);
    assert.match(r.err, /either --version or --ref/);
  });
  test('only the latest-release lookup touches the API', () => {
    const r = sh('cubby_resolve "" "x"; cat "$FAKE_LOG"', { FAKE_RELEASE_JSON: PRETTY });
    assert.equal(r.out, '');
    const r2 = sh('cubby_resolve "" ""; cat "$FAKE_LOG"', { FAKE_RELEASE_JSON: PRETTY });
    assert.match(r2.out, /releases\/latest/);
  });
});

describe('cubby_newer / cubby_version_core', () => {
  const newer = (a, b) => sh(`cubby_newer "${a}" "${b}" && echo yes || echo no`).out;
  test('compares X.Y.Z numerically', () => {
    assert.equal(newer('v0.1.10', '0.1.9'), 'yes');
    assert.equal(newer('v0.2.0', '0.1.9'), 'yes');
    assert.equal(newer('v0.1.1', '0.1.1'), 'no');
    assert.equal(newer('v0.1.0', '0.1.1'), 'no');
  });
  test('dev builds compare by their base', () => {
    assert.equal(newer('v0.1.1', '0.1.1-dev+abc1234'), 'no');
    assert.equal(newer('v0.1.2', '0.1.1-dev+abc1234'), 'yes');
  });
  test('non-versions are never newer', () => {
    assert.equal(newer('main', '0.1.1'), 'no');
    assert.equal(newer('v0.1.2', ''), 'no');
  });
  test('version core strips v and suffixes', () => {
    assert.equal(sh('cubby_version_core v0.1.2-dev+abc').out, '0.1.2');
    assert.equal(sh('cubby_version_core banana || echo none').out, 'none');
  });
});
