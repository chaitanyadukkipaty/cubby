// Admin page (/admin[/<tab>]): Overview, Users, Apps, Agents, Jobs, Settings and Storage tabs.
export class AdminSection {
  constructor(page) {
    this.page = page;
    this.tabs = page.getByRole('navigation', { name: 'Admin sections' });
    this.tab = (name) => this.tabs.getByRole('link', { name, exact: true });
    this.currentTab = this.tabs.locator('[aria-current=page]');
    this.kpis = page.getByRole('list', { name: 'Server numbers' });
    this.inviteHeading = page.getByRole('heading', { name: 'Invite people' });
    this.signupCode = page.getByLabel('Current signup code');
    this.rotateCodeButton = page.getByRole('button', { name: 'Rotate code' });
    this.openSignup = page.getByLabel(/Open signup/);
    this.appsPerUser = page.getByLabel('Apps per user');
    this.maxDeployMb = page.getByLabel('Max deploy (MB)');
    this.saveLimitsButton = page.getByRole('button', { name: 'Save limits' });
    this.serverName = page.getByLabel('Server name');
    this.saveNameButton = page.getByRole('button', { name: 'Save name' });
    this.backupKeep = page.getByLabel('Nightly backups to keep');
    this.saveRetentionButton = page.getByRole('button', { name: 'Save retention' });
    this.updates = page.getByRole('region', { name: 'Updates' });
    this.releaseNotesLink = this.updates.getByRole('link', { name: /Release notes/ });
    this.copyUpgradeButton = this.updates.getByRole('button', { name: 'Copy command' });
    this.updateCheck = page.getByLabel(/Check for new Cubby releases/);
    this.jobsHeading = page.getByRole('heading', { name: /^Scheduled jobs \(\d+\)$/ });
    this.runJobs = page.getByLabel(/Run scheduled jobs/);
    this.jobTimeout = page.getByLabel('Time limit per run (seconds)');
    this.saveJobTimeoutButton = page.getByRole('button', { name: 'Save', exact: true });
    this.jobRow = (app, job) => page.getByRole('row').filter({ hasText: app }).filter({ hasText: job });
    // Storage
    this.diskBar = page.getByRole('img', { name: /^Disk: / });
    this.backups = page.getByRole('region', { name: 'Backups' });
    this.backUpNowButton = this.backups.getByRole('button', { name: /^(Back up now|Backing up…)$/ });
    this.backupRow = (date) => this.backups.getByRole('row', { name: date });
    this.backupRows = this.backups.getByRole('table', { name: 'Backup list' }).getByRole('row');
    this.appsBySize = page.getByRole('table', { name: 'Apps by size' });
    this.agentsTable = page.getByRole('table', { name: 'Agents on this server' });
  }

  async openTab(name) {
    await this.tab(name).click();
    await this.page.waitForURL(name === 'Overview' ? '**/admin' : `**/admin/${name.toLowerCase()}`);
  }

  async renameServer(name) {
    await this.serverName.fill(name);
    await this.saveNameButton.click();
  }

  userRow(email) {
    const row = this.page.getByRole('row').filter({ hasText: email });
    return {
      row,
      disableButton: row.getByRole('button', { name: 'Disable' }),
      enableButton: row.getByRole('button', { name: 'Enable' }),
      deleteButton: row.getByRole('button', { name: 'Delete' }),
      disabledBadge: row.getByText('disabled', { exact: true }),
    };
  }

  appRow(slug) {
    const row = this.page.getByRole('row').filter({ has: this.page.getByRole('link', { name: slug, exact: true }) });
    return {
      row,
      deleteButton: row.getByRole('button', { name: 'Delete', exact: true }),
      deploysButton: row.getByRole('button', { name: 'Deploys' }),
      clearDataLink: row.getByRole('link', { name: 'Clear data' }),
    };
  }

  async saveLimits({ appsPerUser, maxDeployMb }) {
    if (appsPerUser !== undefined) await this.appsPerUser.fill(String(appsPerUser));
    if (maxDeployMb !== undefined) await this.maxDeployMb.fill(String(maxDeployMb));
    await this.saveLimitsButton.click();
  }
}
