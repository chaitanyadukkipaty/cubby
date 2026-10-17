// Runs inside a job's child process (see job-runner.js), before the app's code is loaded. Only Node built-ins here:
// the child may only read server/src, the PocketBase SDK and the job's own files.
//
// The Node permission model (set by the parent) already blocks file access outside those paths, child processes,
// workers and native addons. It does not restrict the network, so this file closes the hole that matters: a job
// must not reach PocketBase or the Cubby server on loopback (or anything else on a private network) directly,
// because the /pb proxy checks are the only thing between one app and another app's data. Every TCP connection
// (fetch, http, net, tls, WebSocket) goes through net.Socket#connect, so the check lives there, on the resolved
// address that is actually connected to (no DNS rebinding window).
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  blocked.addSubnet(addr, prefix, 'ipv6');
}

// Loopback, private, link-local (cloud metadata), CGNAT, multicast and reserved ranges, including IPv4-mapped IPv6.
export function isBlockedAddress(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isBlockedAddress(mapped[1]);
  const family = net.isIP(ip);
  if (!family) return true;
  return blocked.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

const deniedError = (what) =>
  Object.assign(new Error(`Jobs can only connect to public internet addresses (blocked: ${what})`), { code: 'ECONNREFUSED' });

// dns.lookup that never returns a blocked address (net always calls it with options). `resolve` is for tests.
export function safeLookup(hostname, options, callback, resolve = dns.lookup) {
  resolve(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const allowed = addresses.filter((a) => !isBlockedAddress(a.address));
    if (!allowed.length) return callback(deniedError(hostname));
    if (options.all) return callback(null, allowed);
    callback(null, allowed[0].address, allowed[0].family);
  });
}

// Turns the shapes net.Socket#connect accepts into one options object (plus the callback).
export function connectOptions(args) {
  let list = args;
  if (Array.isArray(list[0])) list = list[0]; // net.connect() passes pre-normalized [options, cb]
  const cb = list.find((a) => typeof a === 'function');
  const [first, second] = list;
  if (first !== null && typeof first === 'object') return { options: { ...first }, cb };
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { options: { path: first }, cb };
  return { options: { port: first, ...(typeof second === 'string' && { host: second }) }, cb };
}

let lockedDown = false;

export function lockDown() {
  if (lockedDown) return;
  lockedDown = true;
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const { options, cb } = connectOptions(args);
    let denied = null;
    if (options.path !== undefined) denied = 'local socket';
    else if (net.isIP(options.host ?? 'localhost') && isBlockedAddress(options.host)) denied = options.host;
    if (denied) {
      process.nextTick(() => this.destroy(deniedError(denied)));
      return this;
    }
    options.lookup = safeLookup;
    return connect.call(this, options, cb);
  };
  dgram.createSocket = () => { throw new Error('UDP is not available to jobs'); };
  syncBuiltinESMExports();
  // Raw bindings would bypass the patched socket (and the permission model's view of the world).
  delete process.binding;
  delete process._linkedBinding;
}

// The job's PocketBase client never talks to PocketBase itself: each request goes to the parent over IPC, and the
// parent applies the same isolation checks as the /pb proxy before forwarding it as superuser. So the child never
// holds a credential.
export function ipcFetch(request) {
  return async (url, init = {}) => {
    const req = new Request(url, init);
    const body = ['GET', 'HEAD'].includes(req.method) ? null : Buffer.from(await req.arrayBuffer()).toString('base64');
    const u = new URL(req.url);
    const res = await request({ method: req.method, path: u.pathname + u.search, contentType: req.headers.get('content-type'), body });
    return new Response(res.body ? Buffer.from(res.body, 'base64') : null, { status: res.status, headers: res.contentType ? { 'content-type': res.contentType } : {} });
  };
}

// Request/response over the IPC channel, matched by id.
export function ipcClient(proc = process) {
  let seq = 0;
  const pending = new Map();
  proc.on('message', (msg) => {
    if (msg?.type !== 'pb' || !pending.has(msg.id)) return;
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  });
  return (req) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    proc.send({ type: 'pb', id, ...req });
  });
}

// Collection names in jobs are unprefixed, like in schema.json.
export const prefixer = (prefix) => (name) => (String(name).startsWith(prefix) ? String(name) : `${prefix}${name}`);

export function createContext({ PocketBase, prefix, env, request }) {
  const pb = new PocketBase('http://pb.invalid');
  pb.autoCancellation(false);
  const fetchViaParent = ipcFetch(request);
  pb.beforeSend = (url, options) => ({ url, options: { ...options, fetch: fetchViaParent } });
  const collection = pb.collection.bind(pb);
  const col = prefixer(prefix);
  pb.collection = (name) => collection(col(name));
  return { pb, col, env: Object.freeze({ ...env }), log: (...args) => console.log(...args), fetch: globalThis.fetch };
}
