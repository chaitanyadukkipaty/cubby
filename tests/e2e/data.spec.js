// An app's Data tab: clearing data only after a preview and a typed confirmation, the snapshot it leaves and
// restoring it; deleting by filter; and an admin clearing someone else's app, which the owner is told about.
import { test, expect } from './support/fixtures.js';
import { uid } from './support/api.js';
import { DashboardPage } from './pages/dashboard-page.js';

const SCHEMA = { collections: [
  { name: 'tasks', listRule: '', viewRule: '', createRule: '', fields: [{ name: 'title', type: 'text' }, { name: 'done', type: 'bool' }] },
  { name: 'members', type: 'auth', fields: [{ name: 'nick', type: 'text' }] },
] };
const TASKS = [['Buy milk', true], ['Call mum', true], ['Book flights', true], ['Water plants', false], ['Pay rent', false]].map(([title, done]) => ({ title, done }));

async function appWithTasks(api, prefix) {
  const owner = await api.createUser(prefix);
  const slug = uid(prefix);
  await api.createApp(owner.token, slug);
  await api.pushSchema(owner.token, slug, SCHEMA);
  await api.addRecords(slug, 'tasks', TASKS);
  return { owner, slug };
}

test('empty a collection: preview, typed confirmation, snapshot, then restore it', async ({ page, api, dashboard }) => {
  const { owner, slug } = await appWithTasks(api, 'data');
  const { data, app } = dashboard;
  await dashboard.openAs(owner.token, `/apps/${slug}/data`);
  await expect(app.currentTab).toHaveText('Data');
  await expect(data.collectionRow('tasks')).toContainText('5');
  await expect(data.tick('tasks')).toBeChecked();
  await expect(data.tick('members')).not.toBeChecked(); // accounts are left alone unless ticked
  await expect(data.authWarning).toBeHidden();
  await data.tick('members').check();
  await expect(data.authWarning).toBeVisible();
  await data.tick('members').uncheck();

  // Nothing unlocks the button but a preview of this exact request and the typed name.
  await data.confirm(slug);
  await expect(data.deleteButton).toBeDisabled();
  await expect(page.getByText(/^Preview first/)).toBeVisible();
  await data.previewButton.click();
  await expect(data.preview).toContainText('Empties tasks: 5 records.');
  await expect(data.samples.locator('tbody tr')).toHaveCount(5);
  await expect(data.deleteButton).toBeEnabled();
  await data.tick('members').check(); // a changed request needs a new preview
  await expect(data.deleteButton).toBeDisabled();
  await data.tick('members').uncheck();
  await data.previewButton.click();
  await expect(data.deleteButton).toBeEnabled();
  await data.deleteButton.click();

  await expect(data.result).toContainText(/Deleted 5 records\. Snapshot \S+ can bring them back until/);
  await expect(data.collectionRow('tasks')).toContainText('0');
  expect((await api.dataCounts(owner.token, slug)).tasks).toBe(0);
  const id = await data.newestSnapshotId();
  const snap = data.snapshotRow(id);
  await expect(snap.row).toContainText('empty tasks');

  // Restore: a dry run first (drift and counts), then the real thing.
  await snap.restoreButton.click();
  await expect(data.restorePanel).toContainText('Restores 5 records into tasks.');
  await expect(data.restorePanel).toContainText('No schema changes since the snapshot.');
  page.once('dialog', (d) => d.accept());
  await data.restorePanel.getByRole('button', { name: `Restore ${id}` }).click();
  await expect(data.result).toContainText(`Restored 5 records from ${id}.`);
  await expect(data.collectionRow('tasks')).toContainText('5');
  expect((await api.dataCounts(owner.token, slug)).tasks).toBe(5);

  // Restoring again is harmless: the records exist, so they are skipped unless Overwrite is ticked.
  await data.snapshotRow(id).restoreButton.click();
  await expect(data.restorePanel).toContainText('Restores 0 of 5 records into tasks. 5 exist again and are skipped');
  await data.overwrite.check();
  await expect(data.restorePanel).toContainText('5 that exist again are replaced');
});

test('delete records by filter: matches N of M, sample records, then only those go', async ({ page, api, dashboard }) => {
  const { owner, slug } = await appWithTasks(api, 'filt');
  const { data } = dashboard;
  await dashboard.openAs(owner.token, `/apps/${slug}/data`);
  await data.mode('Delete records of one collection').check();
  await data.collectionSelect.selectOption('tasks');
  await expect(data.previewButton).toBeDisabled(); // no filter yet
  await page.getByRole('button', { name: 'done = true', exact: true }).click(); // an example fills the box
  await expect(data.filter).toHaveValue('done = true');
  await data.previewButton.click();
  await expect(data.preview).toContainText('Matches 3 of 5 records in tasks.');
  await expect(data.samples.locator('tbody tr')).toHaveCount(3);
  await expect(data.samples).toContainText('title: Buy milk');

  // Ticking samples narrows it to just those records.
  await data.samples.getByRole('checkbox', { name: /^Only / }).first().check();
  await data.preview.getByRole('button', { name: 'Preview only the ticked records' }).click();
  await expect(data.preview).toContainText('Matches 1 of 5 records in tasks.');
  await data.preview.getByRole('button', { name: 'Back to every matching record' }).click();
  await expect(data.preview).toContainText('Matches 3 of 5 records in tasks.');

  await data.confirm(slug);
  await expect(data.deleteButton).toHaveText('Delete matching records');
  await data.deleteButton.click();
  await expect(data.result).toContainText('Deleted 3 records.');
  expect((await api.dataCounts(owner.token, slug)).tasks).toBe(2);
  await expect(data.snapshotRow(await data.newestSnapshotId()).row).toContainText('filter tasks');

  // The "created before" shortcut writes the filter.
  await data.mode('Delete records of one collection').check();
  await data.createdBefore.fill('2020-01-01');
  await expect(data.filter).toHaveValue('created < "2020-01-01 00:00:00.000Z"');
  await data.previewButton.click();
  await expect(data.preview).toContainText('Matches 0 of 2 records in tasks.');
  await data.confirm(slug);
  await expect(page.getByText('Nothing matches, so there is nothing to delete.')).toBeVisible();
  await expect(data.deleteButton).toBeDisabled();
});

test("an admin clears someone else's app with a reason; the owner sees a banner and a Home item, and dismisses it", async ({ page, browser, baseURL, api, dashboard }) => {
  const { owner, slug } = await appWithTasks(api, 'adcl');
  const { data, admin } = dashboard;
  await dashboard.openAs(await api.adminToken());
  await dashboard.openAdmin('Apps');
  await admin.appRow(slug).clearDataLink.click();
  await expect(page).toHaveURL(new RegExp(`/admin/apps/${slug}$`));
  await expect(page.getByText(/clearing its data needs a reason/)).toBeVisible();
  await data.previewButton.click();
  await expect(data.preview).toContainText('Empties tasks: 5 records.');
  await data.confirm(slug);
  await expect(data.deleteButton).toBeDisabled();
  await expect(page.getByText('Give a reason: the owner sees it.')).toBeVisible();
  await data.reason.fill('Spam flood from a test script');
  await data.deleteButton.click();
  await expect(data.result).toContainText('Deleted 5 records.');
  await page.reload(); // the admin's data page survives a reload
  await expect(data.collectionRow('tasks')).toContainText('0');

  const ownerPage = await browser.newPage({ baseURL });
  const ownerDash = new DashboardPage(ownerPage);
  await ownerDash.openAs(owner.token);
  await expect(ownerPage.getByRole('group', { name: new RegExp(`${slug}: had data cleared by an admin`) })).toContainText('Spam flood from a test script');
  await ownerDash.openAs(owner.token, `/apps/${slug}`);
  const banner = ownerPage.getByRole('region', { name: 'An admin cleared data of this app' });
  await expect(banner).toContainText('Reason: Spam flood from a test script');
  await banner.getByRole('link', { name: 'Snapshots' }).click();
  await expect(ownerPage).toHaveURL(new RegExp(`/apps/${slug}/data$`));
  const id = await ownerDash.data.newestSnapshotId();
  const row = ownerDash.data.snapshotRow(id);
  await expect(row.row).toContainText('admin');
  await expect(row.purgeButton).toBeDisabled(); // the owner's record of what the admin did
  await expect(row.restoreButton).toBeEnabled();

  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toHaveCount(0);
  await ownerPage.reload();
  await ownerDash.data.snapshots.waitFor();
  await expect(banner).toHaveCount(0);
  await ownerPage.close();
});
