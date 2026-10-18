import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { HttpError, readBody, readJson, rateLimiter, clientIp, sendJson } from '../../server/src/http.js';
import { startDevice, deviceInfo, approveDevice, pollDevice, USER_CODE_RE } from '../../server/src/device.js';
import { newSignupCode } from '../../server/src/settings.js';
import { authenticate } from '../../server/src/auth.js';

const req = ({ remote = '203.0.113.9', xff, chunks = [] } = {}) =>
  Object.assign(Readable.from(chunks.map((c) => Buffer.from(c))), { socket: { remoteAddress: remote }, headers: xff ? { 'x-forwarded-for': xff } : {} });

describe('readBody / readJson', () => {
  test('concatenates chunks', async () => assert.equal((await readBody(req({ chunks: ['ab', 'cd'] }), 10)).toString(), 'abcd'));
  test('413 once the limit is exceeded', async () => {
    await assert.rejects(readBody(req({ chunks: ['12345', '6'] }), 5), (e) => e instanceof HttpError && e.status === 413);
  });
  test('accepts exactly the limit', async () => assert.equal((await readBody(req({ chunks: ['12345'] }), 5)).length, 5));
  test('readJson parses, defaults empty bodies to {}, rejects invalid JSON with 400', async () => {
    assert.deepEqual(await readJson(req({ chunks: ['{"a":1}'] })), { a: 1 });
    assert.deepEqual(await readJson(req()), {});
    await assert.rejects(readJson(req({ chunks: ['{nope'] })), (e) => e.status === 400 && /Invalid JSON/.test(e.message));
  });
});

describe('sendJson', () => {
  test('writes status, content-type and byte length', () => {
    const res = { writeHead: mock.fn(), end: mock.fn() };
    sendJson(res, 201, { msg: 'héllo' });
    assert.deepEqual(res.writeHead.mock.calls[0].arguments, [201, { 'content-type': 'application/json', 'content-length': 16 }]);
    assert.equal(res.end.mock.calls[0].arguments[0], '{"msg":"héllo"}');
  });
});

describe('clientIp', () => {
  test('uses the socket address for remote clients, even with X-Forwarded-For', () => assert.equal(clientIp(req({ remote: '198.51.100.1', xff: '1.1.1.1' })), '198.51.100.1'));
  test('trusts X-Forwarded-For only from loopback (local Caddy)', () => {
    for (const lo of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(clientIp(req({ remote: lo, xff: '9.9.9.9, 10.0.0.1' })), '9.9.9.9');
  });
  test('falls back to the socket address when no header', () => assert.equal(clientIp(req({ remote: '127.0.0.1' })), '127.0.0.1'));
  test('empty string if the socket has no address', () => assert.equal(clientIp({ socket: {}, headers: {} }), ''));
});

describe('rateLimiter', () => {
  test('allows `limit` hits per window per IP, then 429; resets each window', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const limit = rateLimiter(3, 60_000);
      const a = req({ remote: '203.0.113.1' });
      const b = req({ remote: '203.0.113.2' });
      for (let i = 0; i < 3; i++) limit(a);
      assert.throws(() => limit(a), (e) => e.status === 429);
      limit(b); // other IPs unaffected
      mock.timers.tick(60_000);
      limit(a); // window reset
    } finally {
      mock.timers.reset();
    }
  });
  test('distinct forwarded clients behind Caddy are counted separately', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const limit = rateLimiter(1, 1000);
      limit(req({ remote: '127.0.0.1', xff: '1.1.1.1' }));
      limit(req({ remote: '127.0.0.1', xff: '2.2.2.2' }));
      assert.throws(() => limit(req({ remote: '127.0.0.1', xff: '1.1.1.1' })), (e) => e.status === 429);
    } finally {
      mock.timers.reset();
    }
  });
});

describe('device login', () => {
  const T0 = 1_000_000;
  test('start returns a readable code, a verify URL and a 10 minute expiry', () => {
    const d = startDevice('https://ex.com', T0);
    assert.match(d.user_code, USER_CODE_RE);
    assert.ok(!/[01IO]/.test(d.user_code), 'no ambiguous characters');
    assert.equal(d.verify_url, `https://ex.com/connect?code=${d.user_code}`);
    assert.equal(d.expires_in, 600);
    assert.equal(d.interval, 2);
    assert.ok(d.device_id.length >= 32);
    assert.notEqual(startDevice('x', T0).user_code, startDevice('x', T0).user_code);
  });
  test('pending until approved, then returns a token exactly once', async () => {
    const d = startDevice('x', T0);
    const issued = [];
    const issueToken = async (uid) => (issued.push(uid), `hk_${uid}`);
    assert.deepEqual(await pollDevice(d.device_id, { now: T0 + 1, issueToken }), { status: 'pending' });
    assert.deepEqual(deviceInfo(d.user_code, T0 + 1, { id: 'u' }), { ok: true, agent: null }, 'an old CLI sent no hint');
    approveDevice({ id: 'user1' }, ` ${d.user_code.toLowerCase()} `, T0 + 2); // tolerant of case/space
    assert.deepEqual(await pollDevice(d.device_id, { now: T0 + 3, issueToken }), { status: 'approved', token: 'hk_user1' });
    assert.deepEqual(issued, ['user1']);
    await assert.rejects(pollDevice(d.device_id, { now: T0 + 4, issueToken }), (e) => e.status === 410, 'cannot be redeemed twice');
    assert.throws(() => approveDevice({ id: 'u2' }, d.user_code, T0 + 5), (e) => e.status === 404, 'code is single use');
  });
  test('the hint a CLI sends names the agent on /connect and goes to the key it gets', async () => {
    const d = startDevice('x', T0, { tool: 'Claude Code', machine: 'chaitanya-mbp' });
    assert.deepEqual(deviceInfo(d.user_code, T0 + 1, { id: 'u1' }), { ok: true, agent: { name: 'Claude Code · chaitanya-mbp', tool: 'Claude Code', machine: 'chaitanya-mbp' } });
    assert.deepEqual(deviceInfo(d.user_code, T0 + 1), { ok: true }, 'only signed-in people see which agent and machine are asking');
    approveDevice({ id: 'u1' }, d.user_code, T0 + 2);
    const calls = [];
    const issueToken = async (uid, hint) => (calls.push([uid, hint]), 'hk_new');
    assert.deepEqual(await pollDevice(d.device_id, { now: T0 + 3, issueToken }), { status: 'approved', token: 'hk_new' });
    assert.deepEqual(calls, [['u1', { tool: 'Claude Code', machine: 'chaitanya-mbp' }]]);
  });
  test('an approved code can\'t be approved again by someone else: the first approval stands', async () => {
    const d = startDevice('x', T0, { tool: 'Codex' });
    approveDevice({ id: 'dave' }, d.user_code, T0 + 1);
    assert.throws(() => approveDevice({ id: 'bob' }, d.user_code, T0 + 2), (e) => e.status === 409 && /already approved/.test(e.message));
    assert.throws(() => approveDevice({ id: 'dave' }, d.user_code, T0 + 2), (e) => e.status === 409, 'not even by the same person');
    assert.throws(() => deviceInfo(d.user_code, T0 + 2, { id: 'bob' }), (e) => e.status === 409 && /already approved/.test(e.message), 'the approval page says so');
    const issueToken = async (uid) => `hk_${uid}`;
    assert.deepEqual(await pollDevice(d.device_id, { now: T0 + 3, issueToken }), { status: 'approved', token: 'hk_dave' });
  });
  test('codes expire after 10 minutes', async () => {
    const d = startDevice('x', T0);
    const later = T0 + 10 * 60 * 1000 + 1;
    assert.throws(() => deviceInfo(d.user_code, later), (e) => e.status === 404 && /expired/.test(e.message));
    assert.throws(() => approveDevice({ id: 'u' }, d.user_code, later), (e) => e.status === 404);
    await assert.rejects(pollDevice(d.device_id, { now: later }), (e) => e.status === 410);
  });
  test('unknown codes and device ids', async () => {
    assert.throws(() => deviceInfo('ZZZZ-ZZZZ'), (e) => e.status === 404);
    await assert.rejects(pollDevice('nope'), (e) => e.status === 410);
  });
});

describe('newSignupCode', () => {
  test('word-word-NN format, varied', () => {
    const codes = new Set(Array.from({ length: 50 }, newSignupCode));
    for (const c of codes) assert.match(c, /^[a-z]+-[a-z]+-[1-9][0-9]$/);
    assert.ok(codes.size > 10);
  });
});

describe('authenticate (header checks before any database call)', () => {
  for (const [label, header] of [['missing', undefined], ['not bearer', 'Token hk_x'], ['not an hk_ key', 'Bearer abc']]) {
    test(`401 when ${label}`, async () => {
      await assert.rejects(authenticate({ headers: header ? { authorization: header } : {} }), (e) => e.status === 401 && /Missing token/.test(e.message));
    });
  }
});
