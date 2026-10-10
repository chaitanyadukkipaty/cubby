#!/usr/bin/env node
// The global `cubby` command. Servers can run different Cubby versions, so app commands run the CLI that
// matches the target server's version: the bundled one when they match, otherwise a copy of that
// server's /cli.tgz cached in ~/.cubby/cli/<version>/. Account commands always use the bundled CLI.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import * as tar from 'tar';
import { readConfig, writeConfig, resolveTarget, readProject } from './servers.js';

export const BUNDLED_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const VERSION_TTL_MS = 10 * 60 * 1000;

// Commands whose behavior depends on the server's version. Everything else (login, servers, skill, help…)
// only uses endpoints that every version keeps, and must run in the newest CLI so old CLIs never rewrite
// the config.
export const SERVER_COMMANDS = new Set(['init', 'link', 'projects', 'info', 'delete', 'schema', 'deploy', 'deploys', 'rollback', 'version']);

// Minimal argv reading: the command, and --server (both "--server x" and "--server=x").
export function parseLaunchArgs(argv) {
  let command = null;
  let server;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--server') { server = argv[++i]; continue; }
    if (a.startsWith('--server=')) { server = a.slice('--server='.length); continue; }
    if (!command && !a.startsWith('-')) command = a;
    rest.push(a);
  }
  return { command, server, argsWithoutServer: rest };
}

export const cachedVersion = (server, now, ttl = VERSION_TTL_MS) =>
  server?.version && server.version_checked_at && now - server.version_checked_at < ttl ? server.version : null;

export const cliRoot = (home) => join(home, '.cubby', 'cli');
export const cliEntry = (home, version) => join(cliRoot(home), version, 'package', 'src', 'index.js');

// The node_modules directory the launcher's own dependencies resolve from; cached CLIs share it.
export function sharedNodeModules() {
  let dir = dirname(fileURLToPath(import.meta.resolve('tar')));
  while (basename(dir) !== 'node_modules') {
    const up = dirname(dir);
    if (up === dir) throw new Error('could not locate node_modules for tar');
    dir = up;
  }
  return dir;
}

// Downloads a server's CLI into ~/.cubby/cli/<version>/ via a temp dir + rename, so a crash or a
// concurrent run never leaves a half-installed copy. Returns the version actually installed.
export async function installCli({ home, url, download, nodeModules }) {
  const tgz = await download(`${url}/cli.tgz`);
  const root = cliRoot(home);
  mkdirSync(root, { recursive: true });
  const tmp = join(root, `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  mkdirSync(tmp);
  try {
    await pipeline(Readable.from(tgz), tar.x({ cwd: tmp, strict: true }));
    const pkg = JSON.parse(readFileSync(join(tmp, 'package', 'package.json'), 'utf8'));
    if (!existsSync(join(tmp, 'package', 'src', 'index.js'))) throw new Error('cli.tgz has no src/index.js');
    symlinkSync(nodeModules, join(tmp, 'package', 'node_modules'), 'dir');
    const final = join(root, pkg.version);
    if (existsSync(final)) rmSync(tmp, { recursive: true, force: true }); // another run got there first
    else renameSync(tmp, final);
    return pkg.version;
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

const semverKey = (v) => v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? p.padStart(8, '0') : p)).join('.');
export const cachedVersions = (home) =>
  existsSync(cliRoot(home)) ? readdirSync(cliRoot(home)).filter((v) => !v.startsWith('.') && existsSync(cliEntry(home, v))).sort((a, b) => semverKey(b).localeCompare(semverKey(a))) : [];

// Decides which CLI runs. All I/O comes in through `deps` so every branch is unit-testable.
export async function plan(argv, deps) {
  const { home, env, cwd, now, fetchVersion, download, nodeModules, bundledVersion = BUNDLED_VERSION } = deps;
  const { command, server: flag, argsWithoutServer } = parseLaunchArgs(argv);
  if (!SERVER_COMMANDS.has(command) || env.CUBBY_LAUNCHED) return { run: 'bundled' };

  const configFile = join(home, '.cubby', 'config.json');
  const cfg = readConfig(configFile);
  const project = readProject(resolve(cwd, 'cubby.json'));
  let target;
  try {
    target = resolveTarget(cfg, { flag, env: env.CUBBY_SERVER, projectServer: project?.server });
  } catch {
    return { run: 'bundled' }; // let the CLI report the problem in its usual way
  }

  const notes = [];
  let version = cachedVersion(target.server, now());
  if (!version) {
    try {
      version = await fetchVersion(target.url);
      if (target.server) {
        cfg.servers[target.id] = { ...target.server, version, version_checked_at: now() };
        writeConfig(configFile, cfg);
      }
    } catch {
      version = target.server?.version ?? null;
      if (version && version !== bundledVersion) notes.push(`note: can't reach ${target.url}; using the cached CLI for its last known version ${version}`);
    }
  }
  if (!version || version === bundledVersion) return { run: 'bundled', notes };

  const childEnv = { ...env, CUBBY_LAUNCHED: '1', CUBBY_SERVER: target.url };
  if (target.server?.token && !env.CUBBY_TOKEN) childEnv.CUBBY_TOKEN = target.server.token;
  if (!existsSync(cliEntry(home, version))) {
    try {
      version = await installCli({ home, url: target.url, download, nodeModules });
    } catch (err) {
      notes.push(`note: couldn't fetch the CLI for ${target.url} (v${version}): ${err.message}; using the bundled v${bundledVersion}`);
      return { run: 'bundled', notes };
    }
  }
  // --server is resolved here and passed as CUBBY_SERVER: older CLIs only understand URLs.
  return { run: 'cached', version, entry: cliEntry(home, version), args: argsWithoutServer, env: childEnv, notes };
}

export async function fetchVersion(url) {
  const res = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const info = await res.json();
  if (!info.version) throw new Error('no version');
  return info.version;
}

export async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function main(argv = process.argv.slice(2)) {
  const p = await plan(argv, {
    home: homedir(), env: process.env, cwd: process.cwd(), now: Date.now, fetchVersion, download, nodeModules: sharedNodeModules(),
  });
  for (const n of p.notes ?? []) console.error(n);
  if (p.run === 'bundled') return import('./index.js');
  const r = spawnSync(process.execPath, [p.entry, ...p.args], { stdio: 'inherit', env: p.env });
  process.exit(r.status ?? 1);
}

// npm installs the bin as a symlink, so compare real paths.
const isEntry = () => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isEntry()) await main();
