// Deploys (immutable static bundles on disk) and serving them per project.
import { createReadStream } from 'node:fs';
import { mkdir, rm, rename, stat, readdir } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { admin } from './pb.js';
import { config } from './config.js';
import { HttpError, clip } from './http.js';
import { JOBS_DIR, jobsDir, readJobsBundle } from './jobs.js';

const sitesDir = (slug) => join(config.dataDir, 'sites', slug);

// Extracts a deploy tarball into `dir`, keeping only regular files and directories (no symlinks or
// hardlinks that could escape it). Requires index.html at the root. Cleans up `dir` on failure.
export async function extractDeploy(tarball, dir) {
  await mkdir(dir, { recursive: true });
  let files = 0;
  let bytes = 0;
  try {
    await pipeline(
      Readable.from(tarball),
      tar.x({
        cwd: dir,
        strict: true,
        filter: (_path, entry) => {
          if (entry.type !== 'File' && entry.type !== 'Directory') return false;
          if (entry.type === 'File') { files++; bytes += entry.size; }
          return true;
        },
      }),
    );
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw new HttpError(400, `Invalid tarball: ${err.message}`);
  }
  if (!(await exists(join(dir, 'index.html')))) {
    await rm(dir, { recursive: true, force: true });
    throw new HttpError(400, 'Deploy must contain index.html at its root (upload the contents of dist/)');
  }
  return { files, bytes };
}

export async function createDeploy(project, tarball, message = '', client = '') {
  const tmp = join(config.dataDir, 'tmp', `${project.slug}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const { files, bytes } = await extractDeploy(tarball, tmp);
  const jobs = await readJobsBundle(join(tmp, JOBS_DIR)).catch(async (err) => {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  });

  const record = await admin.collection('cubby_deploys').create({ project: project.id, files, bytes, message, client });
  await mkdir(sitesDir(project.slug), { recursive: true });
  await rename(tmp, join(sitesDir(project.slug), record.id));
  // Job code moves out of the site before the deploy goes live, so it's never served.
  if (jobs) await rename(join(sitesDir(project.slug), record.id, JOBS_DIR), jobsDir(project.slug, record.id));
  await admin.collection('cubby_projects').update(project.id, { current_deploy: record.id, last_deployed: record.created });
  // Keeps keepDeploys in all: the new (current) deploy plus the newest others, for rollback.
  await deleteDeploys(project, oldDeploys(await listDeploys(project), { keep: config.keepDeploys - 1 }));
  return { id: record.id, files, bytes, message, client, created: record.created, jobs: (jobs ?? []).map((j) => j.name) };
}

// Which of `deploys` (newest first, from listDeploys) to delete, oldest first: one by `id`, or all but the
// newest `keep`. Never the current deploy: the app would go down (roll back first to delete it).
export function oldDeploys(deploys, { keep = 0, id } = {}) {
  if (id !== undefined) {
    const d = deploys.find((x) => x.id === id);
    if (!d) throw new HttpError(404, `Deploy ${clip(id)} not found`);
    if (d.current) throw new HttpError(409, `${id} is the current deploy: the app serves it. Roll back to another deploy first.`);
    return [d];
  }
  const n = Number(keep);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'keep must be a whole number of older deploys to keep (0 or more)');
  return deploys.filter((d) => !d.current).slice(n).reverse();
}

// Deletes deploys (records, site folders and their jobs folders), so they're gone from the rollback list too.
// Returns the bytes freed on disk.
export async function deleteDeploys(project, deploys) {
  let freed = 0;
  for (const d of deploys) {
    const dirs = [join(sitesDir(project.slug), d.id), jobsDir(project.slug, d.id)];
    for (const dir of dirs) freed += await dirSize(dir);
    await admin.collection('cubby_deploys').delete(d.id);
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  }
  return freed;
}

export async function listDeploys(project) {
  const records = await admin.collection('cubby_deploys').getFullList({
    filter: admin.filter('project = {:p}', { p: project.id }),
    sort: '-created',
  });
  return records.map((r) => ({ id: r.id, files: r.files, bytes: r.bytes, message: r.message, client: r.client, created: r.created, current: r.id === project.current_deploy }));
}

export async function rollback(project, deployId) {
  const deploys = await listDeploys(project);
  if (!deploys.some((d) => d.id === deployId)) throw new HttpError(404, `Deploy ${clip(deployId)} not found`);
  await admin.collection('cubby_projects').update(project.id, { current_deploy: deployId });
}

export const removeSite = (slug) => rm(sitesDir(slug), { recursive: true, force: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.map': 'application/json',
};

const exists = (p) => stat(p).then((s) => s.isFile(), () => false);

// Resolves to true when it served one of the app's HTML pages (what metrics count as a view), false otherwise.
export async function serveSite(req, res, project, pathname) {
  const fail = (...page) => (sendPage(res, ...page), false);
  if (!project.current_deploy) return fail(404, `${project.slug} has no deploys yet`, 'Run <code>cubby deploy</code> from the project directory.');
  const root = join(sitesDir(project.slug), project.current_deploy);
  let rel;
  try {
    rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  } catch {
    return fail(400, 'Bad request');
  }
  let file = join(root, rel);
  if (!file.startsWith(root + sep) && file !== root) return fail(400, 'Bad request');

  if (!(await exists(file))) {
    if (await exists(join(file, 'index.html'))) file = join(file, 'index.html');
    else if (extname(rel)) return fail(404, 'Not found');
    else file = join(root, 'index.html'); // SPA fallback for client-side routes
  }
  const isHtml = extname(file) === '.html';
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': isHtml ? 'no-cache' : rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') return (res.end(), isHtml);
  createReadStream(file).pipe(res);
  return isHtml;
}

export function sendPage(res, status, title, body = '') {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh;color:#334">
<div style="text-align:center"><h1 style="font-weight:600">${title}</h1><p>${body}</p></div></body>`);
}


// Total bytes under a directory (0 if it doesn't exist).
export async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await stat(p)).size;
  }
  return total;
}

// Disk used by an app: its deploys plus files uploaded to its PocketBase collections.
export async function appDiskUsage(slug, collectionIds) {
  let total = await dirSize(sitesDir(slug));
  for (const id of collectionIds) total += await dirSize(join(config.dataDir, 'pb_data', 'storage', id));
  return total;
}
