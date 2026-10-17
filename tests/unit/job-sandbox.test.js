// The in-job helpers. lockDown() patches this test process's network for good, so its tests come last
// (node --test runs each file in its own process).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import dgram from 'node:dgram';
import { isBlockedAddress, safeLookup, connectOptions, ipcFetch, ipcClient, prefixer, createContext, lockDown } from '../../server/src/job-sandbox.js';

describe('isBlockedAddress', () => {
  test('loopback, private, link-local, CGNAT, multicast and reserved addresses are blocked', () => {
    for (const ip of ['127.0.0.1', '127.8.9.10', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
      '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fd00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::FFFF:10.0.0.1', '64:ff9b::7f00:1']) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
  });
  test('public addresses are allowed', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '203.0.113.5', '2606:4700:4700::1111', '::ffff:1.1.1.1']) assert.equal(isBlockedAddress(ip), false, ip);
  });
  test('anything that is not an IP is blocked', () => assert.equal(isBlockedAddress('localhost'), true));
});

describe('safeLookup', () => {
  const resolver = (addresses, err = null) => (host, opts, cb) => cb(err, addresses);
  const lookup = (opts, addresses, err) => new Promise((res) => safeLookup('h.test', opts, (...args) => res(args), resolver(addresses, err)));

  test('drops blocked addresses and returns the first allowed one', async () => {
    const [err, address, family] = await lookup({}, [{ address: '127.0.0.1', family: 4 }, { address: '1.1.1.1', family: 4 }]);
    assert.equal(err, null);
    assert.equal(address, '1.1.1.1');
    assert.equal(family, 4);
  });
  test('honours { all: true }', async () => {
    const [, list] = await lookup({ all: true }, [{ address: '10.0.0.1', family: 4 }, { address: '2606:4700::1', family: 6 }]);
    assert.deepEqual(list, [{ address: '2606:4700::1', family: 6 }]);
  });
  test('fails when every address is blocked', async () => {
    const [err] = await lookup({}, [{ address: '127.0.0.1', family: 4 }]);
    assert.equal(err.code, 'ECONNREFUSED');
    assert.match(err.message, /public internet addresses \(blocked: h\.test\)/);
  });
  test('passes DNS errors through', async () => {
    const [err] = await lookup({}, null, Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
    assert.equal(err.code, 'ENOTFOUND');
  });
});

describe('connectOptions', () => {
  const cb = () => {};
  test('options object', () => assert.deepEqual(connectOptions([{ host: 'a', port: 1 }, cb]), { options: { host: 'a', port: 1 }, cb }));
  test('net.connect pre-normalized array', () => assert.deepEqual(connectOptions([[{ port: 2 }, cb]]), { options: { port: 2 }, cb }));
  test('port and host', () => assert.deepEqual(connectOptions([80, 'example.com', cb]), { options: { port: 80, host: 'example.com' }, cb }));
  test('port only, as a number or a numeric string', () => {
    assert.deepEqual(connectOptions([80]), { options: { port: 80 }, cb: undefined });
    assert.deepEqual(connectOptions(['8080']), { options: { port: '8080' }, cb: undefined });
  });
  test('a unix socket path', () => assert.deepEqual(connectOptions(['/var/run/docker.sock']), { options: { path: '/var/run/docker.sock' }, cb: undefined }));
});

describe('ipcFetch / ipcClient', () => {
  test('sends the request over IPC and builds a Response from the reply', async () => {
    const seen = [];
    const fetchViaIpc = ipcFetch(async (req) => {
      seen.push(req);
      return { status: 201, contentType: 'application/json', body: Buffer.from('{"id":"x"}').toString('base64') };
    });
    const res = await fetchViaIpc('http://pb.invalid/api/collections/a__b/records?x=1', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: 'x' });
    assert.deepEqual(seen[0], { method: 'POST', path: '/api/collections/a__b/records?x=1', contentType: 'application/json', body: Buffer.from('{"a":1}').toString('base64') });

    const empty = await fetchViaIpc('http://pb.invalid/api/health');
    assert.equal(seen[1].body, null);
    assert.equal(seen[1].method, 'GET');
    assert.equal(empty.status, 201);
  });
  test('a reply without a body or type', async () => {
    const res = await ipcFetch(async () => ({ status: 204 }))('http://pb.invalid/x', { method: 'DELETE' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('content-type'), null);
  });
  test('ipcClient matches replies to requests by id and ignores other messages', async () => {
    const proc = new EventEmitter();
    proc.send = (msg) => queueMicrotask(() => {
      proc.emit('message', { type: 'other' });
      proc.emit('message', { type: 'pb', id: 999 });
      proc.emit('message', { type: 'pb', id: msg.id, status: 200, echo: msg.path });
    });
    const request = ipcClient(proc);
    const [a, b] = await Promise.all([request({ path: '/a' }), request({ path: '/b' })]);
    assert.equal(a.echo, '/a');
    assert.equal(b.echo, '/b');
  });
});

describe('createContext', () => {
  class FakePocketBase {
    constructor(url) { this.url = url; }
    autoCancellation(v) { this.cancel = v; }
    collection(name) { return { name }; }
  }
  test('a PocketBase client over IPC with unprefixed collection names, plus env, log, fetch and col', async () => {
    const ctx = createContext({ PocketBase: FakePocketBase, prefix: 'my_app__', env: { KEY: 'v' }, request: async () => ({ status: 200 }) });
    assert.equal(ctx.pb.url, 'http://pb.invalid');
    assert.equal(ctx.pb.cancel, false);
    assert.equal(ctx.pb.collection('tasks').name, 'my_app__tasks');
    assert.equal(ctx.pb.collection('my_app__tasks').name, 'my_app__tasks');
    assert.equal(ctx.col('notes'), 'my_app__notes');
    assert.equal(ctx.env.KEY, 'v');
    assert.ok(Object.isFrozen(ctx.env));
    assert.equal(ctx.fetch, globalThis.fetch);
    const { url, options } = ctx.pb.beforeSend('http://pb.invalid/x', { method: 'GET' });
    assert.equal(url, 'http://pb.invalid/x');
    assert.equal(options.method, 'GET');
    assert.equal((await options.fetch('http://pb.invalid/x')).status, 200);
    const logged = [];
    const orig = console.log;
    console.log = (...a) => logged.push(a);
    try { ctx.log('hi', 1); } finally { console.log = orig; }
    assert.deepEqual(logged, [['hi', 1]]);
  });
  test('prefixer', () => assert.equal(prefixer('p__')('x'), 'p__x'));
});

describe('lockDown (last: patches this process)', () => {
  const connectError = (...args) => new Promise((res) => {
    const s = new net.Socket();
    s.on('error', res);
    s.on('connect', () => { s.destroy(); res(null); });
    s.connect(...args);
  });

  test('blocks loopback by IP and by name, local sockets and UDP; removes raw bindings', async () => {
    lockDown();
    lockDown(); // idempotent
    const byIp = await connectError({ host: '127.0.0.1', port: 9 });
    assert.match(byIp.message, /blocked: 127\.0\.0\.1/);
    const byName = await connectError(9, 'localhost');
    assert.match(byName.message, /blocked: localhost/);
    const viaConnect = await new Promise((res) => net.connect({ host: '::1', port: 9 }).on('error', res));
    assert.match(viaConnect.message, /blocked: ::1/);
    const sock = await connectError('/tmp/cubby-test.sock');
    assert.match(sock.message, /local socket/);
    assert.throws(() => dgram.createSocket('udp4'), /UDP is not available/);
    assert.equal(process.binding, undefined);
    assert.equal(process._linkedBinding, undefined);
  });
  test('public addresses still go through to the real connect', async () => {
    const s = new net.Socket();
    s.on('error', () => {});
    s.connect({ host: '203.0.113.5', port: 9 }); // TEST-NET-3: never answers, but isn't blocked
    assert.equal(s.connecting, true);
    s.destroy();
  });
});
