// Home's connect-your-agent card, and /apps (the user's own apps, one table row each).
export class MyAppsSection {
  constructor(page) {
    this.page = page;
    this.connectHeading = page.getByRole('heading', { name: /^A home for every/ });
    this.appIdea = this.connectHeading.locator('.chip');
    this.setupPrompt = page.getByLabel('Setup prompt');
    this.copyPromptButton = page.getByRole('button', { name: 'Copy prompt for agent' });
    this.table = page.getByRole('table', { name: 'Your apps' });
    this.emptyState = page.getByText('No apps yet.');
  }

  app(name) {
    const row = this.table.getByRole('row', { name, exact: true });
    return {
      row,
      link: row.getByRole('link', { name, exact: true }),
      status: row.getByText(/^Deployed |^Not deployed yet$/),
      openLink: row.getByRole('link', { name: `Open ${name}` }),
      unlistedBadge: row.getByText('unlisted', { exact: true }),
      sparkline: row.getByRole('img', { name: new RegExp(`^${name} views per day`) }),
    };
  }
}
