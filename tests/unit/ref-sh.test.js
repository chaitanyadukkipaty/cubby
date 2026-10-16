// docker/ref.sh (sourced by install.sh and cubby-server): which code to install, and which host ports are free.
// Runs real bash with fake `curl` (GitHub's releases API), `git` (ls-remote), `docker` and `ss` first on PATH, so
// there's no network and no real container or port is looked at.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
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
  // docker ps / docker port <name>: print FAKE_DOCKER_PS / FAKE_DOCKER_PORT (\n-separated lines).
  writeFileSync(join(bin, 'docker'), '#!/bin/bash\ncase "$1" in ps) printf "%b" "$FAKE_DOCKER_PS" ;; port) printf "%b" "$FAKE_DOCKER_PORT" ;; esac\n');
  // ss -Hltnp "sport = :<port>": a listener line for each "<port>=<process>" in FAKE_SS.
  writeFileSync(join(bin, 'ss'), '#!/bin/bash\nport="${@: -1}"; port="${port##*:}"\nfor e in $FAKE_SS; do [[ "${e%%=*}" == "$port" ]] && echo "LISTEN 0 511 0.0.0.0:$port 0.0.0.0:* users:((\\"${e#*=}\\",pid=1,fd=6))"; done; exit 0\n');
  for (const tool of ['curl', 'git', 'docker', 'ss']) chmodSync(join(bin, tool), 0o755);
});

function sh(script, env = {}) {
  const log = join(bin, `log-${Math.random()}`);
  writeFileSync(log, '');
  const r = spawnSync('bash', ['-c', `source "${REF_SH}"\n${script}`], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_LOG: log, FAKE_TAGS: 'v0.1.0 v0.1.1', FAKE_RELEASE_JSON: '', FAKE_CURL_FAIL: '0',
      FAKE_SS: '', FAKE_DOCKER_PS: '', FAKE_DOCKER_PORT: '', ...env },
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

describe('cubby_port_holder / cubby_free_port', () => {
  const holder = (port, ours, env) => sh(`cubby_port_holder ${port} ${ours}`, env).out;
  test('names the process listening on a port; a free port prints nothing', () => {
    assert.equal(holder(80, '', { FAKE_SS: '80=nginx 443=nginx' }), 'nginx');
    assert.equal(holder(8080, '', { FAKE_SS: '80=nginx' }), '');
  });
  test('names the container publishing a port', () => {
    const env = { FAKE_DOCKER_PS: 'web|0.0.0.0:8088->80/tcp, [::]:8088->80/tcp\\nother|443/tcp', FAKE_SS: '8088=docker-proxy' };
    assert.equal(holder(8088, '', env), 'container web');
    assert.equal(holder(80, '', env), '', 'only the host side of a mapping counts');
  });
  test('ports held by our own container count as free', () => {
    const env = { FAKE_DOCKER_PS: 'cubby|0.0.0.0:8080->80/tcp', FAKE_DOCKER_PORT: '80/tcp -> 0.0.0.0:8080\\n80/tcp -> [::]:8080', FAKE_SS: '8080=docker-proxy' };
    assert.equal(holder(8080, 'cubby', env), '');
    assert.equal(holder(8080, '', env), 'container cubby');
    assert.equal(holder(80, 'cubby', { ...env, FAKE_SS: '80=apache2' }), 'apache2');
  });
  test('works under set -euo pipefail, as install.sh and cubby-server run it', () => {
    const r = sh('set -euo pipefail; h="$(cubby_port_holder 8080 cubby)"; echo "free:$h"', { FAKE_DOCKER_PS: 'x|1/tcp' });
    assert.equal(r.out, 'free:');
  });
  test('without ss or docker, probes the port by connecting', async () => {
    const server = createServer().listen(0, '127.0.0.1');
    await new Promise((ok) => server.once('listening', ok));
    const { port } = server.address();
    const empty = join(bin, 'empty');
    mkdirSync(empty, { recursive: true });
    const probe = (p) => spawnSync('/bin/bash', ['-c', `source "${REF_SH}"; cubby_port_holder ${p}`], { encoding: 'utf8', env: { PATH: empty } }).stdout.trim();
    try {
      assert.equal(probe(port), 'another process');
    } finally {
      server.close();
    }
    assert.equal(probe(port), '');
  });
  test('the first free port in a range, skipping the given ones', () => {
    assert.equal(sh('cubby_free_port 8080 8099', { FAKE_SS: '8080=nginx 8081=node' }).out, '8082');
    assert.equal(sh('cubby_free_port 8089 8099 8090', { FAKE_SS: '8089=nginx' }).out, '8091');
    assert.equal(sh('cubby_free_port 8080 8081 || echo none', { FAKE_SS: '8080=a 8081=b' }).out, 'none');
  });
});
