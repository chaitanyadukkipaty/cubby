// Small dashboard behaviours that only a browser shows: failures surface as messages, buttons say what they do next,
// and pages that don't exist still get the dashboard around them.
import { test, expect, answerNextDialog } from './support/fixtures.js';

test('an admin action that fails says why in a toast instead of failing silently', async ({ page, api, dashboard }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const user = await api.createUser('gone');
  await dashboard.openAs(await api.adminToken(), '/admin/users');
  const row = dashboard.admin.userRow(user.email);
  await row.disableButton.waitFor();
  await api.as(await api.adminToken())('DELETE', `/api/admin/users/${(await api.as(user.token)('GET', '/api/me')).data.id}`);

  await row.disableButton.click();
  await expect(dashboard.toast).toHaveText(/not found/i);
  answerNextDialog(page, user.email);
  await row.deleteButton.click();
  await expect(dashboard.toast).toHaveText(/not found/i);
  expect(errors).toEqual([]);
});

test("a page that doesn't exist gets the dashboard around a not-found message, with a 404 status", async ({ page, api, dashboard }) => {
  const user = await api.createUser('lost');
  await dashboard.openAs(user.token);
  for (const path of ['/zzz', '/apps/Bad_Slug', '/admin/bogus']) {
    const res = await page.goto(path);
    expect(res.status(), path).toBe(404);
    await expect(page.getByRole('heading', { level: 2, name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('main').getByText(path)).toBeVisible();
    await expect(dashboard.nav).toBeVisible();
  }
  await page.getByRole('main').getByRole('link', { name: 'Go to Home' }).click();
  await expect(dashboard.pageHeading).toHaveText('Home');
  // A file the dashboard doesn't have stays a plain 404 for scripts.
  const res = await api.as()('GET', '/zzz');
  expect(res.status).toBe(404);
  expect(String(res.data)).not.toContain('<script');
});

test('clicking Create account repeatedly sends one signup, and the button is busy until it answers', async ({ page, api, authPage, dashboard }) => {
  const { signup_code: code } = await api.settings();
  const posts = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/signup')) posts.push(r); });
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route('**/api/signup', async (route) => { await held; await route.continue(); });
  await authPage.goto();
  await authPage.signUpTab.click();
  await authPage.email.fill(`twice-${Date.now()}@e2e.dev`);
  await authPage.password.fill('password1234');
  await authPage.signupCode.fill(code);
  await authPage.createAccountButton.click();
  await expect(page.getByRole('button', { name: /Creating account/ })).toBeDisabled();
  await page.getByRole('button', { name: /Creating account/ }).click({ force: true });
  await page.keyboard.press('Enter');
  release();
  await dashboard.logOutButton.waitFor();
  expect(posts).toHaveLength(1);
});

test('a failed login gives the button back so the person can try again', async ({ page, authPage }) => {
  await authPage.goto();
  await authPage.logIn({ email: 'nobody@e2e.dev', password: 'wrong-password' });
  await expect(authPage.error).not.toBeEmpty();
  await expect(authPage.logInButton).toBeEnabled();
});

test('the theme button follows the system theme when it changes while the page is open', async ({ page, api, dashboard }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await dashboard.openAs(await api.adminToken());
  await expect(dashboard.themeButton).toHaveAccessibleName('Switch to light theme');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(dashboard.themeButton).toHaveAccessibleName('Switch to dark theme');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(dashboard.themeButton).toHaveAccessibleName('Switch to light theme');
});

test('two agents given the same name are told apart by tool and machine, down to the revoke question', async ({ page, api, dashboard }) => {
  const user = await api.createUser('twins');
  await api.connectAgent(user.token, { tool: 'Claude Code', machine: 'mbp' });
  await api.connectAgent(user.token, { tool: 'Codex', machine: 'studio' });
  const call = api.as(user.token);
  for (const k of (await call('GET', '/api/agents')).data.filter((x) => !x.manual)) await call('PATCH', `/api/agents/${k.id}`, { body: { name: 'twin' } });
  await dashboard.openAs(user.token, '/agents');
  const { agents } = dashboard;
  await expect(agents.agent('twin (Claude Code on mbp)').link).toBeVisible();
  await expect(agents.agent('twin (Codex on studio)').link).toBeVisible();
  const asked = new Promise((r) => page.once('dialog', (d) => { r(d.message()); d.dismiss(); }));
  await agents.agent('twin (Codex on studio)').revokeButton.click();
  expect(await asked).toContain('Revoke twin (Codex on studio)?');
  await agents.agent('twin (Codex on studio)').renameButton.click();
  await expect(agents.agent('twin (Codex on studio)').nameInput).toHaveValue('twin');
});

test("an app's page: deploys close together share one chart label, From names the agent, and an unknown range is corrected in the URL", async ({ page, api, dashboard }) => {
  const user = await api.createUser('deployer');
  const agentToken = await api.connectAgent(user.token, { tool: 'Claude Code', machine: 'rig' });
  const slug = await api.createDeployedApp(agentToken, 'close');
  await api.deploy(agentToken, slug);
  await api.deploy(agentToken, slug);
  const { app } = dashboard;
  await dashboard.openAs(user.token, `/apps/${slug}?range=1y`);
  await expect(app.chart('Views').locator('.dmark')).toHaveText(['v1–v3']);
  await expect(app.chart('Views').locator('.dmark')).toHaveAttribute('title', 'Deploys v1, v2, v3');
  await expect(page).toHaveURL(new RegExp(`/apps/${slug}\\?range=7d$`));
  await expect(app.range.locator('[aria-current=true]')).toHaveText('7d');

  await app.tab('Deploys').click();
  await expect(app.deploys.locator('td[data-col=from]')).toHaveText(Array(3).fill('CC Claude Code · rig'));
  await expect(app.deploys.locator('td[data-col=from] a').first()).toHaveAttribute('href', /^\/agents\/[a-z0-9]{15}$/);
});

test('the token card says Hide once the token is shown, and Reveal again once it is masked', async ({ api, dashboard }) => {
  const user = await api.createUser('reveal');
  await dashboard.openAs(user.token, '/agents');
  const { agents } = dashboard;
  await expect(agents.token).toHaveText(/•{20}$/);
  await agents.revealButton.click();
  await expect(agents.token).toHaveText(user.token);
  const hide = agents.tokenCard.getByRole('button', { name: 'Hide' });
  await expect(hide).toBeVisible();
  await hide.click();
  await expect(agents.token).toHaveText(/•{20}$/);
  await expect(agents.revealButton).toBeVisible();
});
