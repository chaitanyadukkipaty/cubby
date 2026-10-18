// docker/fail2ban/filter.d: which Caddy access-log lines count against an IP. The lines are in the exact shape Caddy
// 2.11 writes with the log block in docker/entrypoint.sh. fail2ban's regexes are Python; these filters stick to syntax
// that means the same in JavaScript, and <HOST> stands in for fail2ban's address pattern.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve(import.meta.dirname, '../../docker/fail2ban/filter.d');

function filter(name) {
  const text = readFileSync(resolve(DIR, `${name}.conf`), 'utf8');
  // fail2ban reads .conf files with Python's configparser, where a literal % is written %%.
  const lines = [...text.matchAll(/^failregex\s*=\s*(.+)$/gm)].map((m) => m[1].trim().replaceAll('%%', '%'));
  assert.ok(lines.length > 0, `${name} has a failregex`);
  // A leading (?i) is Python's case-insensitive flag; JavaScript takes it as a flag instead.
  const res = lines.map((l) => {
    const flags = l.startsWith('(?i)') ? 'i' : '';
    return new RegExp(l.replace(/^\(\?i\)/, '').replaceAll('<HOST>', '(?<host>[0-9A-Fa-f.:]+)'), flags);
  });
  // The IP fail2ban would ban for this line, or null.
  return (line) => {
    for (const re of res) {
      const m = re.exec(line);
      if (m) return m.groups.host;
    }
    return null;
  };
}

const line = (uri, { ip = '203.0.113.9', status = 404 } = {}) =>
  `{"level":"info","ts":"2026-10-18T18:37:05Z","logger":"http.log.access.log0","msg":"handled request","request":{"remote_ip":"${ip}","remote_port":"45988","client_ip":"${ip}","proto":"HTTP/1.1","method":"GET","host":"notes.cubby.example","uri":${JSON.stringify(uri)}},"bytes_read":0,"user_id":"","duration":0.000222601,"size":2,"status":${status}}`;

describe('cubby-probe: requests only a vulnerability scanner makes', () => {
  const probe = filter('cubby-probe');

  for (const uri of [
    '/.env', '/.env.production', '/api/.env', '/.git/config', '/.git/HEAD', '/.aws/credentials', '/.ssh/id_rsa',
    '/.DS_Store', '/.svn/entries', '/.htaccess', '/.vscode/sftp.json',
    '/wp-login.php', '/WP-LOGIN.PHP', '/wp-admin/', '/blog/wp-includes/wlwmanifest.xml', '/wp-content/plugins/x/readme.txt',
    '/index.php', '/shell.php?cmd=id', '/admin/config.php5', '/xmlrpc.php', '/phpmyadmin/', '/pma/index', '/cgi-bin/luci',
    '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php', '/actuator/env', '/actuator', '/server-status', '/boaform/admin/formLogin',
    '/HNAP1/', '/.s3cfg', '/.docker/laravel/app/.env', '/_profiler/phpinfo', '/admin/.env', '/.hg/dirstate', '/.aws/config',
    '/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/a/%2E%2E/b',
  ]) {
    test(`bans on ${uri}`, () => assert.equal(probe(line(uri)), '203.0.113.9'));
  }

  for (const uri of [
    '/', '/assets/index-3f9a1c.js', '/__cubby/config.js', '/pb/api/collections/notes/records?filter=(title~%27.env%27)',
    '/api/login', '/envelope', '/environments/prod', '/.well-known/acme-challenge/abc', '/.well-known/security.txt',
    '/git-guide', '/github', '/docs.md', '/cli.tgz', '/search?q=wp-login.php', '/notes?file=index.php',
    '/papers/actuators', '/wp', '/a.phpx', '/a..b/c',
  ]) {
    test(`leaves ${uri} alone`, () => assert.equal(probe(line(uri)), null));
  }

  test('bans the client address, also for IPv6', () => {
    assert.equal(probe(line('/.env', { ip: '2001:db8::7' })), '2001:db8::7');
  });

  test('a URI that mimics a log field cannot pick the banned address', () => {
    // Caddy escapes quotes in the URI, so a forged "client_ip" never lines up with the real field.
    assert.notEqual(probe(line('/x","client_ip":"198.51.100.1","uri":"/.env')), '198.51.100.1');
  });
});

describe('cubby-ratelimit: hitting the login rate limit', () => {
  const limited = filter('cubby-ratelimit');

  test('counts 429 responses', () => assert.equal(limited(line('/api/login', { status: 429 })), '203.0.113.9'));
  test('ignores everything else', () => {
    for (const status of [200, 401, 404, 4290, 500]) assert.equal(limited(line('/api/login', { status })), null);
  });
  test('a URI containing the text of a 429 does not count', () => {
    assert.equal(limited(line('/x"status":429', { status: 200 })), null);
  });
});
