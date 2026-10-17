// The ⌘K / Ctrl+K command palette.
export class CommandPalette {
  constructor(page) {
    this.page = page;
    this.dialog = page.getByRole('dialog', { name: 'Command palette' });
    this.search = this.dialog.getByRole('combobox', { name: 'Search pages, apps and actions' });
    this.options = this.dialog.getByRole('option');
    this.selected = this.dialog.locator('[role=option][aria-selected=true]');
    this.openButton = page.getByRole('button', { name: 'Search', exact: true });
  }

  /** Opens it with the keyboard (Ctrl+K; ⌘K on macOS is the same handler). */
  async openWithKeyboard() {
    await this.page.keyboard.press('Control+k');
    await this.search.waitFor();
  }

  option(name) {
    return this.dialog.getByRole('option', { name });
  }
}
