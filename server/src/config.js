import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const env = (key, fallback) => process.env[key] ?? fallback;

export const config = {
  port: Number(env('PORT', 8080)),
  baseDomain: env('BASE_DOMAIN', 'localhost:8080'),
  publicUrl: env('PUBLIC_URL', 'http://localhost:8080'),
  dataDir: resolve(root, env('DATA_DIR', './data')),
  version: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version,
  // Only used on first boot; afterwards these live in cubby_settings and are edited in the admin tab.
  initial: {
    adminEmail: env('CUBBY_ADMIN_EMAIL'),
    adminPassword: env('CUBBY_ADMIN_PASSWORD'),
    signupCode: env('CUBBY_SIGNUP_CODE'),
    maxAppsPerUser: Number(env('MAX_APPS_PER_USER', 10)),
    maxDeployMb: Number(env('MAX_DEPLOY_MB', 50)),
  },
  backups: { keep: Number(env('BACKUP_KEEP', 7)), hour: Number(env('BACKUP_HOUR', 3)) },
  keepDeploys: 10,
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
