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
import { pocketbaseStore, rollupMetrics } from './metrics.js';
import { pruneSnapshots } from './snapshots.js';

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

// What the nightly maintenance cleans up before backing up (first, so the backup is smaller): [name, run], where
// run resolves to a line worth logging, or nothing.
export const MAINTENANCE = [
  ['activity prune', async () => { const n = await pruneActivity(); return n ? `pruned ${n} activity rows` : null; }],
  ['metrics rollup', async () => {
    const { rolled, deleted } = await rollupMetrics({ store: pocketbaseStore(admin) });
    return rolled || deleted ? `metrics: rolled ${rolled} hourly rows into days, deleted ${deleted} daily rows older than a year` : null;
  }],
  ['snapshot prune', async () => { const n = await pruneSnapshots(config.dataDir); return n ? `pruned ${n} data snapshots` : null; }],
];

// The nightly maintenance: the cleanups, then a backup. A failed cleanup never stops the others or the backup.
// Steps are injectable for tests.
export async function runMaintenance({ cleanups = MAINTENANCE, backup = runBackup, log = console.log, error = console.error } = {}) {
  for (const [name, run] of cleanups) {
    try {
      const done = await run();
      if (done) log(done);
    } catch (err) {
      error(`${name} failed:`, err.message);
    }
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
