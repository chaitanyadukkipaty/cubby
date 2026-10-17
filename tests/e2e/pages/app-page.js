// /apps/:slug[/<tab>]: one app, with Overview, Activity, Deploys, Jobs, Env and Settings tabs.
export class AppPage {
  constructor(page) {
    this.page = page;
    this.tabs = page.getByRole('navigation', { name: 'App sections' });
    this.currentTab = this.tabs.locator('[aria-current=page]');
    this.body = page.getByRole('main').locator('.tab-body');
    // Overview
    this.kpis = page.getByRole('list', { name: 'Key numbers' });
    this.range = page.getByRole('group', { name: 'Range' });
    this.topPaths = page.getByRole('table', { name: 'Top paths' });
    // Deploys
    this.deploys = page.getByRole('table', { name: 'Deploys' });
    // Env
    this.secrets = page.getByRole('table', { name: 'Secrets' });
    this.secretName = page.getByRole('textbox', { name: 'Name' });
    this.secretValue = page.getByLabel('Value', { exact: true });
    this.saveSecretButton = page.getByRole('button', { name: 'Save secret' });
    // Settings
    this.showInGallery = page.getByLabel(/^Show in gallery/);
    this.deleteButton = page.getByRole('button', { name: 'Delete this app' });
    // Empty states
    this.askAgent = page.getByText('Ask your agent:');
  }

  async goto(slug, tab = '') {
    await this.page.goto(`/apps/${slug}${tab ? `/${tab}` : ''}`);
    await this.tabs.waitFor();
  }

  tab(name) {
    return this.tabs.getByRole('link', { name: new RegExp(`^${name}`) });
  }

  chart(name) {
    return this.page.getByRole('region', { name, exact: true });
  }

  kpi(label) {
    return this.kpis.getByRole('listitem').filter({ hasText: label });
  }

  deploy(label) {
    const row = this.deploys.getByRole('row', { name: label, exact: true });
    return { row, live: row.getByText('live', { exact: true }), rollBackButton: row.getByRole('button', { name: `Roll back to ${label}` }) };
  }

  secret(key) {
    const row = this.secrets.getByRole('row', { name: key, exact: true });
    return { row, unsetButton: row.getByRole('button', { name: `Unset ${key}` }) };
  }

  deleteConfirm(slug) {
    return this.page.getByRole('textbox', { name: `Type ${slug} to confirm` });
  }

  job(job) {
    const group = this.page.getByRole('group', { name: `Job ${job}` });
    return {
      group,
      state: group.locator('.badge'),
      details: group.getByText(/ UTC · /),
      runButton: group.getByRole('button', { name: 'Run now' }),
      pauseButton: group.getByRole('button', { name: 'Pause' }),
      resumeButton: group.getByRole('button', { name: 'Resume' }),
      lastLogButton: group.getByRole('button', { name: 'Last log' }),
      log: group.locator('pre'),
    };
  }
}
