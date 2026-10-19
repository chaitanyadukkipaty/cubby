// server/src/bans.js: fail2ban's ban events (files the host writes), the IPs' sweeps from the access log, the 90-day
// records behind the Security tab, and unban requests answered by the host. Files in a temp dir; records in memory.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEvent, createBans, bansStore, BANS_COLLECTION } from '../../server/src/bans.js';
import { fakePocketBase } from '../helpers/fake-pocketbase.js';

// The real store over an in-memory PocketBase with the cubby_bans collection.
async function banRecords() {
  const pb = fakePocketBase();
  await pb.collections.create(BANS_COLLECTION);
  return { pb, store: bansStore(pb) };
}

const T0 = 1792348605; // unix seconds
const iso = (s) => new Date(s * 1000).toISOString();

// A host folder with events/, requests/ and results/, and bans over it with a clock set to `at` (unix seconds).
async function setup({ at = T0 + 1, accessLog } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cubby-f2b-'));
  for (const d of ['tmp', 'events', 'requests', 'results']) mkdirSync(join(dir, d));
  const clock = { at };
  const errors = [];
  const { pb, store } = await banRecords();
  const bans = createBans({ dir, accessLog, store, now: () => new Date(clock.at * 1000), log: { error: (...a) => errors.push(a.join(' ')) } });
  let n = 0;
  const event = (e, name = `${String(++n).padStart(4, '0')}.json`) => writeFileSync(join(dir, 'events', name), typeof e === 'string' ? e : JSON.stringify(e));
  return { dir, clock, errors, store, pb, bans, event, events: () => readdirSync(join(dir, 'events')) };
}
const ban = (o = {}) => ({ event: 'ban', ip: '203.0.113.9', jail: 'cubby-probe', time: T0, bantime: 600, ...o });

describe('parseEvent: host files are untrusted', () => {
  const ok = { event: 'ban', ip: '203.0.113.9', jail: 'cubby-probe', time: 1792348605, bantime: 600 };
  const text = (o) => JSON.stringify(o);

  test('a ban and an unban', () => {
    assert.deepEqual(parseEvent(text(ok)), ok);
    assert.deepEqual(parseEvent(text({ event: 'unban', ip: '2001:db8::7', jail: 'cubby-ratelimit', time: 1792348700 })),
      { event: 'unban', ip: '2001:db8::7', jail: 'cubby-ratelimit', time: 1792348700, bantime: null });
  });
  test('a permanent ban (bantime -1) has no expiry', () => {
    assert.equal(parseEvent(text({ ...ok, bantime: -1 })).bantime, -1);
  });
  test('extra fields are dropped', () => {
    assert.deepEqual(parseEvent(text({ ...ok, cmd: 'rm -rf /' })), ok);
  });
  for (const [why, bad] of [
    ['not JSON', 'nope'],
    ['not an object', '[1]'],
    ['null', 'null'],
    ['unknown event', text({ ...ok, event: 'nuke' })],
    ['not an IP', text({ ...ok, ip: '203.0.113.9; reboot' })],
    ['a hostname', text({ ...ok, ip: 'example.com' })],
    ['a jail that is not Cubby\'s', text({ ...ok, jail: 'sshd' })],
    ['a jail with odd characters', text({ ...ok, jail: 'cubby-x"y' })],
    ['time missing', text({ ...ok, time: undefined })],
    ['time not finite', '{"event":"ban","ip":"203.0.113.9","jail":"cubby-probe","time":1e999,"bantime":600}'],
    ['time a string', text({ ...ok, time: '1792348605' })],
    ['negative time', text({ ...ok, time: -5 })],
    ['ban without bantime', text({ ...ok, bantime: undefined })],
    ['bantime below -1', text({ ...ok, bantime: -2 })],
  ]) {
    test(`rejects ${why}`, () => assert.equal(parseEvent(bad), null));
  }
});

// A fake host: answers each unban request in requests/ with `reply(request)` (a result object, or null for silence).
function fakeHost(dir, reply) {
  const seen = [];
  const timer = setInterval(() => {
    for (const name of readdirSync(join(dir, 'requests'))) {
      const req = JSON.parse(readFileSync(join(dir, 'requests', name), 'utf8'));
      rmSync(join(dir, 'requests', name));
      seen.push({ name, req });
      const res = reply(req);
      if (res) writeFileSync(join(dir, 'results', `${req.id}.json`), JSON.stringify(res));
    }
  }, 10);
  return { seen, stop: () => clearInterval(timer) };
}

describe('unban: a request the host answers', () => {
  const admin = { email: 'admin@test.dev' };

  test('the host unbans, and the IP\'s bans close as lifted by the admin', async () => {
    const { bans, event, dir } = await setup({ at: T0 + 10 });
    event(ban());
    event(ban({ jail: 'cubby-ratelimit' }));
    event(ban({ ip: '198.51.100.4' }));
    const host = fakeHost(dir, (req) => ({ id: req.id, ok: true }));
    try {
      const r = await bans.unban('203.0.113.9', admin);
      assert.deepEqual(r, { ok: true, ip: '203.0.113.9', jails: ['cubby-probe', 'cubby-ratelimit'] });
    } finally { host.stop(); }
    assert.equal(host.seen.length, 1);
    assert.match(host.seen[0].name, /^[a-f0-9]{32}\.json$/);
    assert.deepEqual(host.seen[0].req, { id: host.seen[0].name.slice(0, -5), action: 'unban', ip: '203.0.113.9' });
    assert.deepEqual(readdirSync(join(dir, 'results')), [], 'the answer is removed');
    assert.deepEqual(readdirSync(join(dir, 'tmp')), []);
    const { current, history } = await bans.list();
    assert.deepEqual(current.map((b) => b.ip), ['198.51.100.4']);
    assert.deepEqual(history.map((b) => [b.ip, b.unbanned_by, b.unbanned_at]), [
      ['203.0.113.9', 'admin admin@test.dev', iso(T0 + 10)], ['203.0.113.9', 'admin admin@test.dev', iso(T0 + 10)],
    ]);
    // The host's own unban event arrives afterwards and changes nothing.
    event({ event: 'unban', ip: '203.0.113.9', jail: 'cubby-probe', time: T0 + 11 });
    await bans.ingest();
    assert.equal((await bans.list()).history[0].unbanned_by, 'admin admin@test.dev');
  });
  test('the host\'s unban event landing before its answer still names the admin', async () => {
    const { bans, event, dir } = await setup({ at: T0 + 10 });
    event(ban());
    const host = fakeHost(dir, (req) => {
      event({ event: 'unban', ip: req.ip, jail: 'cubby-probe', time: T0 + 9 });
      return { id: req.id, ok: true };
    });
    try { await bans.unban('203.0.113.9', admin); } finally { host.stop(); }
    const [b] = (await bans.list()).history;
    assert.deepEqual([b.unbanned_by, b.unbanned_at], ['admin admin@test.dev', iso(T0 + 9)]);
  });
  test('the host refusing is a 422 with its reason', async () => {
    const { bans, event, dir } = await setup();
    event(ban());
    const host = fakeHost(dir, (req) => ({ id: req.id, ok: false, error: '203.0.113.9 is not banned' }));
    try {
      await assert.rejects(bans.unban('203.0.113.9', admin), { status: 422, message: '203.0.113.9 is not banned' });
    } finally { host.stop(); }
    assert.equal((await bans.list()).current.length, 1);
  });
  test('an answer that isn\'t a clear yes is a refusal', async () => {
    for (const reply of [(req) => ({ id: req.id }), () => 'garbage']) {
      const { bans, event, dir } = await setup();
      event(ban());
      const timer = setInterval(() => {
        for (const name of readdirSync(join(dir, 'requests'))) {
          const req = JSON.parse(readFileSync(join(dir, 'requests', name), 'utf8'));
          rmSync(join(dir, 'requests', name));
          const res = reply(req);
          writeFileSync(join(dir, 'results', `${req.id}.json`), typeof res === 'string' ? res : JSON.stringify(res));
        }
      }, 10);
      try {
        await assert.rejects(bans.unban('203.0.113.9', admin), { status: 422, message: "The host couldn't unban it" });
      } finally { clearInterval(timer); }
    }
  });
  test('no answer in time is a 504, and the request is withdrawn', async () => {
    const { bans: _, event, dir, store } = await setup();
    const bans = createBans({ dir, store, now: () => new Date((T0 + 1) * 1000), waitMs: 100 });
    event(ban());
    await assert.rejects(bans.unban('203.0.113.9', admin), { status: 504, message: /The host didn't answer\. Check: sudo cubby-server fail2ban status/ });
    assert.deepEqual(readdirSync(join(dir, 'requests')), []);
  });
  test('an IP that isn\'t banned is a 404, without asking the host', async () => {
    const { bans, dir } = await setup();
    await assert.rejects(bans.unban('203.0.113.9', admin), { status: 404 });
    assert.deepEqual(readdirSync(join(dir, 'requests')), []);
  });
  test('not an IP is a 400', async () => {
    const { bans } = await setup();
    await assert.rejects(bans.unban('../../etc', admin), { status: 400 });
  });
  test('fail2ban off: a 409 that says how to turn it on', async () => {
    const bans = createBans({ dir: undefined, store: (await banRecords()).store });
    await assert.rejects(bans.unban('203.0.113.9', admin), { status: 409, message: /sudo cubby-server fail2ban enable/ });
    assert.deepEqual(await bans.list(), { enabled: false, current: [], history: [] });
    assert.equal(await bans.ingest(), 0);
  });
});

describe('prune: records are kept 90 days', () => {
  test('the nightly prune deletes bans from more than 90 days ago, and the list never shows them', async () => {
    const { bans, event, clock, pb } = await setup();
    event(ban({ time: T0 }));
    event(ban({ ip: '198.51.100.4', time: T0 + 10 * 86400 }));
    clock.at = T0 + 10 * 86400 + 60;
    await bans.ingest();
    clock.at = T0 + 91 * 86400;
    assert.deepEqual((await bans.list()).history.map((b) => b.ip), ['198.51.100.4']);
    assert.equal(await bans.prune(), 1);
    assert.deepEqual(pb.records('cubby_bans').map((r) => r.ip), ['198.51.100.4']);
    assert.equal(await bans.prune(), 0);
  });

  test('a permanent ban stays in force and on the list past 90 days, and is pruned 90 days after it began once lifted', async () => {
    const { bans, event, clock, pb } = await setup();
    event(ban({ bantime: -1 }));
    await bans.ingest();
    clock.at = T0 + 200 * 86400;
    assert.equal(await bans.prune(), 0);
    const { current } = await bans.list();
    assert.deepEqual(current.map((b) => [b.ip, b.expires_at]), [['203.0.113.9', null]]);

    event(ban({ event: 'unban', time: clock.at - 60 }));
    await bans.ingest();
    assert.deepEqual(await bans.list(), { enabled: true, current: [], history: [] });
    assert.equal(await bans.prune(), 1);
    assert.deepEqual(pb.records('cubby_bans'), []);
  });
});

describe('ingest: event files become ban records', () => {
  test('a ban is current until it expires; its file is removed', async () => {
    const { bans, event, events } = await setup();
    event(ban());
    await bans.ingest();
    assert.deepEqual(events(), []);
    const { enabled, current, history } = await bans.list();
    assert.equal(enabled, true);
    assert.equal(history.length, 0);
    assert.equal(current.length, 1);
    assert.deepEqual({ ...current[0], id: undefined }, {
      id: undefined, ip: '203.0.113.9', jail: 'cubby-probe', reason: 'Scanning for secret files', banned_at: iso(T0), expires_at: iso(T0 + 600),
      unbanned_at: null, unbanned_by: null, hosts: [], paths: [], seen_before: 0,
    });
  });
  test('bad files are removed and logged, and never stop the good ones', async () => {
    const { bans, event, events, errors } = await setup();
    event('{"event":"ban"');
    event(ban({ jail: 'sshd' }));
    event('x'.repeat(10_000), 'big.json');
    event(ban());
    await bans.ingest();
    assert.deepEqual(events(), []);
    assert.equal((await bans.list()).current.length, 1);
    assert.equal(errors.length, 3);
    assert.match(errors[0], /ignored a bad fail2ban event/);
  });
  test('files still being written (dot names) are left for the next round', async () => {
    const { bans, event, events } = await setup();
    event(ban(), '.0001.json.tmp');
    await bans.ingest();
    assert.deepEqual(events(), ['.0001.json.tmp']);
    assert.equal((await bans.list()).current.length, 0);
  });
  test('an unban when the ban runs out is "expired"; earlier, it was lifted on the server', async () => {
    const { bans, event, clock } = await setup({ at: T0 + 2000 });
    event(ban());
    event({ event: 'unban', ip: '203.0.113.9', jail: 'cubby-probe', time: T0 + 600 });
    event(ban({ ip: '198.51.100.4', time: T0 + 100 }));
    event({ event: 'unban', ip: '198.51.100.4', jail: 'cubby-probe', time: T0 + 200 });
    await bans.ingest();
    const { current, history } = await bans.list();
    assert.equal(current.length, 0);
    assert.deepEqual(history.map((b) => [b.ip, b.unbanned_at, b.unbanned_by]), [
      ['198.51.100.4', iso(T0 + 200), 'on the server (cubby-server or fail2ban)'],
      ['203.0.113.9', iso(T0 + 600), 'expired'],
    ]);
    clock.at = T0 + 3000;
    assert.equal((await bans.list()).history.length, 2);
  });
  test('an unban with no open ban is ignored', async () => {
    const { bans, event, errors } = await setup();
    event({ event: 'unban', ip: '203.0.113.9', jail: 'cubby-probe', time: T0 });
    await bans.ingest();
    assert.deepEqual(await bans.list(), { enabled: true, current: [], history: [] });
    assert.deepEqual(errors, []);
  });
  test('a ban of an IP still banned (fail2ban restarting restores its bans) extends it instead of adding one', async () => {
    const { bans, event } = await setup({ at: T0 + 10 });
    event(ban());
    event(ban({ time: T0 + 5, bantime: 1200 }));
    await bans.ingest();
    const { current, history } = await bans.list();
    assert.equal(current.length + history.length, 1);
    assert.equal(current[0].expires_at, iso(T0 + 5 + 1200));
    assert.equal(current[0].banned_at, iso(T0));
  });
  test('a ban after the last one ran out is a new record, and knows how often the IP was seen', async () => {
    const { bans, event } = await setup({ at: T0 + 5000 });
    event(ban());
    event(ban({ time: T0 + 4000, bantime: 1200 }));
    event(ban({ ip: '198.51.100.4', time: T0 + 4500 }));
    await bans.ingest();
    const { current, history } = await bans.list();
    assert.deepEqual(current.map((b) => [b.ip, b.seen_before]), [['198.51.100.4', 0], ['203.0.113.9', 1]]);
    assert.deepEqual(history.map((b) => [b.ip, b.seen_before]), [['203.0.113.9', 0]]);
  });
  test('events are applied in time order, whatever their file names', async () => {
    const { bans, event } = await setup({ at: T0 + 300 });
    event({ event: 'unban', ip: '203.0.113.9', jail: 'cubby-probe', time: T0 + 200 }, 'a.json');
    event(ban(), 'b.json');
    await bans.ingest();
    assert.equal((await bans.list()).history[0].unbanned_at, iso(T0 + 200));
  });
  test('re-issued as permanent, a ban becomes permanent; a permanent one stays so', async () => {
    const { bans, event } = await setup({ at: T0 + 10 });
    event(ban());
    event(ban({ time: T0 + 5, bantime: -1 }));
    event(ban({ time: T0 + 6, bantime: 60 }));
    await bans.ingest();
    const { current } = await bans.list();
    assert.equal(current.length, 1);
    assert.equal(current[0].expires_at, null);
  });
  test('a jail Cubby doesn\'t know yet shows by its name', async () => {
    const { bans, event } = await setup();
    event(ban({ jail: 'cubby-newer' }));
    await bans.ingest();
    assert.equal((await bans.list()).current[0].reason, 'cubby-newer');
  });
  test('a permanent ban has no expiry and stays current', async () => {
    const { bans, event, clock } = await setup();
    event(ban({ bantime: -1 }));
    await bans.ingest();
    clock.at = T0 + 80 * 24 * 3600;
    const [b] = (await bans.list()).current;
    assert.equal(b.expires_at, null);
  });
  test('a probe ban keeps the hosts the IP swept and up to 50 of its paths, from the day before the ban', async () => {
    const logFile = join(mkdtempSync(join(tmpdir(), 'cubby-log-')), 'access.log');
    const line = (ip, host, uri, at = T0 - 30) => JSON.stringify({ level: 'info', ts: new Date(at * 1000).toISOString().replace(/\.\d+Z$/, 'Z'), logger: 'http.log.access.log0', msg: 'handled request',
      request: { remote_ip: ip, remote_port: '45988', client_ip: ip, proto: 'HTTP/1.1', method: 'GET', host, uri }, bytes_read: 0, user_id: '', duration: 0.0002, size: 2, status: 404 });
    const lines = [
      line('203.0.113.9', 'todo.cubby.example', '/.env', T0 - 2 * 86400), // older than a day: not this sweep
      line('203.0.113.9', 'todo.cubby.example', '/.git/config'),
      line('203.0.113.9', 'chat.cubby.example', '/.git/config'),
      line('198.51.100.4', 'chat.cubby.example', '/secret-of-someone-else'),
      'not json',
      line('203.0.113.9', 'chat.cubby.example', '/.aws/credentials'),
      ...Array.from({ length: 60 }, (_, i) => line('203.0.113.9', 'todo.cubby.example', `/p${i}.php`)),
    ];
    writeFileSync(logFile, `${lines.join('\n')}\n`);
    const { bans, event } = await setup({ accessLog: logFile });
    event(ban());
    event(ban({ ip: '198.51.100.4', jail: 'cubby-ratelimit' }));
    await bans.ingest();
    const { current } = await bans.list();
    const probe = current.find((b) => b.ip === '203.0.113.9');
    assert.deepEqual(probe.hosts, ['todo.cubby.example', 'chat.cubby.example']);
    assert.equal(probe.paths.length, 50);
    assert.deepEqual(probe.paths.slice(0, 3), ['/.git/config', '/.aws/credentials', '/p0.php']);
    assert.deepEqual(current.find((b) => b.ip === '198.51.100.4').paths, [], 'only probe bans collect a sweep');
  });
  test('a missing access log leaves the sweep empty', async () => {
    const { bans, event, errors } = await setup({ accessLog: '/nonexistent/access.log' });
    event(ban());
    await bans.ingest();
    assert.deepEqual((await bans.list()).current[0].hosts, []);
    assert.deepEqual(errors, []);
  });
  test('started, it picks up events by itself; off, it never starts', async () => {
    const { bans, event, events, store } = await setup();
    const timer = bans.start(10);
    try {
      event(ban());
      for (let i = 0; i < 200 && events().length; i++) await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(events(), []);
      assert.ok(await store.findOpen({ ip: '203.0.113.9', jail: 'cubby-probe' }));
    } finally { clearInterval(timer); }
    assert.equal(createBans({ store }).start(10), null);
  });
  test('ingests at the same time (the poller and a request) take turns', async () => {
    const { bans, event, errors } = await setup();
    for (let i = 0; i < 20; i++) event(ban({ ip: `203.0.113.${i}` }));
    const counts = await Promise.all([bans.ingest(), bans.ingest(), bans.list()]);
    assert.equal(counts[0] + counts[1], 20);
    assert.equal(counts[2].current.length, 20, 'a list sees what arrived before it');
    assert.deepEqual(errors, []);
  });
  test('a folder in events/ is not a crash', async () => {
    const { bans, dir, event } = await setup();
    mkdirSync(join(dir, 'events', 'sub.json'));
    event(ban());
    await bans.ingest();
    assert.equal((await bans.list()).current.length, 1);
  });
});
