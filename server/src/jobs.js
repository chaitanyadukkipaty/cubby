// Scheduled jobs: code an app ships in cubby/jobs/, bundled by the CLI into __cubby_jobs/ of each deploy, and run
// here on a cron schedule. Each run is a child process with the Node permission model, an empty environment and a
// hard timeout (job-runner.js). Its PocketBase client acts as superuser but only reaches this app's records: every
// request comes over IPC and passes the same isolation checks as the /pb proxy before it is forwarded.
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admin } from './pb.js';
import { config, prefixFor, SLUG_RE } from './config.js';
import { HttpError } from './http.js';
import { parseCron, cronMatches, nextRun } from './cron.js';
import { isAllowed, checkForeignRefs } from './proxy.js';
import { getSettings } from './settings.js';
import { envFor } from './secrets.js';
import { jobTimeout } from './logic.js';

export const JOBS_DIR = '__cubby_jobs';
export const MAX_JOBS = 20;
export const CONCURRENCY = 2;
export const KEEP_RUNS = 100;
export const MAX_LOG = 64 * 1024;
const MEMORY_MB = 128;
const JOB_FILE_EXTS = new Set(['.mjs', '.js', '.json', '.map']);

// Next to the deploy's site directory, never inside it, so job code is never served.
export const jobsDir = (slug, deployId) => join(config.dataDir, 'sites', slug, `jobs-${deployId}`);

// --- Manifests ---------------------------------------------------------------------------------

// Validates __cubby_jobs/jobs.json ({ format: 1, jobs: [{ name, schedule }] }) against the files that came with it.
export function checkManifest(manifest, files) {
  if (manifest?.format !== 1 || !Array.isArray(manifest.jobs)) {
    throw new HttpError(400, `Invalid ${JOBS_DIR}/jobs.json`, ['Expected { "format": 1, "jobs": [{ "name": ..., "schedule": ... }] }']);
  }
  const errors = [];
  if (manifest.jobs.length > MAX_JOBS) errors.push(`An app can have at most ${MAX_JOBS} jobs`);
  const names = new Set();
  for (const job of manifest.jobs) {
    const name = String(job?.name ?? '');
    if (!SLUG_RE.test(name) || name.length > 40) {
      errors.push(`Job name "${name}" must be lowercase letters, digits and single hyphens (max 40), like the file name in cubby/jobs/`);
      continue;
    }
    if (names.has(name)) errors.push(`Job "${name}" is defined twice`);
    names.add(name);
    try {
      parseCron(job.schedule);
    } catch (err) {
      errors.push(`Job "${name}": ${err.message}`);
    }
    if (!files.includes(`${name}.mjs`)) errors.push(`Job "${name}": ${name}.mjs is missing`);
  }
  for (const f of files) if (!JOB_FILE_EXTS.has(extname(f))) errors.push(`${f}: jobs may only contain .mjs, .js, .json and .map files`);
  if (errors.length) throw new HttpError(400, 'Invalid jobs', errors);
  return manifest.jobs.map((j) => ({ name: j.name, schedule: j.schedule.trim() }));
}

async function listFiles(dir, base = '') {
  const out = [];
  for (const e of await readdir(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else out.push(rel);
  }
  return out;
}

// The jobs in an extracted deploy's __cubby_jobs/, or null if it has none.
export async function readJobsBundle(dir) {
  let files;
  try {
    files = await listFiles(dir);
  } catch {
    return null;
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'jobs.json'), 'utf8'));
  } catch (err) {
    throw new HttpError(400, `Invalid ${JOBS_DIR}/jobs.json: ${err.message}`);
  }
  return checkManifest(manifest, files);
}

// Deploy directories never change, so their manifests are cached for good.
const manifests = new Map();
export async function deployJobs(slug, deployId) {
  if (!deployId) return [];
  const dir = jobsDir(slug, deployId);
  if (!manifests.has(dir)) {
    let jobs = [];
    try {
      jobs = JSON.parse(await readFile(join(dir, 'jobs.json'), 'utf8')).jobs.map(({ name, schedule }) => ({ name, schedule }));
    } catch {}
    manifests.set(dir, jobs);
  }
  return manifests.get(dir);
}

// --- PocketBase access from a job --------------------------------------------------------------

// Records of this app's collections, and their files. Nothing else: no collection or schema endpoints, no batch
// (its body names arbitrary collections), no auth endpoints. Ids are strict so nothing can be smuggled in a segment.
export async function jobRequestAllowed(slug, method, path, index) {
  const m = path.match(/^\/api\/collections\/([a-z0-9_]+)\/records(?:\/[a-zA-Z0-9]+)?$/);
  if (m) return m[1].startsWith(prefixFor(slug));
  if (method === 'GET' && /^\/api\/files\/[a-zA-Z0-9_]+\/[a-zA-Z0-9]+\/[^/]+$/.test(path)) return isAllowed(slug, method, path, index);
  return false;
}

const encodeJson = (status, message) => ({ status, contentType: 'application/json', body: Buffer.from(JSON.stringify({ status, message, data: {} })).toString('base64') });

// Answers one IPC request from a job: the checks above, then PocketBase as superuser. `send` is injectable for tests.
export async function forwardJobRequest(slug, msg, { send = fetch, index } = {}) {
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(msg?.method) || typeof msg.path !== 'string') return encodeJson(400, 'Invalid request');
  if (msg.body && msg.body.length > 40 * 1024 * 1024) return encodeJson(413, 'Request body too large');
  const url = new URL(msg.path, 'http://pb.invalid');
  if (!(await jobRequestAllowed(slug, msg.method, url.pathname, index))) {
    return encodeJson(403, `Jobs can only reach this app's records (collections starting with "${prefixFor(slug)}").`);
  }
  const { foreign } = checkForeignRefs(url.search, null, prefixFor(slug));
  if (foreign) return encodeJson(403, `Cannot reference collection "${foreign}" from this app.`);
  const headers = { authorization: admin.authStore.token };
  if (msg.contentType) headers['content-type'] = msg.contentType;
  try {
    const res = await send(config.pb.url + url.pathname + url.search, { method: msg.method, headers, body: msg.body ? Buffer.from(msg.body, 'base64') : undefined });
    return { status: res.status, contentType: res.headers.get('content-type'), body: Buffer.from(await res.arrayBuffer()).toString('base64') };
  } catch {
    return encodeJson(502, 'PocketBase unavailable');
  }
}

// --- Running one job ---------------------------------------------------------------------------

const RUNNER = fileURLToPath(new URL('./job-runner.js', import.meta.url));
// Real paths throughout: the child's ESM loader resolves symlinks, and may only read what's allowed below.
const SDK = realpathSync(fileURLToPath(import.meta.resolve('pocketbase')));
// --permission since Node 22.13 / 23.5; --experimental-permission before.
const PERMISSION_FLAG = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';

// The child may read only the runner (server/src and the package.json that makes it ESM), the SDK and its job.
// (V8 doesn't write coverage under the permission model, so the child is covered by unit tests of job-sandbox.js.)
export function runnerArgs(dir) {
  const reads = [dirname(RUNNER), join(dirname(RUNNER), '..', 'package.json'), dirname(SDK), dir].map((p) => realpathSync(p));
  return [
    PERMISSION_FLAG,
    ...reads.map((p) => `--allow-fs-read=${p}`),
    `--max-old-space-size=${MEMORY_MB}`,
    '--no-warnings',
    RUNNER,
  ];
}

// Keeps the last `max` characters of a stream of output.
export function logTail(max = MAX_LOG) {
  let text = '';
  let cut = false;
  return {
    push(chunk) {
      text += chunk;
      if (text.length > 2 * max) { text = text.slice(-max); cut = true; }
    },
    text() {
      return cut || text.length > max ? `[earlier output cut]\n${text.slice(-max)}` : text;
    },
  };
}

// Resolves to { status: ok | error | timeout, log, duration_ms }. Never rejects.
export function runJob({ dir, name, prefix, env = {}, timeoutMs, onRequest }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, runnerArgs(dir), { env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const log = logTail();
    child.stdout.on('data', (d) => log.push(d.toString()));
    child.stderr.on('data', (d) => log.push(d.toString()));
    let outcome = null;
    const timer = setTimeout(() => {
      outcome ??= { status: 'timeout', error: `Stopped after ${timeoutMs / 1000}s (the server's job time limit)` };
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('message', async (msg) => {
      if (msg?.type === 'pb') {
        const res = await onRequest(msg);
        if (child.connected) child.send({ type: 'pb', id: msg.id, ...res });
      } else if (msg?.type === 'done') {
        outcome ??= { status: 'ok' };
      } else if (msg?.type === 'error') {
        outcome ??= { status: 'error', error: String(msg.error) };
      }
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      outcome ??= { status: 'error', error: `The job process ended (${signal ?? `exit code ${code}`}) before the job finished, e.g. out of memory (${MEMORY_MB} MB)` };
      if (outcome.error) log.push(`${log.text() && !log.text().endsWith('\n') ? '\n' : ''}${outcome.error}\n`);
      resolve({ status: outcome.status, log: log.text(), duration_ms: Date.now() - started });
    });
    child.send({ file: join(realpathSync(dir), `${name}.mjs`), sdk: SDK, prefix, env });
  });
}

// --- Runs, queue and scheduler -----------------------------------------------------------------

export const runView = (r, { log = true } = {}) => ({
  id: r.id, job: r.job, deploy: r.deploy, trigger: r.trigger, status: r.status, started: r.started,
  duration_ms: r.duration_ms ?? null, ...(log && { log: r.log ?? '' }),
});

const runs = () => admin.collection('cubby_job_runs');
const runsFilter = (project, name) => admin.filter('project = {:p} && job = {:j}', { p: project.id, j: name });

async function execute({ project, job, deploy, trigger }) {
  const started = Date.now();
  const record = await runs().create({ project: project.id, job: job.name, deploy, trigger, status: 'running', started: new Date(started).toISOString() });
  let result;
  try {
    const [settings, env] = await Promise.all([getSettings(), envFor(project)]);
    result = await runJob({
      dir: jobsDir(project.slug, deploy), name: job.name, prefix: prefixFor(project.slug), env,
      timeoutMs: jobTimeout(settings) * 1000, onRequest: (msg) => forwardJobRequest(project.slug, msg),
    });
  } catch (err) {
    result = { status: 'error', log: `${err.message}\n`, duration_ms: Date.now() - started };
  }
  // The app may have been deleted while its job ran (its runs went with it).
  const done = await runs().update(record.id, { status: result.status, duration_ms: result.duration_ms, log: result.log }).catch(() => null);
  const old = await runs().getList(2, KEEP_RUNS, { filter: runsFilter(project, job.name), sort: '-started', fields: 'id', skipTotal: true }).catch(() => ({ items: [] }));
  for (const r of old.items) await runs().delete(r.id).catch(() => {});
  return runView(done ?? { ...record, ...result });
}

const busy = new Set();
const queue = [];
let active = 0;
const runKey = (item) => `${item.project.slug}/${item.job.name}`;

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const { item, resolve, reject } = queue.shift();
    active++;
    execute(item).then(resolve, reject).finally(() => {
      active--;
      busy.delete(runKey(item));
      pump();
    });
  }
}

// Queues a run (at most CONCURRENCY at once, server-wide). A job never overlaps itself: a scheduled run is recorded
// as skipped while the previous one is still going; a manual run is refused.
export async function enqueue(item) {
  if (busy.has(runKey(item))) {
    if (item.trigger === 'manual') throw new HttpError(409, `Job "${item.job.name}" is already running`);
    const now = new Date().toISOString();
    return runView(await runs().create({ project: item.project.id, job: item.job.name, deploy: item.deploy, trigger: item.trigger, status: 'skipped', started: now, duration_ms: 0, log: 'Skipped: the previous run was still going.\n' }));
  }
  busy.add(runKey(item));
  return new Promise((resolve, reject) => {
    queue.push({ item, resolve, reject });
    pump();
  });
}

// Starts every job due at `minute`. Returns what it started, for tests.
export async function tick(minute, { run = enqueue } = {}) {
  if ((await getSettings()).jobs_off) return [];
  const projects = await admin.collection('cubby_projects').getFullList({ filter: 'current_deploy != ""', expand: 'owner' });
  const started = [];
  for (const project of projects) {
    if (project.expand?.owner?.disabled) continue;
    const paused = new Set(project.jobs_paused ?? []);
    for (const job of await deployJobs(project.slug, project.current_deploy)) {
      if (paused.has(job.name) || !cronMatches(parseCron(job.schedule), minute)) continue;
      started.push(`${project.slug}/${job.name}`);
      run({ project, job, deploy: project.current_deploy, trigger: 'cron' }).catch((err) => console.error(`job ${project.slug}/${job.name}:`, err.message));
    }
  }
  return started;
}

// Checks every few seconds and acts once per wall-clock minute. Missed minutes (server down, clock jumps) are
// skipped, not caught up. Deps injectable for tests.
export function scheduleJobs({ now = () => new Date(), onMinute = tick, everyMs = 5_000 } = {}) {
  let last = Math.floor(now().getTime() / 60_000);
  const timer = setInterval(() => {
    const minute = Math.floor(now().getTime() / 60_000);
    if (minute === last) return;
    last = minute;
    onMinute(new Date(minute * 60_000)).catch((err) => console.error('job scheduler:', err.message));
  }, everyMs);
  timer.unref();
  return timer;
}

// Runs that were going when the server stopped never finished.
export async function recoverRuns() {
  for (const r of await runs().getFullList({ filter: 'status = "running"' })) {
    await runs().update(r.id, { status: 'error', log: `${r.log ?? ''}The server restarted while this job was running.\n` });
  }
}

// --- API helpers -------------------------------------------------------------------------------

async function findJob(project, name) {
  const job = (await deployJobs(project.slug, project.current_deploy)).find((j) => j.name === name);
  if (!job) throw new HttpError(404, `No job "${name}" in the current deploy of ${project.slug}`);
  return job;
}

export async function listJobs(project, now = new Date()) {
  const jobs = await deployJobs(project.slug, project.current_deploy);
  if (!jobs.length) return [];
  const recent = await runs().getList(1, 200, { filter: admin.filter('project = {:p}', { p: project.id }), sort: '-started', skipTotal: true });
  const paused = new Set(project.jobs_paused ?? []);
  return jobs.map((j) => {
    const last = recent.items.find((r) => r.job === j.name);
    return {
      name: j.name, schedule: j.schedule, paused: paused.has(j.name),
      next_run: paused.has(j.name) ? null : nextRun(parseCron(j.schedule), now)?.toISOString() ?? null,
      last_run: last ? runView(last, { log: false }) : null,
    };
  });
}

export async function runNow(project, name) {
  const job = await findJob(project, name);
  if ((await getSettings()).jobs_off) throw new HttpError(403, 'Jobs are turned off on this server (Admin tab)');
  return enqueue({ project, job, deploy: project.current_deploy, trigger: 'manual' });
}

export async function jobRuns(project, name, { limit = 1, id } = {}) {
  if (id) {
    const r = await runs().getOne(id).catch(() => null);
    if (!r || r.project !== project.id || r.job !== name) throw new HttpError(404, `Run ${id} not found`);
    return [runView(r)];
  }
  const n = Math.min(Math.max(Number.parseInt(limit, 10) || 1, 1), KEEP_RUNS);
  return (await runs().getList(1, n, { filter: runsFilter(project, name), sort: '-started', skipTotal: true })).items.map((r) => runView(r));
}

export async function setPaused(project, name, paused) {
  await findJob(project, name);
  const set = new Set(project.jobs_paused ?? []);
  if (paused) set.add(name);
  else set.delete(name);
  await admin.collection('cubby_projects').update(project.id, { jobs_paused: [...set] });
  return { name, paused: Boolean(paused) };
}

// Every app's jobs, for the Admin tab.
export async function allJobs(now = new Date()) {
  const projects = await admin.collection('cubby_projects').getFullList({ filter: 'current_deploy != ""', sort: 'slug', expand: 'owner' });
  const out = [];
  for (const p of projects) {
    for (const j of await listJobs(p, now)) out.push({ app: p.slug, owner: p.expand?.owner?.email ?? null, ...j });
  }
  return out;
}
