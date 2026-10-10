// Nightly backups: a PocketBase backup (all app data) plus a tarball of deployed sites.
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as tar from 'tar';
import { admin } from './pb.js';
import { config } from './config.js';

const backupDir = join(config.dataDir, 'backups');

export async function runBackup() {
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `cubby-${stamp}.zip`;
  // One backup per day: a manual backup later the same day replaces it.
  if ((await admin.backups.getFullList()).some((b) => b.key === name)) await admin.backups.delete(name);
  await admin.backups.create(name);
  await mkdir(backupDir, { recursive: true });
  await tar.c({ gzip: true, cwd: config.dataDir, file: join(backupDir, `sites-${stamp}.tar.gz`) }, ['sites']).catch(() => {});

  const pbBackups = (await admin.backups.getFullList()).filter((b) => b.key.startsWith('cubby-')).sort((a, b) => b.key.localeCompare(a.key));
  for (const b of pbBackups.slice(config.backups.keep)) await admin.backups.delete(b.key);
  const siteBackups = (await readdir(backupDir)).filter((f) => f.startsWith('sites-')).sort().reverse();
  for (const f of siteBackups.slice(config.backups.keep)) await rm(join(backupDir, f), { force: true });
  console.log(`backup ${stamp} done`);
}

// Returns today's date stamp if a nightly backup should run now, otherwise null.
export function backupDue(now, lastRun, hour) {
  const today = now.toISOString().slice(0, 10);
  return now.getHours() === hour && lastRun !== today ? today : null;
}

// Checks every minute; runs at most once per day during the configured hour. Deps injectable for tests.
export function scheduleBackups({ run = runBackup, now = () => new Date(), hour = config.backups.hour } = {}) {
  let lastRun = '';
  const timer = setInterval(() => {
    const due = backupDue(now(), lastRun, hour);
    if (!due) return;
    lastRun = due;
    run().catch((err) => console.error('backup failed:', err.message));
  }, 60_000);
  timer.unref();
  return timer;
}
