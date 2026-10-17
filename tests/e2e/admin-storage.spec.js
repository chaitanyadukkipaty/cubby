// Admin → Storage and Settings → Backups: where the disk goes, backing up now, deleting a backup pair (with the
// only-backup guard), the restore command, older deploys, and what a retention setting would free.
import { test, expect } from './support/fixtures.js';
import { uid } from './support/api.js';

test.beforeEach(async ({ api, dashboard }) => {
  await dashboard.openAs(await api.adminToken());
});

test('storage: back up now, copy the restore command, and delete the only backup pair after its warning', async ({ page, context, api, dashboard }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { admin } = dashboard;
  const owner = await api.createUser('stor');
  const slug = await api.createDeployedApp(owner.token, 'stor');
  await dashboard.openAdmin('Storage');
  await expect(admin.diskBar).toBeVisible();
  await expect(page.getByRole('list').filter({ hasText: 'Free' })).toBeVisible();
  await expect(admin.appsBySize.getByRole('row').filter({ hasText: slug })).toBeVisible();

  await admin.backUpNowButton.click();
  await expect(dashboard.toast).toHaveText(/Backup (started|done)/);
  const date = new Date().toISOString().slice(0, 10);
  const row = admin.backupRow(date);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText('newest');

  const chip = row.getByRole('button', { name: /^Copy restore command/ });
  await expect(chip).toHaveText(`sudo cubby-server restore ${date}`);
  await chip.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`sudo cubby-server restore ${date}`);

  // Every other backup goes first, so this one is the only one and the guard shows.
  for (;;) {
    const others = (await admin.backupRows.allInnerTexts()).slice(1).map((t) => t.slice(0, 10)).filter((d) => d !== date);
    if (!others.length) break;
    page.once('dialog', (d) => d.accept());
    await admin.backupRow(others[0]).getByRole('button', { name: /^Delete backup/ }).click();
    await expect(admin.backupRow(others[0])).toHaveCount(0);
  }
  let message = '';
  page.once('dialog', (d) => { message = d.message(); d.dismiss(); });
  await row.getByRole('button', { name: `Delete backup ${date}` }).click();
  await expect.poll(() => message).toMatch(new RegExp(`^Delete ${date}, the only backup\\? Nothing is left to restore`));
  await expect(row).toBeVisible(); // dismissed: still there

  page.once('dialog', (d) => d.accept());
  await row.getByRole('button', { name: `Delete backup ${date}` }).click();
  await expect(dashboard.toast).toHaveText(new RegExp(`^Deleted backup ${date}, freed `));
  await expect(row).toHaveCount(0);
  await expect(admin.backups).toContainText('No backups yet.');
  const left = await api.as(await api.adminToken())('GET', '/api/admin/backups');
  expect(left.data.backups.map((b) => b.date)).not.toContain(date);
});

test('apps: older deploys are listed per app and deleted, never the live one', async ({ page, api, dashboard }) => {
  const { admin } = dashboard;
  const owner = await api.createUser('olddep');
  const slug = await api.createDeployedApp(owner.token, 'olddep');
  await api.deploy(owner.token, slug);
  await api.deploy(owner.token, slug);
  await dashboard.openAdmin('Apps');
  await admin.appRow(slug).deploysButton.click();
  const older = page.getByRole('table', { name: `Older deploys of ${slug}` });
  await expect(older.getByRole('row')).toHaveCount(2);
  page.once('dialog', (d) => d.accept());
  await older.getByRole('button', { name: /^Delete deploy/ }).first().click();
  await expect(dashboard.toast).toHaveText(/^Deleted \S+, freed /);
  await expect(older.getByRole('row')).toHaveCount(1);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete all older' }).click();
  await expect(dashboard.toast).toHaveText(/^Deleted 1 deploys, freed /);
  await expect(page.getByText('No older deploys: only the live one.')).toBeVisible();
  expect((await api.deploys(owner.token, slug)).map((d) => d.current)).toEqual([true]);
});

test('settings: the backup retention shows what it would free or add before saving', async ({ api, dashboard }) => {
  const { admin } = dashboard;
  const before = (await api.settings()).backup_keep;
  await dashboard.openAdmin('Settings');
  await expect(admin.backupKeep).toHaveValue(String(before));
  await admin.backupKeep.fill('30');
  await expect(dashboard.page.getByText(/^Keeping 30 (changes nothing now|takes about)/)).toBeVisible();
  await admin.backupKeep.fill('500');
  await expect(dashboard.page.getByText('Keep between 1 and 90 nightly backups.')).toBeVisible();
  await admin.backupKeep.fill('30');
  await admin.saveRetentionButton.click();
  await expect(dashboard.toast).toHaveText('Backup retention saved');
  expect((await api.settings()).backup_keep).toBe(30);
  await api.updateSettings({ backup_keep: before });
});

test('agents: every agent that changed something, across users, with its owner', async ({ api, dashboard }) => {
  const owner = await api.createUser('agowner');
  const agentToken = await api.connectAgent(owner.token, { tool: 'Codex', machine: 'e2e-box' });
  const slug = uid('agapp');
  await api.createApp(agentToken, slug);
  await dashboard.openAdmin('Agents');
  const row = dashboard.admin.agentsTable.getByRole('row').filter({ hasText: owner.email });
  await expect(row.getByRole('cell').first()).toHaveText(/Codex · e2e-box/);
  await expect(row.getByRole('cell').nth(2)).toHaveText(/^[1-9]\d*$/); // its login and the app it created
  await expect(row).toContainText(slug);
});
