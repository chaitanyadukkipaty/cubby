// Dashboard journeys for a regular user: sign up, session, token, own apps, gallery.
import { test, expect, answerNextDialog } from './support/fixtures.js';
import { uid } from './support/api.js';
import { DashboardPage } from './pages/dashboard-page.js';

test('a new user signs up with the signup code and lands on their dashboard', async ({ page, baseURL, api, authPage, dashboard }) => {
  const email = `${uid('alex')}@e2e.dev`;
  const { signup_code: code } = await api.settings();

  await authPage.goto();
  await expect(authPage.httpWarning).toBeVisible();
  await authPage.signUp({ email, password: 'password1234', code: 'wrong-code-00' });
  await expect(authPage.error).toHaveText(/Invalid signup code/);

  await authPage.signupCode.fill(code);
  await authPage.createAccountButton.click();
  await expect(dashboard.account(email)).toBeVisible();
  await expect(dashboard.myApps.connectHeading).toBeVisible();
  await expect(dashboard.myApps.appIdea).toHaveText('polls');
  await expect(dashboard.myApps.appIdea).toHaveText('chat', { timeout: 5_000 }); // the highlighted app idea rotates
  await expect(dashboard.myApps.setupPrompt).toContainText('npx skills add chaitanyadukkipaty/cubby --skill cubby -g');
  await expect(dashboard.myApps.setupPrompt).toContainText(`curl -fsSL ${baseURL}/skill.sh | sh`);
  await expect(dashboard.myApps.emptyState).toBeVisible();
  await expect(dashboard.adminTab).toHaveCount(0);

  await page.reload();
  await expect(dashboard.account(email)).toBeVisible();

  await dashboard.logOutButton.click();
  await expect(authPage.createAccountButton).toBeVisible();
  await page.reload();
  await expect(authPage.createAccountButton).toBeVisible();
});

test('the log in tab has no stray text where the signup code field would be', async ({ page, authPage }) => {
  await authPage.goto();
  await authPage.logInTab.click();
  await expect(authPage.signupCode).toHaveCount(0);
  await expect(page.locator('form')).not.toContainText('null');
});

test('a stale session goes back to the sign-in card', async ({ page, authPage, dashboard }) => {
  await authPage.goto();
  await page.evaluate(() => localStorage.setItem('cubby_token', 'hk_not_a_real_token'));
  await page.reload();
  await expect(authPage.createAccountButton).toBeVisible();
  await expect(dashboard.logOutButton).toHaveCount(0);
});

test('the token can be revealed and copied, and regenerating it revokes the old one but leaves agents connected', async ({ page, context, api, dashboard }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const user = await api.createUser('tok');
  const device = await api.startDeviceLogin({ tool: 'Codex', machine: 'e2e' });
  await api.as(user.token)('POST', '/api/device/approve', { body: { code: device.user_code } });
  const agent = (await api.pollDeviceLogin(device.device_id)).token;
  await dashboard.openAs(user.token);

  await expect(dashboard.myApps.token).toHaveText(/^hk_\S{3}•+$/);
  expect(await dashboard.myApps.revealToken()).toBe(user.token);

  await dashboard.myApps.copyPromptButton.click();
  await expect(dashboard.toast).toHaveText('Prompt copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^I'd like you to set up Cubby: [\s\S]*\/docs\.md and ask me what I'd like to build\.$/);

  const asked = new Promise((resolve) => page.once('dialog', (d) => { resolve(d.message()); d.accept(); }));
  await dashboard.myApps.regenerateButton.click();
  expect(await asked).toBe('Regenerate your token for scripts and CI? The old one stops working immediately. Agents you connected with cubby login have their own keys and stay connected (revoke one with cubby agents revoke).');
  await expect(dashboard.toast).toHaveText('New token created');
  expect(await api.meStatus(user.token)).toBe(401);
  expect(await api.meStatus(agent)).toBe(200);

  const fresh = await page.evaluate(() => localStorage.getItem('cubby_token'));
  expect(fresh).not.toBe(user.token);
  expect(await api.meStatus(fresh)).toBe(200);
  await page.reload();
  await expect(dashboard.account(user.email)).toBeVisible();
});

test('a deployed app shows in My apps and the gallery; its owner can unlist and delete it', async ({ browser, baseURL, page, api, dashboard }) => {
  const owner = await api.createUser('owner');
  const friend = await api.createUser('friend');
  const slug = await api.createDeployedApp(owner.token, 'gal', { description: 'E2E gallery app' });

  const friendPage = await browser.newPage({ baseURL });
  const friendView = new DashboardPage(friendPage);
  await friendView.openAs(friend.token);
  await friendView.openGallery();
  await expect(friendView.gallery.app(slug).owner).toHaveText(new RegExp(`^by ${owner.email}`));
  await expect(friendView.gallery.app(slug).openLink).toHaveAttribute('href', new RegExp(`//${slug}\\.localhost:`));

  await dashboard.openAs(owner.token);
  const app = dashboard.myApps.app(slug);
  await expect(app.status).toHaveText(/^Deployed just now$/);
  await expect(app.showInGallery).toBeChecked();

  await app.showInGallery.uncheck();
  await expect(dashboard.toast).toHaveText('Hidden from gallery');
  expect((await api.project(owner.token, slug)).data.unlisted).toBe(true);
  await friendPage.reload();
  await friendView.openGallery();
  await expect(friendView.gallery.app(slug).card).toHaveCount(0);

  answerNextDialog(page, 'not-the-name');
  await app.deleteButton.click();
  await expect(app.card).toBeVisible();
  expect((await api.project(owner.token, slug)).status).toBe(200);

  answerNextDialog(page, slug);
  await app.deleteButton.click();
  await expect(dashboard.toast).toHaveText(`Deleted ${slug}`);
  await expect(app.card).toHaveCount(0);
  expect((await api.project(owner.token, slug)).status).toBe(404);
  await friendPage.close();
});

test("an app's scheduled jobs: run one now, read its log, pause and resume it", async ({ api, dashboard }) => {
  const owner = await api.createUser('jobs');
  const slug = await api.createAppWithJobs(owner.token, 'jobs', {
    'weekly-digest': { schedule: '0 9 * * 1', code: "export default async ({ log }) => log('sent 3 digests');" },
  });
  await dashboard.openAs(owner.token);
  const app = dashboard.myApps.app(slug);
  await app.jobsToggle.click();
  const job = app.job('weekly-digest');
  await expect(job.state).toHaveText('not run yet');
  await expect(job.details).toContainText('0 9 * * 1 UTC · never run · next');

  await job.runButton.click();
  await expect(dashboard.toast).toHaveText('weekly-digest: ok');
  await expect(job.state).toHaveText('ok');
  await job.lastLogButton.click();
  await expect(job.log).toHaveText('sent 3 digests');

  await job.pauseButton.click();
  await expect(dashboard.toast).toHaveText('weekly-digest paused');
  await expect(job.state).toHaveText('paused');
  await job.resumeButton.click();
  await expect(job.state).toHaveText('ok');
});
