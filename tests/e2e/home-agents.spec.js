// Home and Agents: first run → an agent connects and deploys → its work shows on the timeline → rename, revoke.
import { test, expect, answerNextDialog } from './support/fixtures.js';
import { uid } from './support/api.js';

test('Home: first run shows the connect steps; once an agent deploys, the timeline and summary take over', async ({ page, context, api, dashboard }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const user = await api.createUser('home');
  await dashboard.openAs(user.token);
  const { home } = dashboard;
  await expect(home.steps).toBeVisible();
  await expect(dashboard.myApps.connectHeading).toBeVisible();
  await expect(home.feed).toHaveCount(0);

  const agent = await api.connectAgent(user.token, { tool: 'Claude Code', machine: 'e2e-mbp' });
  const slug = uid('feed');
  await api.createApp(agent, slug);
  await api.deploy(agent, slug);
  const perApp = [];
  const onRequest = (r) => { if (/\/api\/projects\/[^/]+\/metrics/.test(r.url())) perApp.push(r.url()); };
  page.on('request', onRequest);
  await page.reload();

  await expect(home.steps).toHaveCount(0);
  await expect(home.entry(`deployed ${slug}`).line).toContainText('Claude Code · e2e-mbp');
  await expect(home.entry(`Created app "${slug}"`).line).toBeVisible();
  await expect(home.feed.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(home.agentsCard.getByRole('link', { name: 'Claude Code · e2e-mbp' })).toBeVisible();
  await expect(home.activeNow.getByRole('link', { name: slug })).toBeVisible();
  await expect(home.views.getByRole('img', { name: /^Views per day, last 7 days/ })).toBeVisible();
  page.off('request', onRequest);
  expect(perApp, 'the summary draws from GET /api/metrics alone').toEqual([]);

  // Prompt chips copy fixed templates naming the app and the server.
  await home.nextPrompts.getByRole('button', { name: /^Copy prompt: Add a dark mode toggle/ }).click();
  await expect(dashboard.toast).toHaveText('Prompt copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`^Add a dark mode toggle to ${slug} and redeploy it on .+\\.$`));

  // The app link goes to the app page.
  await home.entry(`deployed ${slug}`).line.getByRole('link', { name: slug }).click();
  await expect(page).toHaveURL(new RegExp(`/apps/${slug}$`));
});

test('Home: Roll back on the live deploy restores the one before it, after a confirm', async ({ page, api, dashboard }) => {
  const user = await api.createUser('rollfeed');
  const agent = await api.connectAgent(user.token, { tool: 'Codex', machine: 'e2e' });
  const slug = uid('roll');
  await api.createApp(agent, slug);
  await api.deploy(agent, slug, '<h1>one</h1>');
  await api.deploy(agent, slug, '<h1>two</h1>');
  const [newest, previous] = await api.deploys(user.token, slug);
  await dashboard.openAs(user.token);
  const { home } = dashboard;
  await expect(home.feed.getByRole('button', { name: 'Roll back' })).toHaveCount(1); // only the live deploy

  page.once('dialog', (d) => d.dismiss());
  await home.entry(`deployed ${slug}`).rollBackButton.click();
  expect((await api.project(user.token, slug)).data.current_deploy).toBe(newest.id);

  answerNextDialog(page);
  await home.entry(`deployed ${slug}`).rollBackButton.click();
  await expect(dashboard.toast).toHaveText(`Rolled back ${slug}`);
  await expect(home.entry(`rolled back ${slug}`).line).toContainText('Dashboard');
  expect((await api.project(user.token, slug)).data.current_deploy).toBe(previous.id);
  await expect(home.feed.getByRole('button', { name: 'Roll back' })).toHaveCount(0);
});

test('Agents: connect → the agent appears → rename it inline → see its activity → revoke it and its key stops working', async ({ page, api, dashboard }) => {
  const user = await api.createUser('agents');
  await dashboard.openAs(user.token, '/agents');
  const { agents } = dashboard;
  await expect(agents.empty).toBeVisible();

  const key = await api.connectAgent(user.token, { tool: 'Cursor', machine: 'e2e-box' });
  const slug = uid('agt');
  await api.createApp(key, slug);
  await page.reload();
  const row = agents.agent('Cursor · e2e-box');
  await expect(row.row).toContainText('e2e-box');
  await expect(row.row.getByRole('link', { name: slug })).toBeVisible(); // apps it touched

  await row.renameButton.click();
  await row.nameInput.fill('Studio laptop');
  await page.keyboard.press('Escape'); // cancel keeps the old name
  await expect(row.link).toBeVisible();
  await row.renameButton.click();
  await row.nameInput.fill('Studio laptop');
  await row.saveButton.click();
  await expect(dashboard.toast).toHaveText('Agent renamed');
  const renamed = agents.agent('Studio laptop');
  await expect(renamed.row).toBeVisible();

  await renamed.link.click();
  await expect(page).toHaveURL(/\/agents\/[a-z0-9]{15}$/);
  await expect(dashboard.pageHeading).toHaveText('Studio laptop');
  await expect(page.getByRole('region', { name: 'Activity of Studio laptop' })).toContainText(`Created app "${slug}"`);
  await page.reload();
  await expect(dashboard.pageHeading).toHaveText('Studio laptop');
  await expect(dashboard.currentPage).toHaveText('Agents');
  await page.getByRole('link', { name: '← Agents' }).click();

  page.once('dialog', (d) => d.dismiss());
  await renamed.revokeButton.click();
  expect(await api.meStatus(key)).toBe(200);
  answerNextDialog(page);
  await renamed.revokeButton.click();
  await expect(dashboard.toast).toHaveText('Revoked Studio laptop');
  await expect(agents.empty).toBeVisible();
  expect(await api.meStatus(key)).toBe(401);
  expect(await api.meStatus(user.token)).toBe(200); // the dashboard's own token is untouched
});
