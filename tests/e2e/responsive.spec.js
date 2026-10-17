// Layout checks that only a real browser can do: phone width and dark mode.
import { test, expect } from './support/fixtures.js';
import { DashboardPage } from './pages/dashboard-page.js';

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
    expect(await fitsWidth(), `Admin overflows at 390px (${colorScheme})`).toBe(true);

    backgrounds[colorScheme] = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await context.close();
  }
  expect(backgrounds.dark).not.toBe(backgrounds.light);
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
