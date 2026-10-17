// Dashboard journeys for a regular user: sign up, session, token, own apps, gallery.
import { test, expect } from './support/fixtures.js';
import { uid } from './support/api.js';

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
  await expect(dashboard.home.steps).toBeVisible(); // first run: connect your agent, approve, ask for an app
  await expect(dashboard.home.steps.getByRole('button', { name: /^Copy prompt: Build me a polls app/ })).toBeVisible();
  await expect(dashboard.adminLink).toHaveCount(0);

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
  await dashboard.openAs(user.token, '/agents');
  const { agents } = dashboard;

  await expect(agents.token).toHaveText(/^hk_\S{3}•+$/);
  expect(await agents.revealToken()).toBe(user.token);
  await agents.copyTokenButton.click();
  await expect(dashboard.toast).toHaveText('Token copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(user.token);

  await agents.connectButton.click();
  await expect(dashboard.toast).toHaveText('Prompt copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^I'd like you to set up Cubby: [\s\S]*\/docs\.md and ask me what I'd like to build\.$/);

  const asked = new Promise((resolve) => page.once('dialog', (d) => { resolve(d.message()); d.accept(); }));
  await agents.regenerateButton.click();
  expect(await asked).toBe('Regenerate your token for scripts and CI? The old one stops working immediately. Agents you connected with cubby login have their own keys and stay connected (revoke one with cubby agents revoke).');
  await expect(dashboard.toast).toHaveText('New token created');
  expect(await api.meStatus(user.token)).toBe(401);
  expect(await api.meStatus(agent)).toBe(200);

  const fresh = await page.evaluate(() => localStorage.getItem('cubby_token'));
  expect(fresh).not.toBe(user.token);
  expect(await api.meStatus(fresh)).toBe(200);
  await page.reload();
  await expect(dashboard.account(user.email)).toBeVisible();
  await expect(agents.agent('Codex · e2e').row).toBeVisible(); // the agent is still listed
});

test('every page has its own URL: deep links and reloads land on it, and back/forward work', async ({ page, api, authPage, dashboard }) => {
  const user = await api.createUser('deeplink');
  const slug = await api.createDeployedApp(user.token, 'deep');

  // Signed out, a deep link shows the sign-in card and lands on the page after logging in.
  await page.goto(`/apps/${slug}`);
  await authPage.logIn(user);
  await expect(dashboard.pageHeading).toHaveText(slug);
  await expect(dashboard.currentPage).toHaveText('Apps');

  await page.reload();
  await expect(dashboard.pageHeading).toHaveText(slug);
  await expect(dashboard.app.currentTab).toHaveText('Overview');

  await page.getByRole('link', { name: '← Apps' }).click();
  await expect(page).toHaveURL(/\/apps$/);
  await dashboard.openGallery();
  await expect(dashboard.pageHeading).toHaveText('Explore');
  await page.goBack();
  await expect(page).toHaveURL(/\/apps$/);
  await expect(dashboard.pageHeading).toHaveText('Apps');
  await page.goForward();
  await expect(dashboard.currentPage).toHaveText('Explore');

  await dashboard.agentsLink.click();
  await expect(dashboard.pageHeading).toHaveText('Agents');
  await page.reload();
  await expect(dashboard.pageHeading).toHaveText('Agents');

  await dashboard.openAs(user.token, '/apps/not-mine');
  await expect(page.getByText("You don't have an app called not-mine.")).toBeVisible();
  await dashboard.openAs(user.token, '/admin');
  await expect(page).toHaveURL(/\/$/, { timeout: 5_000 }); // not an admin: back to Home
  await expect(dashboard.pageHeading).toHaveText('Home');

  await dashboard.openAs(await api.adminToken(), '/admin');
  await expect(dashboard.admin.inviteHeading).toBeVisible();
  await page.reload();
  await expect(dashboard.admin.inviteHeading).toBeVisible();
});

test('the command palette opens with Ctrl+K, finds an app and goes to it, and Esc closes it', async ({ page, context, api, dashboard }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const user = await api.createUser('palette');
  const slug = await api.createDeployedApp(user.token, 'pal');
  await dashboard.openAs(user.token);
  const { palette } = dashboard;

  await dashboard.myApps.copyPromptButton.focus();
  await palette.openWithKeyboard();
  await expect(palette.search).toBeFocused();
  await expect(palette.option('Home')).toBeVisible();
  await expect(palette.option('Admin')).toHaveCount(0); // not an admin
  await page.keyboard.press('Escape');
  await expect(palette.dialog).toHaveCount(0);
  await expect(dashboard.myApps.copyPromptButton).toBeFocused(); // focus goes back where it was

  await palette.openWithKeyboard();
  await palette.search.fill(slug);
  await expect(palette.selected).toContainText(slug);
  await page.keyboard.press('Tab');
  await expect(palette.search).toBeFocused(); // focus stays in the dialog
  await page.keyboard.press('Enter');
  await expect(palette.dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/apps/${slug}$`));
  await expect(dashboard.pageHeading).toHaveText(slug);

  // Opened from the sidebar: arrows move the highlight and Enter runs the action.
  await palette.openButton.click();
  await palette.search.fill('setup prompt');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(palette.selected).toHaveText('Copy setup prompt for your agent');
  await page.keyboard.press('Enter');
  await expect(dashboard.toast).toHaveText('Prompt copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^I'd like you to set up Cubby/);
});
