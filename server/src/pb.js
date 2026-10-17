// Shared PocketBase: process management, superuser client, and platform collections.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import PocketBase from 'pocketbase';
import { config } from './config.js';

export const admin = new PocketBase(config.pb.url);
admin.autoCancellation(false);

let child;
const shutdownHooks = [];

// Work to finish on SIGINT/SIGTERM before PocketBase stops (only when this process runs PocketBase).
export const onShutdown = (fn) => { shutdownHooks.push(fn); };

export async function startPocketBase() {
  if (config.pb.spawn) {
    const dir = join(config.dataDir, 'pb_data');
    mkdirSync(dir, { recursive: true });
    execFileSync(config.pb.bin, ['superuser', 'upsert', config.pb.email, config.pb.password, '--dir', dir]);
    const host = config.pb.listen || new URL(config.pb.url).host;
    child = spawn(config.pb.bin, ['serve', '--http', host, '--dir', dir], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => {
      console.error(`PocketBase exited with code ${code}`);
      process.exit(1);
    });
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, async () => {
        // Hooks (the metrics flush) still need PocketBase, so they run first, for a few seconds at most.
        await Promise.race([Promise.allSettled(shutdownHooks.map((fn) => fn())), new Promise((r) => setTimeout(r, 3000))]);
        child.kill();
        process.exit(0);
      });
    }
  }
  await connectAdmin();
  await ensurePlatformCollections();
}

// Authenticates the shared superuser client against an already-running PocketBase.
export async function connectAdmin() {
  await waitForHealth();
  await admin.collection('_superusers').authWithPassword(config.pb.email, config.pb.password, { autoRefreshThreshold: 30 * 60 });
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${config.pb.url}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`PocketBase not reachable at ${config.pb.url}`);
}

const LOCKED = { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null };
const autodates = [
  { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
  { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
];

async function upsertCollection(def) {
  try {
    const existing = await admin.collections.getOne(def.name);
    const fields = def.fields && mergeFieldIds(existing.fields, def.fields);
    return await admin.collections.update(existing.id, { ...def, ...(fields && { fields }) });
  } catch (err) {
    if (err.status !== 404) throw err;
    return await admin.collections.create(def);
  }
}

// Keep existing field ids so PocketBase updates fields in place instead of recreating them.
export function mergeFieldIds(existingFields, fields) {
  const byName = new Map(existingFields.map((f) => [f.name, f]));
  const merged = fields.map((f) => (byName.has(f.name) ? { ...f, id: byName.get(f.name).id } : f));
  // System fields (id, password, tokenKey, email...) must always be kept.
  for (const f of existingFields) if (f.system && !merged.some((m) => m.name === f.name)) merged.unshift(f);
  return merged;
}

// Adds any missing fields to an existing collection, leaving everything else untouched.
async function ensureFields(name, fields, extra = {}) {
  const col = await admin.collections.getOne(name);
  const missing = fields.filter((f) => !col.fields.some((e) => e.name === f.name));
  return admin.collections.update(col.id, { ...extra, ...(missing.length && { fields: [...col.fields, ...missing] }) });
}

async function ensurePlatformCollections() {
  // Platform accounts live in the default "users" auth collection; only the server may touch them.
  const users = await ensureFields('users', [
    { name: 'is_admin', type: 'bool' },
    { name: 'disabled', type: 'bool' },
  ], LOCKED);

  const projects = await upsertCollection({
    name: 'cubby_projects',
    type: 'base',
    ...LOCKED,
    fields: [
      { name: 'slug', type: 'text', required: true, max: 40 },
      { name: 'name', type: 'text', max: 100 },
      { name: 'description', type: 'text', max: 300 },
      { name: 'owner', type: 'relation', collectionId: users.id, maxSelect: 1, required: true, cascadeDelete: true },
      { name: 'current_deploy', type: 'text' },
      { name: 'last_deployed', type: 'date' },
      { name: 'unlisted', type: 'bool' },
      { name: 'schema_hash', type: 'text' },
      // Names of jobs paused by the owner; kept across deploys and rollbacks.
      { name: 'jobs_paused', type: 'json' },
      ...autodates,
    ],
    indexes: ['CREATE UNIQUE INDEX idx_cubby_projects_slug ON cubby_projects (slug)'],
  });

  // One token per user. Stored in plain text (superuser-only collection) so the dashboard can show it again.
  await upsertCollection({
    name: 'cubby_api_keys',
    type: 'base',
    ...LOCKED,
    fields: [
      { name: 'owner', type: 'relation', collectionId: users.id, maxSelect: 1, required: true, cascadeDelete: true },
      { name: 'label', type: 'text', max: 100 },
      { name: 'key', type: 'text' },
      { name: 'key_hash', type: 'text', required: true },
      { name: 'last_used', type: 'date' },
      ...autodates,
    ],
    indexes: ['CREATE UNIQUE INDEX idx_cubby_api_keys_hash ON cubby_api_keys (key_hash)'],
  });

  await upsertCollection({
    name: 'cubby_deploys',
    type: 'base',
    ...LOCKED,
    fields: [
      { name: 'project', type: 'relation', collectionId: projects.id, maxSelect: 1, required: true, cascadeDelete: true },
      { name: 'files', type: 'number' },
      { name: 'bytes', type: 'number' },
      { name: 'message', type: 'text', max: 500 },
      { name: 'client', type: 'text', max: 60 },
      ...autodates,
    ],
  });

  // Single-row server settings, editable from the admin tab.
  await upsertCollection({
    name: 'cubby_settings',
    type: 'base',
    ...LOCKED,
    fields: [
      { name: 'server_name', type: 'text', max: 60 },
      { name: 'signup_code', type: 'text' },
      { name: 'open_signup', type: 'bool' },
      { name: 'max_apps_per_user', type: 'number', onlyInt: true },
      { name: 'max_deploy_mb', type: 'number', onlyInt: true },
      // Stored inverted so settings rows created before this field existed (false) keep the check on.
      { name: 'update_check_off', type: 'bool' },
      // Same for the jobs kill switch. A job_timeout_s of 0 (rows from before jobs) means the default.
      { name: 'jobs_off', type: 'bool' },
      { name: 'job_timeout_s', type: 'number', onlyInt: true },
      ...autodates,
    ],
  });

  // Scheduled job runs (jobs.js), pruned to the last 100 per job.
  await upsertCollection({
    name: 'cubby_job_runs',
    type: 'base',
    ...LOCKED,
    fields: [
      { name: 'project', type: 'relation', collectionId: projects.id, maxSelect: 1, required: true, cascadeDelete: true },
      { name: 'job', type: 'text', required: true, max: 40 },
      { name: 'deploy', type: 'text' },
      { name: 'trigger', type: 'text', max: 20 },
      { name: 'status', type: 'text', max: 20 },
      { name: 'started', type: 'date' },
      { name: 'duration_ms', type: 'number', onlyInt: true },
      { name: 'log', type: 'text', max: 70_000 },
      ...autodates,
    ],
    indexes: ['CREATE INDEX idx_cubby_job_runs_job ON cubby_job_runs (project, job, started)'],
  });

  // App metrics (metrics.js): per-app counts in hourly and UTC-daily buckets ("hour" / "day"), added to on every
  // flush. Never holds IPs. Later counters (API requests, errors, peaks) are new number fields on the same buckets.
  await upsertCollection({
    name: 'cubby_metrics',
    type: 'base',
    ...LOCKED,
    fields: [
      { name: 'project', type: 'relation', collectionId: projects.id, maxSelect: 1, required: true, cascadeDelete: true },
      { name: 'period', type: 'text', required: true, max: 10 },
      { name: 'start', type: 'date', required: true },
      { name: 'views', type: 'number', onlyInt: true },
      { name: 'visitors', type: 'number', onlyInt: true },
      ...autodates,
    ],
    indexes: ['CREATE UNIQUE INDEX idx_cubby_metrics_bucket ON cubby_metrics (project, period, start)'],
  });

  // App secrets for jobs (secrets.js), encrypted with the server key.
  await upsertCollection({
    name: 'cubby_app_env',
    type: 'base',
    ...LOCKED,
    fields: [
      { name: 'project', type: 'relation', collectionId: projects.id, maxSelect: 1, required: true, cascadeDelete: true },
      { name: 'key', type: 'text', required: true, max: 64 },
      { name: 'value', type: 'text', max: 20_000 },
      ...autodates,
    ],
    indexes: ['CREATE UNIQUE INDEX idx_cubby_app_env_key ON cubby_app_env (project, `key`)'],
  });
}
