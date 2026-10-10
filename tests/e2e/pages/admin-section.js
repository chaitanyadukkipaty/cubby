// Admin tab: invites, limits, users and all apps.
export class AdminSection {
  constructor(page) {
    this.page = page;
    this.inviteHeading = page.getByRole('heading', { name: 'Invite people' });
    this.signupCode = page.getByLabel('Current signup code');
    this.rotateCodeButton = page.getByRole('button', { name: 'Rotate code' });
    this.openSignup = page.getByLabel(/Open signup/);
    this.appsPerUser = page.getByLabel('Apps per user');
    this.maxDeployMb = page.getByLabel('Max deploy (MB)');
    this.saveLimitsButton = page.getByRole('button', { name: 'Save limits' });
    this.serverName = page.getByLabel('Server name');
    this.saveNameButton = page.getByRole('button', { name: 'Save name' });
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
    return { row, deleteButton: row.getByRole('button', { name: 'Delete' }) };
  }

  async saveLimits({ appsPerUser, maxDeployMb }) {
    if (appsPerUser !== undefined) await this.appsPerUser.fill(String(appsPerUser));
    if (maxDeployMb !== undefined) await this.maxDeployMb.fill(String(maxDeployMb));
    await this.saveLimitsButton.click();
  }
}
