// Unit tests for the dashboard's pure helpers (server/public/index.html).
// The helpers live in a delimited block of the inline script; we run that block in a vm with a tiny DOM stub.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../server/public/index.html', import.meta.url), 'utf8');
const block = html.match(/\/\/ ---- BEGIN PURE HELPERS ----([\s\S]*?)\/\/ ---- END PURE HELPERS ----/)?.[1];

// Minimal DOM: enough for h() to build elements we can inspect.
class Node {}
class FakeElement extends Node {
  constructor(tag) { super(); this.tagName = tag; this.attrs = {}; this.listeners = {}; this.children = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  append(c) { this.children.push(c); }
}

function load() {
  const ctx = vm.createContext({ Node, document: { createElement: (t) => new FakeElement(t) }, URLSearchParams, Date, String, Object });
  vm.runInContext(block, ctx);
  return vm.runInContext('({ h, fmtBytes, ago, maskToken, installCommand, setupPrompt, tokenLoginCommand, inviteText, isHttps, parseConnectCode, apiErrorMessage, displayName, connectHeading, connectAsker })', ctx);
}

test('the helper block exists and has no DOM-state or network access', () => {
  assert.ok(block, 'BEGIN/END PURE HELPERS markers missing from index.html');
  assert.doesNotMatch(block, /\bfetch\(|localStorage|location\.|getElementById/);
});

const f = load();

describe('h()', () => {
  test('creates the element with attributes', () => {
    const el = f.h('a', { href: '/x', target: '_blank' });
    assert.equal(el.tagName, 'a');
    assert.deepEqual(el.attrs, { href: '/x', target: '_blank' });
  });
  test('true sets an empty boolean attribute; false/null/undefined are omitted', () => {
    const el = f.h('input', { required: true, checked: false, value: null, placeholder: undefined });
    assert.deepEqual(el.attrs, { required: '' });
  });
  test('on* props become event listeners, not attributes', () => {
    const fn = () => {};
    const el = f.h('button', { onclick: fn });
    assert.equal(el.listeners.click, fn);
    assert.equal(el.attrs.onclick, undefined);
  });
  test('children: arrays (e.g. from .map) flattened, null/false skipped, numbers stringified, nodes kept', () => {
    const child = f.h('b');
    const el = f.h('p', {}, 'a', [1, null, 'c'], false, child, undefined, 0);
    assert.deepEqual(el.children, ['a', '1', 'c', child, '0']);
  });
  test('strings are appended as text, never parsed as HTML', () => {
    const el = f.h('p', {}, '<img src=x onerror=alert(1)>');
    assert.equal(typeof el.children[0], 'string');
  });
});

describe('fmtBytes()', () => {
  const cases = [[0, '0 B'], [1023, '1023 B'], [1024, '1 KB'], [1536, '2 KB'], [1048575, '1024 KB'],
    [1048576, '1.0 MB'], [5.5 * 1048576, '5.5 MB'], [1073741824, '1.0 GB'], [2.25 * 1073741824, '2.3 GB']];
  for (const [n, want] of cases) test(`${n} → ${want}`, () => assert.equal(f.fmtBytes(n), want));
});

describe('ago()', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  test('missing date → never', () => {
    assert.equal(f.ago(null, now), 'never');
    assert.equal(f.ago('', now), 'never');
  });
  test('accepts PocketBase "YYYY-MM-DD HH:MM:SS.sssZ" dates', () => assert.equal(f.ago('2026-10-10 11:59:30.000Z', now), 'just now'));
  test('minutes, hours, days', () => {
    assert.equal(f.ago('2026-10-10T11:59:00Z', now), '1m ago');
    assert.equal(f.ago('2026-10-10T11:01:00Z', now), '59m ago');
    assert.equal(f.ago('2026-10-10T11:00:00Z', now), '1h ago');
    assert.equal(f.ago('2026-10-09T12:00:01Z', now), '23h ago');
    assert.equal(f.ago('2026-10-09T12:00:00Z', now), '1d ago');
    assert.equal(f.ago('2026-09-10T12:00:00Z', now), '30d ago');
  });
});

describe('tokens and commands', () => {
  test('maskToken keeps the hk_ prefix visible and hides the rest', () => {
    const masked = f.maskToken('hk_abcdefghijklmnop');
    assert.equal(masked, 'hk_abc' + '•'.repeat(20));
    assert.ok(!masked.includes('defghijk'));
  });
  test('install and login commands use the server URL', () => {
    assert.equal(f.installCommand('https://cubby.example.com'), 'curl -fsSL https://cubby.example.com/skill.sh | sh');
    assert.equal(f.tokenLoginCommand('http://1-2-3-4.sslip.io'), 'cubby login http://1-2-3-4.sslip.io --token <token>');
  });
  test('setupPrompt names the server, installs the skill (npm first, skill.sh as fallback) and points at its docs', () => {
    const p = f.setupPrompt('https://cubby.example.com', "Priya's Cubby");
    assert.match(p, /^I'd like you to set up Cubby: Priya's Cubby at https:\/\/cubby\.example\.com, /);
    assert.ok(p.includes('npx skills add chaitanyadukkipaty/cubby --skill cubby -g'));
    assert.ok(p.includes('If not, do this instead: curl -fsSL https://cubby.example.com/skill.sh | sh'));
    assert.ok(p.includes('connect to https://cubby.example.com '));
    assert.ok(p.includes('https://cubby.example.com/docs.md'));
    assert.match(f.setupPrompt('https://c.dev', null), /^I'd like you to set up Cubby: https:\/\/c\.dev, /, 'no name: just the URL');
    assert.match(f.setupPrompt('https://c.dev', 'Cubby'), /^I'd like you to set up Cubby: https:\/\/c\.dev, /, 'the default name adds nothing');
  });
  test('inviteText contains URL and code on separate lines', () => {
    assert.equal(f.inviteText('https://c.dev', 'otter-maple-42'), 'Join my Cubby server: https://c.dev\nSignup code: otter-maple-42');
  });
  test('inviteText names the server when it has a name', () => {
    assert.equal(f.inviteText('https://c.dev', 'otter-maple-42', "Priya's Cubby"), "Join Priya's Cubby: https://c.dev\nSignup code: otter-maple-42");
  });
  test('isHttps', () => {
    assert.equal(f.isHttps('https://c.dev'), true);
    assert.equal(f.isHttps('http://c.dev'), false);
    assert.equal(f.isHttps('httpsish://x'), false);
  });
});

describe('parseConnectCode()', () => {
  test('reads the code on /connect', () => assert.equal(f.parseConnectCode('/connect', '?code=ABCD-2345'), 'ABCD-2345'));
  test('trims whitespace and decodes', () => assert.equal(f.parseConnectCode('/connect', '?code=%20ABCD-2345%20'), 'ABCD-2345'));
  test('blank or missing code → null', () => {
    assert.equal(f.parseConnectCode('/connect', '?code='), null);
    assert.equal(f.parseConnectCode('/connect', ''), null);
  });
  test('ignored on other pages', () => {
    assert.equal(f.parseConnectCode('/', '?code=ABCD-2345'), null);
    assert.equal(f.parseConnectCode('/connect/extra', '?code=ABCD-2345'), null);
  });
});

describe('apiErrorMessage()', () => {
  test('prefers the server error string', () => assert.equal(f.apiErrorMessage(403, { error: 'Admins only' }), 'Admins only'));
  test('falls back to the status for empty/non-JSON bodies', () => {
    assert.equal(f.apiErrorMessage(502, {}), 'Request failed (502)');
    assert.equal(f.apiErrorMessage(500, null), 'Request failed (500)');
    assert.equal(f.apiErrorMessage(400, { error: { nested: true } }), 'Request failed (400)');
  });
});

describe('server names', () => {
  test('displayName trims a real name', () => assert.equal(f.displayName('  Acme Cubby '), 'Acme Cubby'));
  for (const blank of [undefined, null, '', '   ', 42, {}])
    test(`displayName falls back to Cubby for ${JSON.stringify(blank)}`, () => assert.equal(f.displayName(blank), 'Cubby'));
  test('connectHeading names the server', () => assert.equal(f.connectHeading("Priya's Cubby"), "Connect your agent to Priya's Cubby?"));
  test('connectHeading without a name says "this server"', () => assert.equal(f.connectHeading(''), 'Connect your agent to this server?'));
  test('connectAsker names the agent that is asking, from the hint its CLI sent', () => {
    assert.equal(f.connectAsker({ tool: 'Claude Code', machine: 'chaitanya-mbp' }), 'Claude Code on chaitanya-mbp wants access');
    assert.equal(f.connectAsker({ tool: 'Codex', machine: null }), 'Codex wants access');
    assert.equal(f.connectAsker({ tool: null, machine: 'build-box' }), 'An agent on build-box wants access');
  });
  test('connectAsker falls back to the generic wording for CLIs that sent no hint', () => {
    for (const none of [null, undefined, {}]) assert.equal(f.connectAsker(none), 'An AI agent on your computer wants access');
  });
});

describe('jobState', () => {
  const ctx = vm.createContext({ Node, document: { createElement: (t) => new FakeElement(t) }, URLSearchParams, Date, String, Object });
  vm.runInContext(block, ctx);
  const jobState = vm.runInContext('jobState', ctx);
  const st = (j) => ({ ...jobState(j) });
  test('paused and never-run jobs are muted', () => {
    assert.deepEqual(st({ paused: true, last_run: { status: 'error' } }), { kind: 'muted', text: 'paused' });
    assert.deepEqual(st({ paused: false, last_run: null }), { kind: 'muted', text: 'not run yet' });
  });
  test('the last run decides otherwise', () => {
    assert.deepEqual(st({ last_run: { status: 'ok' } }), { kind: 'ok', text: 'ok' });
    assert.deepEqual(st({ last_run: { status: 'error' } }), { kind: 'danger', text: 'error' });
    assert.deepEqual(st({ last_run: { status: 'timeout' } }), { kind: 'danger', text: 'timeout' });
    assert.deepEqual(st({ last_run: { status: 'skipped' } }), { kind: 'muted', text: 'skipped' });
    assert.deepEqual(st({ last_run: { status: 'running' } }), { kind: 'muted', text: 'running' });
  });
});

describe('updateNotice', () => {
  const ctx = vm.createContext({ Node, document: { createElement: (t) => new FakeElement(t) }, URLSearchParams, Date, String, Object });
  vm.runInContext(block, ctx);
  const g = vm.runInContext('({ updateNotice, UPGRADE_COMMAND })', ctx);
  const on = { enabled: true, current: '0.1.1', checked_at: '2026-10-11T00:00:00Z', error: null };
  test('a newer release shows the version, the release notes and the exact upgrade command', () => {
    const n = g.updateNotice({ ...on, latest: 'v0.1.2', update_available: true, release_url: 'https://gh/r' });
    assert.deepEqual({ ...n }, { kind: 'available', text: 'Update available: v0.1.2', command: 'sudo cubby-server upgrade', url: 'https://gh/r' });
    assert.equal(g.UPGRADE_COMMAND, 'sudo cubby-server upgrade');
  });
  test('up to date, no releases yet, still checking, unreachable', () => {
    assert.equal(g.updateNotice({ ...on, latest: 'v0.1.1', update_available: false }).text, "You're on the latest release (v0.1.1).");
    assert.equal(g.updateNotice({ ...on, latest: null, update_available: false }).text, 'No releases published yet.');
    assert.equal(g.updateNotice({ ...on, checked_at: null, latest: null }).kind, 'unknown');
    assert.match(g.updateNotice({ ...on, latest: null, error: 'offline' }).text, /Couldn't reach GitHub/);
    assert.equal(g.updateNotice({ ...on, latest: 'v0.1.1', error: 'offline' }).kind, 'current', 'a failed re-check keeps the last answer');
  });
  test('versionLabel marks development builds', () => {
    const v = vm.runInContext('versionLabel', ctx);
    assert.equal(v('0.1.1'), 'Cubby 0.1.1');
    assert.equal(v('0.1.1-dev+abc1234'), 'Cubby 0.1.1 · development build abc1234');
    assert.equal(v('0.0.9-rc1'), 'Cubby 0.0.9-rc1');
    assert.equal(v(''), 'Cubby unknown version');
  });
  test('says why the check is off', () => {
    assert.match(g.updateNotice({ enabled: false, reason: 'env' }).text, /CUBBY_UPDATE_CHECK=0/);
    assert.equal(g.updateNotice({ enabled: false, reason: 'setting' }).text, 'Update checks are off.');
    assert.equal(g.updateNotice(undefined).kind, 'unknown');
  });
});
