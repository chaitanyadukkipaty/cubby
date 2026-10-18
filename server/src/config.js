import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildInfo, computeVersion } from './version.js';

const root = resolve(import.meta.dirname, '../..');
const env = (key, fallback) => process.env[key] ?? fallback;
const pkgVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const build = buildInfo(process.env, root);

export const config = {
  port: Number(env('PORT', 8080)),
  baseDomain: env('BASE_DOMAIN', 'localhost:8080'),
  publicUrl: env('PUBLIC_URL', 'http://localhost:8080'),
  dataDir: resolve(root, env('DATA_DIR', './data')),
  // "X.Y.Z" for a release build, "X.Y.Z-dev+<sha>" for anything else (see version.js).
  // CUBBY_VERSION_OVERRIDE is for tests and local development only: it makes this server report (and stamp its
  // /cli.tgz with) another version, so version-skew handling can be tested with two servers from one checkout.
  version: computeVersion({ pkgVersion, override: env('CUBBY_VERSION_OVERRIDE'), commit: build.commit, tag: build.tag }),
  commit: build.commit,
  // Daily check for a newer GitHub release: the only outbound request Cubby itself makes. CUBBY_UPDATE_CHECK=0 turns
  // it off entirely; admins can also turn it off in the Admin page.
  updates: {
    enabled: env('CUBBY_UPDATE_CHECK', '1') !== '0',
    url: env('CUBBY_UPDATE_URL', 'https://api.github.com/repos/chaitanyadukkipaty/cubby/releases/latest'),
  },
  // Only used on first boot; afterwards these live in cubby_settings and are edited in the admin tab.
  initial: {
    adminEmail: env('CUBBY_ADMIN_EMAIL'),
    adminPassword: env('CUBBY_ADMIN_PASSWORD'),
    signupCode: env('CUBBY_SIGNUP_CODE'),
    serverName: env('CUBBY_SERVER_NAME'),
    maxAppsPerUser: Number(env('MAX_APPS_PER_USER', 10)),
    maxDeployMb: Number(env('MAX_DEPLOY_MB', 50)),
  },
  // keep: seeds the backup_keep setting on first boot, and stands in for it on rows from before it existed.
  backups: { keep: Number(env('BACKUP_KEEP', 7)), hour: Number(env('BACKUP_HOUR', 3)) },
  keepDeploys: 10,
  // Set by cubby-server only while fail2ban is enabled on the host: the folder it shares with the host (ban events in,
  // unban requests out) and Caddy's access log, for what a banned scanner swept. Unset: the Security tab is off.
  fail2ban: { dir: env('CUBBY_FAIL2BAN_DIR') || null, accessLog: env('CUBBY_ACCESS_LOG') || null },
  pb: {
    url: env('PB_URL', 'http://127.0.0.1:8090'),
    bin: resolve(root, env('PB_BIN', './bin/pocketbase')),
    listen: env('PB_LISTEN'),
    spawn: env('PB_SPAWN', '1') === '1',
    email: env('PB_SUPERUSER_EMAIL', 'admin@cubby.local'),
    password: env('PB_SUPERUSER_PASSWORD', 'change-me-please-123'),
  },
};

// Project slugs: lowercase, hyphen-separated, used as the subdomain.
export const SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const RESERVED_SLUGS = new Set(['www', 'api', 'app', 'admin', 'cubby', 'pb', 'docs', 'static', 'mail']);

// Every collection of a project is stored as "<slug with _>__<name>" in the shared PocketBase.
// Slugs never contain "__", so the mapping is unambiguous.
export const prefixFor = (slug) => `${slug.replaceAll('-', '_')}__`;
