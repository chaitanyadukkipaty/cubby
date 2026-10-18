// docker/entrypoint.sh: the Caddyfile it writes. Runs real bash with fake `node` and `caddy` first on PATH; the fake
// caddy keeps a copy of the config it was started with.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ENTRYPOINT = resolve(import.meta.dirname, '../../docker/entrypoint.sh');
let bin;

before(() => {
  bin = mkdtempSync(join(tmpdir(), 'cubby-entry-'));
  writeFileSync(join(bin, 'node'), '#!/bin/bash\nexit 0\n');
  writeFileSync(join(bin, 'caddy'), '#!/bin/bash\ncp "$3" "$OUT"\nexit 0\n');
  for (const tool of ['node', 'caddy']) chmodSync(join(bin, tool), 0o755);
});

function caddyfile(env) {
  const out = join(mkdtempSync(join(tmpdir(), 'cubby-caddy-')), 'Caddyfile');
  const r = spawnSync('bash', [ENTRYPOINT], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OUT: out, CUBBY_CADDYFILE: `${out}.src`, BASE_DOMAIN: 'x.test', PUBLIC_URL: 'http://x.test', ...env },
    encoding: 'utf8',
  });
  // Not r.status: macOS's bash 3.2 has no `wait -n`, which runs only after Caddy has started.
  assert.ok(existsSync(out), r.stderr);
  return readFileSync(out, 'utf8');
}

test('no access log unless fail2ban asked for one: visitor IPs are not written to disk by default', () => {
  for (const https of ['0', '1']) assert.doesNotMatch(caddyfile({ CUBBY_HTTPS: https }), /\blog\b/);
});

test('with CUBBY_ACCESS_LOG, Caddy writes JSON lines without headers or tokens, kept 7 days', () => {
  for (const https of ['0', '1']) {
    const conf = caddyfile({ CUBBY_HTTPS: https, CUBBY_ACCESS_LOG: '/var/log/cubby/access.log' });
    assert.match(conf, /output file \/var\/log\/cubby\/access\.log \{\n\s+roll_size 10MiB\n\s+roll_keep 5\n\s+roll_keep_for 168h\n/);
    assert.match(conf, /wrap json \{\n\s+time_format rfc3339\n/);
    assert.match(conf, /request>headers delete\n\s+resp_headers delete\n\s+request>uri query \{\n\s+delete token\n/);
  }
});
