// The Data panel: an app's Data tab (/apps/:slug/data), and Admin → Apps → Clear data (/admin/apps/:slug).
export class DataPanel {
  constructor(page) {
    this.page = page;
    this.collections = page.getByRole('table', { name: 'Collections' });
    this.collectionRow = (name) => this.collections.getByRole('row', { name });
    this.tick = (name) => page.getByRole('checkbox', { name: `Clear ${name}` });
    this.mode = (label) => page.getByRole('radio', { name: new RegExp(`^${label}`) });
    this.collectionSelect = page.getByLabel('Collection to delete records from');
    this.filter = page.getByRole('textbox', { name: 'Filter', exact: true });
    this.createdBefore = page.getByLabel('Created before');
    this.previewButton = page.getByRole('button', { name: 'Preview', exact: true });
    this.preview = page.getByRole('region', { name: 'Preview' });
    this.samples = page.getByRole('table', { name: 'Sample records' });
    this.authWarning = page.getByText(/holds the app's user accounts/);
    this.reason = page.getByLabel('Reason (shown to the owner)');
    this.confirmText = page.getByLabel(/^Type .* to confirm$/);
    this.deleteButton = page.getByRole('button', { name: /^(Empty collections|Drop collections|Delete matching records|Delete \d+ ticked)$/ });
    this.result = page.getByRole('status', { name: 'Result' });
    this.snapshots = page.getByRole('table', { name: 'Snapshots' });
    this.restorePanel = page.getByRole('region', { name: 'Restore' });
    this.overwrite = page.getByLabel(/^Overwrite records that exist again/);
  }

  snapshotRow(id) {
    const row = this.snapshots.getByRole('row', { name: id });
    return { row, restoreButton: row.getByRole('button', { name: `Restore ${id}` }), purgeButton: row.getByRole('button', { name: `Purge ${id}` }) };
  }

  /** The id of the newest snapshot (the first row). */
  async newestSnapshotId() {
    return (await this.snapshots.locator('tbody tr').first().locator('.mono').first().textContent()).trim();
  }

  async confirm(slug) {
    await this.confirmText.fill(slug);
  }
}
