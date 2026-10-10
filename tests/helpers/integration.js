// Shared helpers for integration tests (real server + PocketBase from ./server.js).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as tar from 'tar';
import { hostRequest, SIGNUP_CODE } from './server.js';

// Requests come from loopback, where the server trusts X-Forwarded-For (like behind Caddy).
// A fresh fake client IP per request keeps per-IP rate limits out of the way.
let ipCounter = 0;
export const nextIp = () => `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;

export function api(base, token) {
  return async (method, path, { body, headers = {}, raw, ip = nextIp() } = {}) => {
    const h = { 'x-forwarded-for': ip, ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, text, headers: res.headers };
  };
}

export async function signup(base, email, { password = 'password1234', code = SIGNUP_CODE } = {}) {
  const r = await api(base)('POST', '/api/signup', { body: { email, password, code } });
  if (r.status !== 200) throw new Error(`signup ${email} failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.key;
}

export async function adminToken(base, admin) {
  const r = await api(base)('POST', '/api/login', { body: admin });
  if (r.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(r.data)}`);
  return r.data.key;
}

// Builds a gzip tarball from { 'path': 'content' } (and optional symlinks { 'name': 'target' }).
export async function tarball(files, { symlinks = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cubby-tgz-'));
  try {
    for (const [p, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), content);
    }
    for (const [name, target] of Object.entries(symlinks)) symlinkSync(target, join(dir, name));
    const chunks = [];
    for await (const c of tar.c({ gzip: true, cwd: dir, portable: true }, ['.'])) chunks.push(c);
    return Buffer.concat(chunks);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const deployTo = (call, slug, files, query = '', headers = {}) =>
  tarball(files).then((raw) => call('POST', `/api/projects/${slug}/deploys${query}`, { raw, headers: { 'content-type': 'application/gzip', ...headers } }));

// Requests to <slug>.localhost:<port> (Host-routed app traffic).
export const app = (srv, slug) => (method, path, opts = {}) => hostRequest(srv.port, `${slug}.localhost:${srv.port}`, method, path, opts);
