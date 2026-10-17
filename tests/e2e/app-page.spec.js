// The app page journey: /apps list → an app's tabs (in the URL, kept on reload) → charts, deploys and rollback,
// jobs, secrets, visibility and delete.
import { test, expect, answerNextDialog } from './support/fixtures.js';
import { appUrl, uid } from './support/api.js';
import { DashboardPage } from './pages/dashboard-page.js';

test('the Apps list links each app to its page; tabs live in the URL and survive a reload; charts show real metrics', async ({ browser, baseURL, page, api, dashboard }) => {
  const user = await api.createUser('apppage');
  const agent = await api.connectAgent(user.token, { tool: 'Claude Code', machine: 'e2e-mbp' });
  const slug = uid('page');
  await api.createApp(agent, slug);
  await api.deploy(agent, slug);
  const visitor = await browser.newPage();
  await visitor.goto(appUrl(slug)); // one real page view
  await visitor.close();

  await dashboard.openAs(user.token, '/apps');
  const row = dashboard.myApps.app(slug);
  await expect(row.status).toHaveText('Deployed just now by CC Claude Code · e2e-mbp');
  await expect(row.sparkline).toBeVisible();
  await expect(row.openLink).toHaveAttribute('href', new RegExp(`//${slug}\\.localhost:`));

  await row.link.click();
  const { app } = dashboard;
  await expect(page).toHaveURL(new RegExp(`/apps/${slug}$`));
  await expect(app.currentTab).toHaveText('Overview');
  await expect(app.kpi('Views')).toContainText('1');
  await expect(app.kpi('Active now')).toContainText('1');
  for (const name of ['Views', 'Unique visitors', 'Peak active visitors', 'API errors']) await expect(app.chart(name)).toBeVisible();
  await expect(app.chart('Views').getByRole('img')).toHaveAccessibleName(/^Views: 1 in total, most on /);
  await expect(app.chart('Views').locator('.dmark')).toHaveText('v1'); // the deploy runs through the charts

  await app.range.getByRole('link', { name: '24h' }).click();
  await expect(page).toHaveURL(new RegExp(`/apps/${slug}\\?range=24h$`));
  await expect(app.range.getByRole('link', { name: '24h' })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByText('Visitors are counted per day')).toBeVisible();

  await app.tab('Deploys').click();
  await expect(page).toHaveURL(new RegExp(`/apps/${slug}/deploys$`));
  await expect(app.deploy('v1').live).toBeVisible();
  await page.reload();
  await expect(app.currentTab).toHaveText('Deploys');
  await expect(app.deploy('v1').live).toBeVisible();

  await app.tab('Activity').click();
  await expect(page.getByRole('region', { name: `Activity of ${slug}` })).toContainText(`Created app "${slug}"`);
  await page.goBack();
  await expect(app.currentTab).toHaveText('Deploys');
});

test('Deploys tab: roll back to an earlier deploy after a confirm', async ({ page, api, dashboard }) => {
  const user = await api.createUser('rolltab');
  const slug = uid('rolltab');
  await api.createApp(user.token, slug);
  await api.deploy(user.token, slug, '<h1>one</h1>');
  await api.deploy(user.token, slug, '<h1>two</h1>');
  const [, first] = await api.deploys(user.token, slug);
  await dashboard.openAs(user.token, `/apps/${slug}/deploys`);
  const { app } = dashboard;
  await expect(app.deploy('v2').live).toBeVisible();
  await expect(app.deploy('v2').rollBackButton).toHaveCount(0);

  page.once('dialog', (d) => d.dismiss());
  await app.deploy('v1').rollBackButton.click();
  await expect(app.deploy('v2').live).toBeVisible();

  answerNextDialog(page);
  await app.deploy('v1').rollBackButton.click();
  await expect(dashboard.toast).toHaveText(`Rolled back ${slug} to v1`);
  await expect(app.deploy('v1').live).toBeVisible();
  expect((await api.project(user.token, slug)).data.current_deploy).toBe(first.id);
});

test("Jobs tab: run one now, read its log, pause and resume it", async ({ api, dashboard }) => {
  const owner = await api.createUser('jobs');
  const slug = await api.createAppWithJobs(owner.token, 'jobs', {
    'weekly-digest': { schedule: '0 9 * * 1', code: "export default async ({ log }) => log('sent 3 digests');" },
  });
  await dashboard.openAs(owner.token, `/apps/${slug}`);
  const { app } = dashboard;
  await expect(app.tab('Jobs')).toHaveText('Jobs1');
  await app.tab('Jobs').click();
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

test('Env tab: set a secret (its value is never shown), then unset it after a confirm', async ({ page, api, dashboard }) => {
  const user = await api.createUser('env');
  const slug = uid('env');
  await api.createApp(user.token, slug);
  await dashboard.openAs(user.token, `/apps/${slug}/env`);
  const { app } = dashboard;
  await expect(app.askAgent).toBeVisible();

  await app.secretName.fill('lower-case');
  await app.secretValue.fill('x');
  await app.saveSecretButton.click();
  await expect(page.getByRole('alert')).toHaveText(/UPPER_CASE/);

  await app.secretName.fill('RESEND_API_KEY');
  await app.secretValue.fill('re_super_secret_123');
  await app.saveSecretButton.click();
  await expect(dashboard.toast).toHaveText('Added RESEND_API_KEY');
  await expect(app.secret('RESEND_API_KEY').row).toContainText('hidden');
  await expect(page.getByText('re_super_secret_123')).toHaveCount(0);
  expect(await page.content()).not.toContain('re_super_secret_123');

  page.once('dialog', (d) => d.dismiss());
  await app.secret('RESEND_API_KEY').unsetButton.click();
  await expect(app.secret('RESEND_API_KEY').row).toBeVisible();
  answerNextDialog(page);
  await app.secret('RESEND_API_KEY').unsetButton.click();
  await expect(dashboard.toast).toHaveText('Removed RESEND_API_KEY');
  await expect(app.secrets).toHaveCount(0);
});

test('Settings tab: hide the app from the gallery, then delete it with a typed confirmation', async ({ browser, baseURL, page, api, dashboard }) => {
  const owner = await api.createUser('owner');
  const friend = await api.createUser('friend');
  const slug = await api.createDeployedApp(owner.token, 'gal', { description: 'E2E gallery app' });
  const friendPage = await browser.newPage({ baseURL });
  const friendView = new DashboardPage(friendPage);
  await friendView.openAs(friend.token);
  await friendView.openGallery();
  await expect(friendView.gallery.app(slug).owner).toHaveText(new RegExp(`^by ${owner.email}`));

  await dashboard.openAs(owner.token, `/apps/${slug}/settings`);
  const { app } = dashboard;
  await expect(app.showInGallery).toBeChecked();
  await app.showInGallery.uncheck();
  await expect(dashboard.toast).toHaveText('Hidden from gallery');
  expect((await api.project(owner.token, slug)).data.unlisted).toBe(true);
  await friendPage.reload();
  await friendView.openGallery();
  await expect(friendView.gallery.app(slug).card).toHaveCount(0);

  await expect(app.deleteButton).toBeDisabled();
  await app.deleteConfirm(slug).fill('not-the-name');
  await expect(app.deleteButton).toBeDisabled();
  await app.deleteConfirm(slug).fill(slug);
  await app.deleteButton.click();
  await expect(dashboard.toast).toHaveText(`Deleted ${slug}`);
  await expect(page).toHaveURL(/\/apps$/);
  expect((await api.project(owner.token, slug)).status).toBe(404);
  await friendPage.close();
});

test('an app with no deploys suggests what to ask your agent, with a copy button', async ({ page, context, api, dashboard }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const user = await api.createUser('empty');
  const slug = uid('empty');
  await api.createApp(user.token, slug);
  await dashboard.openAs(user.token, `/apps/${slug}/deploys`);
  await expect(dashboard.app.askAgent).toBeVisible();
  await page.getByRole('button', { name: `Copy prompt: Build the first version of ${slug} and deploy it.` }).click();
  await expect(dashboard.toast).toHaveText('Prompt copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`Build the first version of ${slug} and deploy it.`);
});
