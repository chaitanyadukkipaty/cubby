// Admin journeys: invites, limits, and managing users and apps (storage and data clears: admin-storage.spec.js,
// data.spec.js).
import { test, expect, answerNextDialog } from './support/fixtures.js';
import { uid } from './support/api.js';
import { AuthPage } from './pages/auth-page.js';
import { ADMIN } from '../helpers/server.js';

test.beforeEach(async ({ api, dashboard }) => {
  await dashboard.openAs(await api.adminToken());
  await dashboard.openAdmin();
});

test('rotating the signup code invalidates the old one; open signup removes the code field', async ({ browser, baseURL, page, api, dashboard }) => {
  const { admin } = dashboard;
  await admin.openTab('Settings');
  const oldCode = (await admin.signupCode.textContent()).trim();

  answerNextDialog(page);
  await admin.rotateCodeButton.click();
  await expect(admin.signupCode).not.toHaveText(oldCode);
  const newCode = (await admin.signupCode.textContent()).trim();
  const signup = (code) => api.authPost('/api/signup', { email: `${uid('inv')}@e2e.dev`, password: 'password1234', code });
  expect((await signup(oldCode)).status).toBe(403);
  expect((await signup(newCode)).status).toBe(200);

  const visitorPage = await browser.newPage({ baseURL });
  const visitor = new AuthPage(visitorPage);
  await admin.openSignup.check();
  await expect(dashboard.toast).toHaveText('Anyone with the URL can sign up');
  await visitor.goto();
  await expect(visitor.email).toBeVisible();
  await expect(visitor.signupCode).toHaveCount(0);

  await admin.openSignup.uncheck();
  await expect(dashboard.toast).toHaveText('Signup code required');
  await visitorPage.reload();
  await expect(visitor.signupCode).toBeVisible();
  await visitorPage.close();
});

test('settings: renaming the server updates the header and tab; limits reject out-of-range values', async ({ page, api, dashboard }) => {
  const { admin } = dashboard;
  await admin.openTab('Settings');
  const original = (await api.settings()).server_name;
  await admin.renameServer("E2E Crew's Cubby");
  await expect(dashboard.toast).toHaveText('Server name saved');
  await expect(page.getByRole('heading', { level: 1, name: "E2E Crew's Cubby" })).toBeVisible();
  await expect(page.getByText(/runs on\s*Cubby/)).toBeVisible();
  await expect(page).toHaveTitle("E2E Crew's Cubby");
  expect((await api.settings()).server_name).toBe("E2E Crew's Cubby");
  await api.updateSettings({ server_name: original });

  await admin.saveLimits({ appsPerUser: 20000 });
  await expect(dashboard.toast).toHaveText(/between 1 and 10000/);

  await admin.saveLimits({ appsPerUser: 7, maxDeployMb: 4 });
  await expect(dashboard.toast).toHaveText('Limits saved');
  const s = await api.settings();
  expect([s.max_apps_per_user, s.max_deploy_mb]).toEqual([7, 4]);
  await api.updateSettings({ max_apps_per_user: 10, max_deploy_mb: 5 });
});

test('updates: a newer release shows the notice with notes and the upgrade command; the toggle turns it off', async ({ page, dashboard }) => {
  const { admin } = dashboard;
  const setLatest = (tag) => fetch(`${process.env.CUBBY_E2E_RELEASES_URL}/set?tag=${tag}`, { method: 'POST' });
  const info = await (await fetch(`${process.env.CUBBY_E2E_URL}/api/info`)).json();
  const [maj, min, pat] = info.version.split('.').map(Number);
  const newer = `v${maj}.${min}.${pat + 1}`;

  await expect(page.getByText(`Cubby ${info.version} ·`)).toBeVisible();
  await expect(admin.updates).toContainText(`Update available: ${newer}`);
  await expect(admin.releaseNotesLink).toHaveAttribute('href', `https://github.com/chaitanyadukkipaty/cubby/releases/tag/${newer}`);
  await expect(admin.updates.getByText('sudo cubby-server upgrade', { exact: true })).toBeVisible();
  await expect(admin.copyUpgradeButton).toBeVisible();

  await admin.updateCheck.uncheck();
  await expect(dashboard.toast).toHaveText('Update checks off');
  await expect(admin.updates).toContainText('Update checks are off.');
  await expect(admin.updates).not.toContainText('Update available');

  // Back on with the server already on the latest release: no notice.
  await setLatest(`v${info.version}`);
  await admin.updateCheck.check();
  await expect(dashboard.toast).toHaveText('Update checks on');
  await expect(admin.updates).toContainText(`You're on the latest release (v${info.version}).`);
  await expect(admin.copyUpgradeButton).toHaveCount(0);
  await setLatest(newer);
});

test('users and apps: disable and re-enable a user, delete their app, then delete them', async ({ page, api, dashboard }) => {
  const { admin } = dashboard;
  const user = await api.createUser('managed');
  const slug = await api.createDeployedApp(user.token, 'adm');
  await page.reload();
  await dashboard.openAdmin('Users');

  const row = admin.userRow(user.email);
  await expect(admin.userRow(ADMIN.email).deleteButton).toHaveCount(0); // admins can't remove themselves

  await row.disableButton.click();
  await expect(dashboard.toast).toHaveText(/User disabled/);
  await expect(row.disabledBadge).toBeVisible();
  expect(await api.meStatus(user.token)).toBe(403);

  await row.enableButton.click();
  await expect(dashboard.toast).toHaveText('User enabled');
  expect(await api.meStatus(user.token)).toBe(200);

  await admin.openTab('Apps');
  answerNextDialog(page, slug);
  await admin.appRow(slug).deleteButton.click();
  await expect(dashboard.toast).toHaveText(`Deleted ${slug}`);
  await expect(admin.appRow(slug).row).toHaveCount(0);
  expect((await api.project(user.token, slug)).status).toBe(404);

  await admin.openTab('Users');
  answerNextDialog(page, user.email);
  await row.deleteButton.click();
  await expect(dashboard.toast).toHaveText('User deleted');
  await expect(row.row).toHaveCount(0);
  expect(await api.meStatus(user.token)).toBe(401);
});

test("jobs: every app's jobs are listed; the kill switch stops runs and the time limit is validated", async ({ page, api, dashboard }) => {
  const { admin } = dashboard;
  const owner = await api.createUser('jobowner');
  const slug = await api.createAppWithJobs(owner.token, 'adm-jobs', { nightly: { schedule: '0 2 * * *', code: 'export default async () => {};' } });
  await page.reload();
  await dashboard.openAdmin('Jobs');

  await expect(admin.jobsHeading).toBeVisible();
  const row = admin.jobRow(slug, 'nightly');
  await expect(row).toContainText(owner.email);
  await expect(row).toContainText('0 2 * * *');
  await expect(row).toContainText('not run yet');

  await admin.runJobs.uncheck();
  await expect(dashboard.toast).toHaveText('All jobs stopped');
  expect((await api.settings()).jobs).toBe(false);
  const refused = await api.as(owner.token)('POST', `/api/projects/${slug}/jobs/nightly/run`);
  expect(refused.status).toBe(403);
  await admin.runJobs.check();
  await expect(dashboard.toast).toHaveText('Jobs will run on schedule');
  expect((await api.settings()).jobs).toBe(true);

  await admin.jobTimeout.fill('1000');
  await admin.saveJobTimeoutButton.click();
  expect(await admin.jobTimeout.evaluate((el) => el.checkValidity())).toBe(false); // the browser refuses it (max 290)
  expect((await api.settings()).job_timeout_s).toBe(60);
  await admin.jobTimeout.fill('90');
  await admin.saveJobTimeoutButton.click();
  await expect(dashboard.toast).toHaveText('Time limit saved');
  expect((await api.settings()).job_timeout_s).toBe(90);
  await api.updateSettings({ job_timeout_s: 60 });
});
