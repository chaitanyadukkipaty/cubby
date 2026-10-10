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
    await expect(dashboard.myApps.connectHeading).toBeVisible();
    expect(await fitsWidth(), `My apps overflows at 390px (${colorScheme})`).toBe(true);
    await dashboard.openAdmin();
    expect(await fitsWidth(), `Admin overflows at 390px (${colorScheme})`).toBe(true);

    backgrounds[colorScheme] = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await context.close();
  }
  expect(backgrounds.dark).not.toBe(backgrounds.light);
});
