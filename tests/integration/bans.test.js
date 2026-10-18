// The Security tab's API (/api/admin/bans) against a real server and PocketBase, with the host faked: the test writes
// fail2ban's event files and Caddy's access log into the shared folder, and answers unban requests like the host's
// systemd unit would.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, ADMIN } from '../helpers/server.js';
import { api, signup, adminToken } from '../helpers/integration.js';

let srv, off, adminCall, user, dir, accessLog;
const now = () => Math.floor(Date.now() / 1000);
let n = 0;
// Like the host: written in tmp/, then moved into events/.
function hostEvent(e) {
  const name = `${Date.now()}-${++n}.json`;
  writeFileSync(join(dir, 'tmp', name), JSON.stringify(e));
  renameSync(join(dir, 'tmp', name), join(dir, 'events', name));
}
const logLine = (ip, host, uri) => JSON.stringify({ level: 'info', ts: new Date().toISOString(), logger: 'http.log.access.log0', msg: 'handled request',
  request: { remote_ip: ip, remote_port: '1', client_ip: ip, proto: 'HTTP/1.1', method: 'GET', host, uri }, bytes_read: 0, user_id: '', duration: 0.001, size: 0, status: 404 });

// Answers unban requests: ok for IPs in `banned`, a refusal otherwise; records what it was asked.
function fakeHost(banned) {
  const asked = [];
  const timer = setInterval(() => {
    for (const name of readdirSync(join(dir, 'requests'))) {
      const req = JSON.parse(readFileSync(join(dir, 'requests', name), 'utf8'));
      rmSync(join(dir, 'requests', name));
      asked.push(req);
      const res = banned.includes(req.ip) ? { id: req.id, ok: true } : { id: req.id, ok: false, error: `${req.ip} is not banned` };
      writeFileSync(join(dir, 'tmp', `${req.id}.json`), JSON.stringify(res));
      renameSync(join(dir, 'tmp', `${req.id}.json`), join(dir, 'results', `${req.id}.json`));
    }
  }, 20);
  return { asked, stop: () => clearInterval(timer) };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cubby-f2b-'));
  for (const d of ['tmp', 'events', 'requests', 'results']) mkdirSync(join(dir, d));
  accessLog = join(mkdtempSync(join(tmpdir(), 'cubby-log-')), 'access.log');
  [srv, off] = await Promise.all([startServer({ CUBBY_FAIL2BAN_DIR: dir, CUBBY_ACCESS_LOG: accessLog }), startServer()]);
  adminCall = api(srv.url, await adminToken(srv.url, ADMIN));
  user = api(srv.url, await signup(srv.url, 'bans-user@test.dev'));
});
after(() => Promise.all([srv?.stop(), off?.stop()]));

describe('/api/admin/bans', () => {
  test('admins only', async () => {
    assert.equal((await user('GET', '/api/admin/bans')).status, 403);
    assert.equal((await user('POST', '/api/admin/bans/203.0.113.9/unban')).status, 403);
  });

  test('a probe ban shows with the hosts and paths the IP swept', async () => {
    writeFileSync(accessLog, [
      logLine('203.0.113.9', 'todo.example.test', '/.env'),
      logLine('203.0.113.9', 'chat.example.test', '/.git/config'),
      logLine('198.51.100.1', 'chat.example.test', '/'),
    ].join('\n') + '\n');
    hostEvent({ event: 'ban', ip: '203.0.113.9', jail: 'cubby-probe', time: now(), bantime: 600 });
    const r = await adminCall('GET', '/api/admin/bans');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.enabled, true);
    const b = r.data.current.find((x) => x.ip === '203.0.113.9');
    assert.equal(b.reason, 'Scanning for secret files');
    assert.deepEqual(b.hosts, ['todo.example.test', 'chat.example.test']);
    assert.deepEqual(b.paths, ['/.env', '/.git/config']);
    assert.deepEqual(readdirSync(join(dir, 'events')), []);
  });

  test('events are picked up in the background too', async () => {
    hostEvent({ event: 'ban', ip: '198.51.100.20', jail: 'cubby-ratelimit', time: now(), bantime: 3600 });
    for (let i = 0; i < 100 && readdirSync(join(dir, 'events')).length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(readdirSync(join(dir, 'events')), []);
  });

  test('unban: the host lifts it, the ban moves to history and the activity feed says who', async () => {
    hostEvent({ event: 'ban', ip: '2001:db8::7', jail: 'cubby-probe', time: now(), bantime: 600 });
    const host = fakeHost(['2001:db8::7']);
    let r;
    try { r = await adminCall('POST', `/api/admin/bans/${encodeURIComponent('2001:db8::7')}/unban`); } finally { host.stop(); }
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data, { ok: true, ip: '2001:db8::7', jails: ['cubby-probe'] });
    assert.deepEqual(host.asked.map((q) => [q.action, q.ip]), [['unban', '2001:db8::7']]);
    const list = (await adminCall('GET', '/api/admin/bans')).data;
    assert.ok(!list.current.some((b) => b.ip === '2001:db8::7'));
    assert.equal(list.history.find((b) => b.ip === '2001:db8::7').unbanned_by, `admin ${ADMIN.email}`);
    const activity = (await adminCall('GET', '/api/admin/activity')).data;
    assert.ok(activity.some((a) => a.action === 'admin.ban.unban' && a.summary === 'Unbanned 2001:db8::7 (cubby-probe)'), JSON.stringify(activity.slice(0, 3)));
  });

  test('the host refusing, an IP that isn\'t banned and a non-IP are errors', async () => {
    hostEvent({ event: 'ban', ip: '192.0.2.50', jail: 'cubby-probe', time: now(), bantime: 600 });
    const host = fakeHost([]);
    try {
      const refused = await adminCall('POST', '/api/admin/bans/192.0.2.50/unban');
      assert.equal(refused.status, 422);
      assert.equal(refused.data.error, '192.0.2.50 is not banned');
    } finally { host.stop(); }
    assert.equal((await adminCall('POST', '/api/admin/bans/192.0.2.99/unban')).status, 404);
    assert.equal((await adminCall('POST', '/api/admin/bans/not-an-ip/unban')).status, 400);
  });

  test('with fail2ban off: nothing to show, and unbanning says how to turn it on', async () => {
    const offAdmin = api(off.url, await adminToken(off.url, ADMIN));
    assert.deepEqual((await offAdmin('GET', '/api/admin/bans')).data, { enabled: false, current: [], history: [] });
    const r = await offAdmin('POST', '/api/admin/bans/203.0.113.9/unban');
    assert.equal(r.status, 409);
    assert.match(r.data.error, /sudo cubby-server fail2ban enable/);
  });
});
