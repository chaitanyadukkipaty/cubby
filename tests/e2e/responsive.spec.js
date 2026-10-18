// Layout checks that only a real browser can do: phone width and dark mode.
import { test, expect } from './support/fixtures.js';
import { DashboardPage } from './pages/dashboard-page.js';
import { uid } from './support/api.js';

test('dashboard and admin fit a phone screen without sideways scrolling, in light and dark', async ({ browser, baseURL, api }) => {
  const token = await api.adminToken();
  const backgrounds = {};
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, colorScheme });
    const page = await context.newPage();
    const dashboard = new DashboardPage(page);
    const fitsWidth = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

    await dashboard.openAs(token);
    await expect(dashboard.pageHeading).toHaveText('Home');
    await page.waitForLoadState('networkidle');
    expect(await fitsWidth(), `Home overflows at 390px (${colorScheme})`).toBe(true);
    await dashboard.agentsLink.click();
    await dashboard.agents.connectButton.waitFor();
    expect(await fitsWidth(), `Agents overflows at 390px (${colorScheme})`).toBe(true);
    await dashboard.openAdmin();
    await page.waitForLoadState('networkidle');
    expect(await fitsWidth(), `Admin overflows at 390px (${colorScheme})`).toBe(true);
    for (const tab of ['Users', 'Apps', 'Agents', 'Jobs', 'Settings', 'Storage']) {
      await dashboard.admin.openTab(tab);
      await page.waitForLoadState('networkidle');
      expect(await fitsWidth(), `Admin ${tab} overflows at 390px (${colorScheme})`).toBe(true);
    }

    backgrounds[colorScheme] = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await context.close();
  }
  expect(backgrounds.dark).not.toBe(backgrounds.light);
});

test("an app's page fits a phone: the tabs scroll sideways inside their bar, the page never does", async ({ browser, baseURL, api }) => {
  const user = await api.createUser('phone');
  const slug = await api.createDeployedApp(user.token, 'phone');
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, colorScheme });
    const page = await context.newPage();
    const dashboard = new DashboardPage(page);
    await dashboard.openAs(user.token, `/apps/${slug}`);
    await expect(dashboard.app.chart('Views')).toBeVisible();
    for (const path of [`/apps/${slug}`, `/apps/${slug}/deploys`, `/apps/${slug}/env`, `/apps/${slug}/data`, '/apps', '/']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${path} overflows at 390px (${colorScheme})`).toBe(true);
    }
    await page.goto(`/apps/${slug}/settings`);
    const tabs = dashboard.app.tabs;
    expect(await tabs.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true); // more tabs than fit: they scroll
    await expect(dashboard.app.tab('Settings')).toBeInViewport();
    await context.close();
  }
});

test('on a real phone, long names and paths wrap or truncate, short pages start under the top bar, and nothing scrolls sideways', async ({ browser, baseURL, api }) => {
  const user = await api.createUser('long');
  const agent = await api.connectAgent(user.token, { tool: 'claude-code', machine: 'x'.repeat(57) });
  const slug = uid('long');
  await api.as(agent)('POST', '/api/projects', { body: { slug, name: 'A really quite long application display name here' } });
  await api.deploy(agent, slug);
  await api.pushSchema(agent, slug, { collections: [{ name: 'tasks', listRule: '', viewRule: '', createRule: '', fields: [{ name: 'title', type: 'text' }] }] });
  await api.addRecords(slug, 'tasks', [{ title: 'one' }]);
  await api.as(user.token)('POST', `/api/projects/${slug}/data/clear`, { body: { collection: 'tasks', filter: "title != ''" } });
  const longPath = `/very/long/path/${'x'.repeat(150)}`;
  await api.visit(slug, ['/', '/p1', longPath]);
  const original = (await api.settings()).server_name;
  await api.updateSettings({ server_name: 'Supercalifragilisticexpialidocious-Server-Name-For-Our-Team' });
  try {
    for (const colorScheme of ['light', 'dark']) {
      // isMobile: a phone widens its layout viewport to fit content, so overflow shows up as a wider scrollWidth.
      const context = await browser.newContext({ baseURL, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, colorScheme });
      const page = await context.newPage();
      const dashboard = new DashboardPage(page);
      const width = () => page.evaluate(() => Math.max(document.documentElement.scrollWidth, window.innerWidth));
      await page.goto('/');
      await page.getByRole('button', { name: 'Create account' }).waitFor();
      expect(await width(), `the sign-in page overflows (${colorScheme})`).toBe(375);

      await dashboard.openAs(user.token);
      const { user_code: code } = await api.startDeviceLogin({ tool: 'Claude Code', machine: 'phone' });
      await page.goto(`/connect?code=${code}`);
      await page.getByRole('button', { name: /Approve/ }).waitFor();
      expect(await width(), `the connect page overflows (${colorScheme})`).toBe(375);
      for (const path of ['/', '/apps', '/explore', '/agents', `/apps/${slug}?range=24h`, `/apps/${slug}/deploys`, `/apps/${slug}/data`, '/no-such-page']) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        expect(await width(), `${path} overflows at 375px (${colorScheme})`).toBe(375);
        const top = await page.evaluate(() => document.querySelector('main').getBoundingClientRect().top);
        expect(top, `${path}: blank band under the top bar (${colorScheme})`).toBeLessThan(80);
      }

      await page.goto(`/apps/${slug}`);
      const h2 = page.getByRole('main').getByRole('heading', { level: 2 });
      const [dot, title] = await Promise.all([page.locator('.app-h .dot').boundingBox(), h2.boundingBox()]);
      expect(dot.y, 'the live dot sits on the title line').toBeGreaterThanOrEqual(title.y);
      const paths = page.getByRole('table', { name: 'Top paths' });
      await paths.waitFor();
      expect(await paths.evaluate((t) => t.parentElement.scrollWidth <= t.parentElement.clientWidth), 'Top paths fit their card: Views stays in sight').toBe(true);
      await expect(page.getByRole('table', { name: 'Top paths' }).getByTitle(longPath)).toBeVisible();

      await page.goto(`/apps/${slug}/data`);
      const purge = page.getByRole('table', { name: 'Snapshots' }).getByRole('button', { name: /^Purge / });
      const card = await page.getByRole('table', { name: 'Snapshots' }).locator('xpath=ancestor::div[contains(@class,"card")]').boundingBox();
      const box = await purge.boundingBox();
      expect(box.x + box.width, 'Purge fits inside the card').toBeLessThanOrEqual(card.x + card.width);
      await context.close();
    }
  } finally {
    await api.updateSettings({ server_name: original });
  }
});

test('phones get a bottom bar instead of the sidebar', async ({ browser, baseURL, api }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const dashboard = new DashboardPage(page);
  await dashboard.openAs(await api.adminToken());
  const nav = await dashboard.nav.boundingBox();
  expect(nav.y + nav.height).toBeCloseTo(844, 0);
  expect(nav.width).toBe(390);
  await dashboard.openAdmin();
  await expect(dashboard.currentPage).toHaveText('Admin');
  await context.close();
});

test('the theme toggle overrides the system preference and is remembered', async ({ browser, baseURL, api }) => {
  const context = await browser.newContext({ baseURL, colorScheme: 'light' });
  const page = await context.newPage();
  const dashboard = new DashboardPage(page);
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await dashboard.openAs(await api.adminToken());
  const light = await background();

  await expect(dashboard.themeButton).toHaveAccessibleName('Switch to dark theme');
  await dashboard.themeButton.click();
  await expect(dashboard.themeButton).toHaveAccessibleName('Switch to light theme');
  const dark = await background();
  expect(dark).not.toBe(light);

  await page.reload();
  await dashboard.logOutButton.waitFor();
  expect(await background()).toBe(dark);
  await dashboard.themeButton.click();
  expect(await background()).toBe(light);
  await context.close();
});
