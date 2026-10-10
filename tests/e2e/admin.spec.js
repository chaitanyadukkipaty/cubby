// Admin journeys: invites, limits, and managing users and apps.
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

test('users and apps: disable and re-enable a user, delete their app, then delete them', async ({ page, api, dashboard }) => {
  const { admin } = dashboard;
  const user = await api.createUser('managed');
  const slug = await api.createDeployedApp(user.token, 'adm');
  await page.reload();
  await dashboard.openAdmin();

  const row = admin.userRow(user.email);
  await expect(admin.userRow(ADMIN.email).deleteButton).toHaveCount(0); // admins can't remove themselves

  await row.disableButton.click();
  await expect(dashboard.toast).toHaveText(/User disabled/);
  await expect(row.disabledBadge).toBeVisible();
  expect(await api.meStatus(user.token)).toBe(403);

  await row.enableButton.click();
  await expect(dashboard.toast).toHaveText('User enabled');
  expect(await api.meStatus(user.token)).toBe(200);

  answerNextDialog(page, slug);
  await admin.appRow(slug).deleteButton.click();
  await expect(dashboard.toast).toHaveText(`Deleted ${slug}`);
  await expect(admin.appRow(slug).row).toHaveCount(0);
  expect((await api.project(user.token, slug)).status).toBe(404);

  answerNextDialog(page, user.email);
  await row.deleteButton.click();
  await expect(dashboard.toast).toHaveText('User deleted');
  await expect(row.row).toHaveCount(0);
  expect(await api.meStatus(user.token)).toBe(401);
});
