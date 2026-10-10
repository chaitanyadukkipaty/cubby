// Starts a real Cubby server (and its PocketBase) on free ports with a throwaway data dir.
// Used by integration and e2e tests. Requires ./bin/pocketbase (`npm run setup`).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';

export const ROOT = resolve(import.meta.dirname, '../..');
export const ADMIN = { email: 'admin@test.dev', password: 'admin-pass-123' };
export const SIGNUP_CODE = 'otter-maple-42';

export function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
    srv.on('error', rej);
  });
}

export async function startServer(extraEnv = {}) {
  const pbBin = join(ROOT, 'bin', 'pocketbase');
  if (!existsSync(pbBin)) throw new Error('bin/pocketbase missing: run `npm run setup` first');
  const [port, pbPort] = await Promise.all([freePort(), freePort()]);
  const dataDir = mkdtempSync(join(tmpdir(), 'cubby-test-'));
  const url = `http://localhost:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    BASE_DOMAIN: `localhost:${port}`,
    PUBLIC_URL: url,
    DATA_DIR: dataDir,
    PB_URL: `http://127.0.0.1:${pbPort}`,
    PB_BIN: pbBin,
    PB_SPAWN: '1',
    PB_SUPERUSER_EMAIL: 'superuser@test.internal',
    PB_SUPERUSER_PASSWORD: 'superuser-pass-123456',
    CUBBY_ADMIN_EMAIL: ADMIN.email,
    CUBBY_ADMIN_PASSWORD: ADMIN.password,
    CUBBY_SIGNUP_CODE: SIGNUP_CODE,
    MAX_APPS_PER_USER: '10',
    MAX_DEPLOY_MB: '5',
    ...extraEnv,
  };
  const child = spawn(process.execPath, [join(ROOT, 'server/src/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try {
      const r = await fetch(`${url}/api/info`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  if (Date.now() >= deadline) throw new Error(`server did not start:\n${log}`);

  const stop = async () => {
    if (child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM'); // server kills PocketBase and exits cleanly (flushes coverage)
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { url, port, pbUrl: env.PB_URL, dataDir, env, stop, log: () => log };
}

// Small JSON client for the control API (and app hosts via `host`).
export function client(base, token) {
  return async function call(method, path, { body, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
}

// fetch() can't set Host; app-host requests go through node:http instead.
import http from 'node:http';
export function hostRequest(port, host, method, path, { headers = {}, body } = {}) {
  return new Promise((res, rej) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers: { host, ...headers } }, (r) => {
      let data = '';
      r.on('data', (d) => (data += d));
      r.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch {}
        res({ status: r.statusCode, headers: r.headers, text: data, data: json });
      });
    });
    req.on('error', rej);
    if (body !== undefined) req.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    else req.end();
  });
}

export async function signupUser(base, email, password = 'password1234', code = SIGNUP_CODE) {
  const r = await client(base)('POST', '/api/signup', { body: { email, password, code } });
  if (r.status !== 200) throw new Error(`signup failed: ${JSON.stringify(r.data)}`);
  return r.data.key;
}
