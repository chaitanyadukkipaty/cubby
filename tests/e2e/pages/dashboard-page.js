// Logged-in dashboard shell (header + tabs) and its three sections.
import { MyAppsSection } from './my-apps-section.js';
import { GallerySection } from './gallery-section.js';
import { AdminSection } from './admin-section.js';

export class DashboardPage {
  constructor(page) {
    this.page = page;
    this.logOutButton = page.getByRole('button', { name: 'Log out' });
    this.myAppsTab = page.getByRole('tab', { name: 'My apps' });
    this.galleryTab = page.getByRole('tab', { name: "Everyone's apps" });
    this.adminTab = page.getByRole('tab', { name: 'Admin' });
    this.toast = page.getByRole('status');
    this.myApps = new MyAppsSection(page);
    this.gallery = new GallerySection(page);
    this.admin = new AdminSection(page);
  }

  /** Opens the dashboard already signed in, the way a returning user arrives. */
  async openAs(token, path = '/') {
    await this.page.goto(path);
    await this.page.evaluate((t) => localStorage.setItem('cubby_token', t), token);
    await this.page.goto(path);
    await this.logOutButton.waitFor();
  }

  account(email) {
    return this.page.getByText(email, { exact: true });
  }

  async openGallery() {
    await this.galleryTab.click();
  }

  async openAdmin() {
    await this.adminTab.click();
    await this.admin.inviteHeading.waitFor();
  }
}
