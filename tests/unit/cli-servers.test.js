// Several servers in ~/.cubby/config.json: migration, matching by name, and which server a command uses.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as s from '../../cli/src/servers.js';
import { CliError } from '../../cli/src/lib.js';

const err = (fn, re) => assert.throws(fn, (e) => e instanceof CliError && re.test(e.message));
const entry = (url, extra = {}) => ({ name: null, url, email: null, token: null, version: null, ...extra });
const two = () => ({
  format: 1,
  default: 'priya.dev',
  servers: {
    'priya.dev': entry('https://priya.dev', { name: "Priya's Cubby", token: 'hk_p' }),
    'cubby.acme.com': entry('https://cubby.acme.com', { name: 'Acme Cubby', token: 'hk_a' }),
  },
});

describe('urls and ids', () => {
  test('normalizeUrl drops paths and trailing slashes and lowercases the host', () => {
    assert.equal(s.normalizeUrl('HTTPS://Priya.Dev/some/path/'), 'https://priya.dev');
    assert.equal(s.normalizeUrl('http://localhost:8080/'), 'http://localhost:8080');
  });
  test('serverId is the host, keeping a port', () => {
    assert.equal(s.serverId('https://cubby.acme.com/'), 'cubby.acme.com');
    assert.equal(s.serverId('http://localhost:8080'), 'localhost:8080');
  });
});

describe('migrateConfig', () => {
  test('missing or junk config becomes an empty format-1 config', () => {
    for (const raw of [undefined, null, 'x', 42]) assert.deepEqual(s.migrateConfig(raw), { format: 1, default: null, servers: {} });
  });
  test('the 0.1.0 single-server shape becomes one default server', () => {
    const cfg = s.migrateConfig({ server: 'https://Priya.dev/', token: 'hk_p', email: 'p@x.co' });
    assert.deepEqual(cfg, { format: 1, default: 'priya.dev', servers: { 'priya.dev': entry('https://priya.dev', { token: 'hk_p', email: 'p@x.co' }) } });
  });
  test('an old empty shape (no server) migrates to no servers', () => {
    assert.deepEqual(s.migrateConfig({}), { format: 1, default: null, servers: {} });
  });
  test('format 1 passes through', () => assert.deepEqual(s.migrateConfig(two()), two()));
  test('a newer format is refused with an update hint', () => err(() => s.migrateConfig({ format: 2, servers: {} }), /newer Cubby CLI \(format 2\)\. Update this one: npm i -g <server-url>\/cli\.tgz/));
  test('lenient: a newer format is still readable, marked, and never rewritten', () => {
    const cfg = s.migrateConfig({ format: 2, default: 'a.dev', servers: { 'a.dev': { url: 'https://a.dev', token: 't' } } }, { lenient: true });
    assert.deepEqual(cfg, { format: 2, default: 'a.dev', servers: { 'a.dev': { url: 'https://a.dev', token: 't' } }, tooNew: true });
    assert.deepEqual(s.migrateConfig({ format: 2, servers: 'junk' }, { lenient: true }).servers, {});
    const tmp = mkdtempSync(join(tmpdir(), 'cubby-newer-'));
    err(() => s.writeConfig(join(tmp, 'never.json'), cfg), /newer Cubby CLI \(format 2\)\. Update this one: npm i -g https:\/\/a\.dev\/cli\.tgz/);
    assert.ok(!existsSync(join(tmp, 'never.json')));
  });
});

describe('upsertServer / removeServer', () => {
  test('the first server added becomes the default', () => {
    const { cfg, id } = s.upsertServer(s.migrateConfig(null), { url: 'https://priya.dev/', name: "Priya's Cubby" });
    assert.equal(id, 'priya.dev');
    assert.equal(cfg.default, 'priya.dev');
    assert.deepEqual(cfg.servers['priya.dev'], entry('https://priya.dev', { name: "Priya's Cubby" }));
  });
  test('adding another keeps the default and the other servers', () => {
    const { cfg } = s.upsertServer(two(), { url: 'https://third.dev', token: 'hk_3' });
    assert.equal(cfg.default, 'priya.dev');
    assert.deepEqual(Object.keys(cfg.servers), ['priya.dev', 'cubby.acme.com', 'third.dev']);
  });
  test('updating merges fields and ignores undefined ones (keeps the token)', () => {
    const { cfg } = s.upsertServer(two(), { url: 'https://cubby.acme.com', name: 'Acme', token: undefined });
    assert.equal(cfg.servers['cubby.acme.com'].name, 'Acme');
    assert.equal(cfg.servers['cubby.acme.com'].token, 'hk_a');
  });
  test('a dangling default is repaired on upsert', () => {
    const { cfg } = s.upsertServer({ format: 1, default: 'gone', servers: {} }, { url: 'https://new.dev' });
    assert.equal(cfg.default, 'new.dev');
  });
  test('removing the default leaves the only remaining server as default', () => {
    assert.equal(s.removeServer(two(), 'priya.dev').default, 'cubby.acme.com');
  });
  test('removing the default with several left clears it', () => {
    const three = s.upsertServer(two(), { url: 'https://third.dev' }).cfg;
    assert.equal(s.removeServer(three, 'priya.dev').default, null);
  });
  test('removing a non-default server keeps the default', () => {
    assert.equal(s.removeServer(two(), 'cubby.acme.com').default, 'priya.dev');
  });
});

describe('findServer', () => {
  test('by URL, with any path or case', () => assert.equal(s.findServer(two(), 'HTTPS://cubby.acme.com/x').id, 'cubby.acme.com'));
  test('an unknown URL is not found', () => assert.equal(s.findServer(two(), 'https://nope.dev'), null));
  test('by id', () => assert.equal(s.findServer(two(), 'priya.dev').id, 'priya.dev'));
  test('by name, case-insensitive and trimmed', () => assert.equal(s.findServer(two(), "  priya's cubby ").id, 'priya.dev'));
  test('an unknown name is not found', () => assert.equal(s.findServer(two(), 'Nope'), null));
  test('a name shared by two servers is ambiguous', () => {
    const cfg = two();
    cfg.servers['cubby.acme.com'].name = "Priya's Cubby";
    err(() => s.findServer(cfg, "Priya's Cubby"), /More than one server is called .*Use its URL/);
  });
});

describe('resolveTarget order: --server → CUBBY_SERVER → cubby.json → default → only', () => {
  const all = { flag: 'Acme Cubby', env: 'https://env.dev', projectServer: 'https://project.dev' };
  test('--server wins and can be a name', () => {
    const t = s.resolveTarget(two(), all);
    assert.deepEqual([t.id, t.url, t.source, t.server.token], ['cubby.acme.com', 'https://cubby.acme.com', 'flag', 'hk_a']);
  });
  test('then CUBBY_SERVER', () => {
    const t = s.resolveTarget(two(), { ...all, flag: undefined });
    assert.deepEqual([t.url, t.source, t.server], ['https://env.dev', 'env', null]);
  });
  test('then the app\'s cubby.json', () => {
    const t = s.resolveTarget(two(), { projectServer: 'https://cubby.acme.com' });
    assert.deepEqual([t.id, t.source], ['cubby.acme.com', 'cubby.json']);
  });
  test('then the default', () => assert.equal(s.resolveTarget(two(), {}).source, 'default'));
  test('then the only server, when no default is set', () => {
    const cfg = { format: 1, default: null, servers: { 'one.dev': entry('https://one.dev') } };
    assert.deepEqual([s.resolveTarget(cfg).id, s.resolveTarget(cfg).source], ['one.dev', 'only']);
  });
  test('several servers and no default: asks for --server and lists them', () => {
    const cfg = { ...two(), default: null };
    err(() => s.resolveTarget(cfg), /Several servers.*--server.*cubby use.*Priya's Cubby \(https:\/\/priya\.dev\), Acme Cubby/);
  });
  test('no servers at all: says how to log in', () => err(() => s.resolveTarget(s.migrateConfig(null)), /^Not logged in\. Run `cubby login <server-url>`/));
  test('an unknown name lists the known servers', () => err(() => s.resolveTarget(two(), { flag: 'Bobs' }), /No server called "Bobs"\. Known servers: Priya's Cubby/));
  test('an unknown URL resolves with no saved server (for login)', () => {
    const t = s.resolveTarget(two(), { flag: 'https://new.dev/' });
    assert.deepEqual([t.url, t.id, t.server], ['https://new.dev', 'new.dev', null]);
  });
  test('an empty config lists "none" as known servers', () => err(() => s.resolveTarget(s.migrateConfig(null), { flag: 'x' }), /Known servers: none/));
});

describe('files', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cubby-servers-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('readConfig of a missing file is empty', () => assert.deepEqual(s.readConfig(join(dir, 'nope.json')), { format: 1, default: null, servers: {} }));
  test('readConfig migrates a legacy file', () => {
    writeFileSync(join(dir, 'c.json'), JSON.stringify({ server: 'https://a.dev', token: 't', email: 'e' }));
    assert.equal(s.readConfig(join(dir, 'c.json')).default, 'a.dev');
  });
  test('readConfig refuses invalid JSON clearly', () => {
    writeFileSync(join(dir, 'c.json'), '{nope');
    err(() => s.readConfig(join(dir, 'c.json')), /c\.json is not valid JSON/);
  });
  test('writeConfig is atomic, private, and stamps the format', () => {
    const file = join(dir, 'sub', 'config.json');
    s.writeConfig(file, { default: 'a', servers: {} });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { default: 'a', servers: {}, format: 1 });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(dir, 'sub')), ['config.json'], 'no temp file left behind');
  });
  test('readProject: missing, legacy (no format), current, newer, broken', () => {
    const f = join(dir, 'cubby.json');
    assert.equal(s.readProject(f), null);
    writeFileSync(f, JSON.stringify({ project: 'a', server: 'https://x' }));
    assert.equal(s.readProject(f).project, 'a');
    writeFileSync(f, JSON.stringify(s.projectJson('a', 'https://x')));
    assert.deepEqual(s.readProject(f), { format: 1, project: 'a', server: 'https://x' });
    writeFileSync(f, JSON.stringify({ format: 9, project: 'a' }));
    err(() => s.readProject(f), /cubby\.json was written by a newer Cubby CLI \(format 9\)/);
    writeFileSync(f, '{');
    err(() => s.readProject(f), /not valid JSON/);
  });
});

describe('listing', () => {
  test('listServers marks the default and login state, without tokens', () => {
    const cfg = s.upsertServer(two(), { url: 'https://third.dev' }).cfg;
    const list = s.listServers(cfg);
    assert.deepEqual(list.map((x) => [x.id, x.default, x.logged_in]), [['priya.dev', true, true], ['cubby.acme.com', false, true], ['third.dev', false, false]]);
    assert.ok(list.every((x) => !('token' in x)));
  });
  test('formatServers shows name, url, email or login hint, version', () => {
    const cfg = two();
    cfg.servers['priya.dev'].email = 'p@x.co';
    cfg.servers['priya.dev'].version = '0.2.0';
    cfg.servers['cubby.acme.com'].token = null;
    const text = s.formatServers(s.listServers(cfg));
    assert.match(text, /^\* Priya's Cubby\s+https:\/\/priya\.dev {2}p@x\.co {2}v0\.2\.0$/m);
    assert.match(text, /^ {2}Acme Cubby\s+https:\/\/cubby\.acme\.com {2}\(not logged in\)$/m);
  });
  test('formatServers falls back to the id and handles no servers', () => {
    assert.match(s.formatServers([{ id: 'a.dev', name: null, url: 'https://a.dev', logged_in: true, email: null, default: false }]), /a\.dev/);
    assert.match(s.formatServers([]), /No servers yet/);
  });
  test('describeServer prefers the name', () => {
    assert.equal(s.describeServer('a.dev', { name: 'A', url: 'https://a.dev' }), 'A (https://a.dev)');
    assert.equal(s.describeServer('a.dev', { name: null, url: 'https://a.dev' }), 'a.dev (https://a.dev)');
  });
});
