// Logged-in dashboard shell (sidebar, or bottom bar on phones) and its pages.
import { MyAppsSection } from './my-apps-section.js';
import { GallerySection } from './gallery-section.js';
import { AdminSection } from './admin-section.js';
import { CommandPalette } from './command-palette.js';
import { HomeSection } from './home-page.js';
import { AgentsSection } from './agents-page.js';

export class DashboardPage {
  constructor(page) {
    this.page = page;
    this.logOutButton = page.getByRole('button', { name: 'Log out' });
    this.nav = page.getByRole('navigation', { name: 'Main' });
    this.homeLink = this.nav.getByRole('link', { name: 'Home', exact: true });
    this.appsLink = this.nav.getByRole('link', { name: 'Apps', exact: true });
    this.agentsLink = this.nav.getByRole('link', { name: 'Agents', exact: true });
    this.exploreLink = this.nav.getByRole('link', { name: 'Explore', exact: true });
    this.adminLink = this.nav.getByRole('link', { name: 'Admin', exact: true });
    this.currentPage = this.nav.locator('[aria-current=page]');
    this.themeButton = page.getByRole('button', { name: /^Switch to (light|dark) theme$/ });
    this.pageHeading = page.getByRole('main').getByRole('heading', { level: 2 }).first();
    this.toast = page.getByRole('status');
    this.myApps = new MyAppsSection(page);
    this.gallery = new GallerySection(page);
    this.admin = new AdminSection(page);
    this.palette = new CommandPalette(page);
    this.home = new HomeSection(page);
    this.agents = new AgentsSection(page);
  }

  /** Opens the dashboard already signed in, the way a returning user arrives (or follows a link to `path`). */
  async openAs(token, path = '/') {
    await this.page.goto(path);
    await this.page.evaluate((t) => localStorage.setItem('cubby_token', t), token);
    await this.page.goto(path);
    await this.logOutButton.waitFor();
  }

  account(email) {
    return this.page.getByText(email, { exact: true });
  }

  async openMyApps() {
    await this.appsLink.click();
    await this.page.waitForURL('**/apps');
  }

  async openGallery() {
    await this.exploreLink.click();
    await this.page.waitForURL('**/explore');
  }

  async openAdmin() {
    await this.adminLink.click();
    await this.admin.inviteHeading.waitFor();
  }
}
