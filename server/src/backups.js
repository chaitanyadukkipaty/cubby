// Nightly backups: a PocketBase backup (all app data) plus a tarball of deployed sites (with their jobs) and the
// key that decrypts app secrets, which must be restored together with the data.
import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
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
import { bansStore, pruneBans } from './bans.js';

// Keeps the newest `keep` backups (the Admin setting), deleting older ones as whole pairs by date. `pb` (the
// superuser client), `dataDir`, `now`, `createTar` and `log` are injectable for tests.
// One backup per day: a manual backup later the same day replaces it, but only once the new pair is complete. Both
// files are written under temporary names first and then renamed over the day's pair, so a failure leaves the
// earlier one as it was. PocketBase keeps its backups as files in pb_data/backups (each with a `.attrs` file of
// metadata; docker/cubby-server reads the same folder), so its new zip is renamed there.
export async function runBackup({ keep, pb = admin, dataDir = config.dataDir, now = () => new Date(), createTar = tar.c, log = console.log } = {}) {
  const stamp = now().toISOString().slice(0, 10);
  const name = `cubby-${stamp}.zip`;
  const temp = `cubby-${stamp}-new.zip`;
  const pbDir = join(dataDir, 'pb_data', 'backups');
  const backupDir = join(dataDir, 'backups');
  const sites = join(backupDir, `sites-${stamp}.tar.gz`);
  const sitesTemp = `${sites}.new`;
  // Left over by a run that died halfway.
  if ((await pb.backups.getFullList()).some((b) => b.key === temp)) await pb.backups.delete(temp);
  await pb.backups.create(temp);
  try {
    await mkdir(backupDir, { recursive: true });
    // A fresh server has no sites yet; tar refuses an empty list (synchronously), and a pair should always be whole.
    await mkdir(join(dataDir, 'sites'), { recursive: true });
    const dirs = ['sites', 'secrets'].filter((d) => existsSync(join(dataDir, d)));
    await createTar({ gzip: true, cwd: dataDir, file: sitesTemp }, dirs);
  } catch (err) {
    await rm(sitesTemp, { force: true });
    await pb.backups.delete(temp).catch(() => {});
    throw err;
  }
  if (existsSync(join(pbDir, temp))) {
    for (const ext of ['', '.attrs']) {
      if (existsSync(join(pbDir, temp + ext))) await rename(join(pbDir, temp + ext), join(pbDir, name + ext));
    }
  } else {
    // A PocketBase not started by Cubby keeps its files elsewhere: replace the day's backup through its API, keeping
    // the new one until that's done.
    if ((await pb.backups.getFullList()).some((b) => b.key === name)) await pb.backups.delete(name);
    await pb.backups.create(name);
    await pb.backups.delete(temp);
  }
  await rename(sitesTemp, sites);

  const list = await listBackups(pb, dataDir);
  const plan = planRetention(list, keep ?? backupKeep(await getSettings()));
  for (const date of plan.delete) await deleteBackup(pb, dataDir, list.find((b) => b.date === date));
  log(`backup ${stamp} done`);
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
  ['bans prune', async () => { const n = await pruneBans(bansStore(admin)); return n ? `pruned ${n} ban records older than 90 days` : null; }],
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
