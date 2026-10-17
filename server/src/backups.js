// Nightly backups: a PocketBase backup (all app data) plus a tarball of deployed sites (with their jobs) and the
// key that decrypts app secrets, which must be restored together with the data.
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as tar from 'tar';
import { admin } from './pb.js';
import { config } from './config.js';
import { HttpError } from './http.js';
import { backupKeep } from './logic.js';
import { getSettings } from './settings.js';
import { deleteBackup, listBackups, planRetention } from './storage.js';
import { pruneActivity } from './activity.js';

const backupDir = join(config.dataDir, 'backups');

// Keeps the newest `keep` backups (the Admin setting), deleting older ones as whole pairs by date.
export async function runBackup({ keep } = {}) {
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `cubby-${stamp}.zip`;
  // One backup per day: a manual backup later the same day replaces it.
  if ((await admin.backups.getFullList()).some((b) => b.key === name)) await admin.backups.delete(name);
  await admin.backups.create(name);
  await mkdir(backupDir, { recursive: true });
  // A fresh server has no sites yet; tar refuses an empty list (synchronously), and a pair should always be whole.
  await mkdir(join(config.dataDir, 'sites'), { recursive: true });
  const dirs = ['sites', 'secrets'].filter((d) => existsSync(join(config.dataDir, d)));
  await tar.c({ gzip: true, cwd: config.dataDir, file: join(backupDir, `sites-${stamp}.tar.gz`) }, dirs).catch(() => {});

  const list = await listBackups(admin, config.dataDir);
  const plan = planRetention(list, keep ?? backupKeep(await getSettings()));
  for (const date of plan.delete) await deleteBackup(admin, config.dataDir, list.find((b) => b.date === date));
  console.log(`backup ${stamp} done`);
}

// Runs backups one at a time in the background ("Back up now" and the nightly run share it), so the backup list
// can show one in progress. In memory, like the rest of Cubby's state: it assumes one server process.
export function createBackupRunner({ run = runBackup, now = () => new Date() } = {}) {
  let running = null;
  let last = null;
  return {
    state: () => ({ running, last }),
    start() {
      if (running) throw new HttpError(409, `A backup is already running (started ${running.started_at})`);
      const at = now().toISOString();
      const mine = (running = { date: at.slice(0, 10), started_at: at });
      const end = (error) => {
        last = { ...mine, finished_at: now().toISOString(), ok: !error, error: error?.message ?? null };
        running = null;
      };
      const promise = Promise.resolve().then(run).then(() => end(), (err) => { end(err); throw err; });
      return { ...mine, promise };
    },
  };
}

// The nightly maintenance: prune the activity log (first, so the backup is smaller), then back up.
// A failed prune never stops the backup.
// Steps are injectable for tests.
export async function runMaintenance({ prune = pruneActivity, backup = runBackup, log = console.log, error = console.error } = {}) {
  try {
    const n = await prune();
    if (n) log(`pruned ${n} activity rows`);
  } catch (err) {
    error('activity prune failed:', err.message);
  }
  await backup();
}

// Returns today's date stamp if a nightly backup should run now, otherwise null.
export function backupDue(now, lastRun, hour) {
  const today = now.toISOString().slice(0, 10);
  return now.getHours() === hour && lastRun !== today ? today : null;
}

// Checks every minute; runs at most once per day during the configured hour. Deps injectable for tests.
export function scheduleBackups({ run = runMaintenance, now = () => new Date(), hour = config.backups.hour } = {}) {
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
