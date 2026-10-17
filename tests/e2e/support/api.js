// Test-data setup through the control API, so specs only drive the UI they're actually testing.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as tar from 'tar';
import { client, ADMIN } from '../../helpers/server.js';

export const serverUrl = () => {
  if (!process.env.CUBBY_E2E_URL) throw new Error('CUBBY_E2E_URL not set: run through playwright.config.js');
  return process.env.CUBBY_E2E_URL;
};
export const appUrl = (slug) => serverUrl().replace('://localhost', `://${slug}.localhost`);

let counter = 0;
/** Unique, slug-safe id: lowercase letters/digits/hyphens. */
export const uid = (prefix) => `${prefix}-${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

// Signup/login are rate-limited per client IP. The server trusts X-Forwarded-For from loopback
// (its own Caddy), so test setup presents each setup call as a different client.
let ipCounter = 0;
const setupClientIp = () => `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;
let adminTokenCache = null;

async function ok(res, what) {
  if (res.status !== 200) throw new Error(`${what} failed (${res.status}): ${JSON.stringify(res.data)}`);
  return res.data;
}

export class Api {
  constructor(base = serverUrl()) {
    this.base = base;
  }

  as(token) {
    return client(this.base, token);
  }

  /** POST to a rate-limited public auth endpoint as a fresh client. */
  authPost(path, body) {
    return this.as()('POST', path, { body, headers: { 'x-forwarded-for': setupClientIp() } });
  }

  async adminToken() {
    if (!adminTokenCache) adminTokenCache = (await ok(await this.authPost('/api/login', ADMIN), 'admin login')).key;
    return adminTokenCache;
  }

  async settings() {
    const r = await this.as(await this.adminToken())('GET', '/api/admin/overview');
    return (await ok(r, 'admin overview')).settings;
  }

  async updateSettings(patch) {
    const r = await this.as(await this.adminToken())('PATCH', '/api/admin/settings', { body: patch });
    return ok(r, 'update settings');
  }

  /** Creates a user with the current signup code. Returns { email, password, token }. */
  async createUser(prefix = 'user') {
    const email = `${uid(prefix)}@e2e.dev`;
    const password = 'password1234';
    const { signup_code: code } = await this.settings();
    const r = await this.authPost('/api/signup', { email, password, code });
    return { email, password, token: (await ok(r, 'signup')).key };
  }

  async createApp(token, slug, { description = '' } = {}) {
    const r = await this.as(token)('POST', '/api/projects', { body: { slug, name: slug, description } });
    return ok(r, 'create app');
  }

  /** Deploys a one-page site to an existing app (plus any `files`, e.g. bundled jobs). */
  async deploy(token, slug, html = '<!doctype html><title>e2e</title><h1>Hello from e2e</h1>', { unlisted, files = {} } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cubby-e2e-dist-'));
    try {
      writeFileSync(join(dir, 'index.html'), html);
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
      const chunks = [];
      for await (const c of tar.c({ gzip: true, cwd: dir, portable: true }, ['.'])) chunks.push(c);
      const q = unlisted === undefined ? '' : `?unlisted=${unlisted ? 1 : 0}`;
      const r = await this.as(token)('POST', `/api/projects/${slug}/deploys${q}`, {
        raw: Buffer.concat(chunks),
        headers: { 'content-type': 'application/gzip' },
      });
      return ok(r, 'deploy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async createDeployedApp(token, prefix = 'app', opts) {
    const slug = uid(prefix);
    await this.createApp(token, slug, opts);
    await this.deploy(token, slug, undefined, opts);
    return slug;
  }

  /** Deploys an app whose deploy carries jobs, as `cubby deploy` bundles them: { name: { schedule, code } }. */
  async createAppWithJobs(token, prefix, jobs) {
    const slug = uid(prefix);
    await this.createApp(token, slug);
    const files = { '__cubby_jobs/jobs.json': JSON.stringify({ format: 1, jobs: Object.entries(jobs).map(([name, j]) => ({ name, schedule: j.schedule })) }) };
    for (const [name, j] of Object.entries(jobs)) files[`__cubby_jobs/${name}.mjs`] = j.code;
    await this.deploy(token, slug, undefined, { files });
    return slug;
  }

  /** HTTP status of GET /api/me for a token (200 ok, 401 bad token, 403 disabled). */
  async meStatus(token) {
    return (await this.as(token)('GET', '/api/me')).status;
  }

  async project(token, slug) {
    return this.as(token)('GET', `/api/projects/${slug}`);
  }

  async startDeviceLogin() {
    return ok(await this.as()('POST', '/api/device/start'), 'device start');
  }

  async pollDeviceLogin(deviceId) {
    return (await this.as()('POST', '/api/device/poll', { body: { device_id: deviceId } })).data;
  }
}
