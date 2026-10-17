// /agents (the table of connected agents and the manual token) and /agents/:id (one agent's activity).
export class AgentsSection {
  constructor(page) {
    this.page = page;
    this.table = page.getByRole('table', { name: 'Your agents' });
    this.connectButton = page.getByRole('button', { name: 'Connect a new agent' });
    this.createTokenLink = page.getByRole('link', { name: 'Create a token' });
    this.tokenCard = page.getByRole('region', { name: 'Token for scripts and CI' });
    this.token = page.getByLabel('Your token');
    this.revealButton = this.tokenCard.getByRole('button', { name: 'Reveal' });
    this.copyTokenButton = this.tokenCard.getByRole('button', { name: 'Copy' });
    this.regenerateButton = this.tokenCard.getByRole('button', { name: 'Regenerate' });
    this.empty = page.getByText(/^No agents yet\./);
  }

  async goto() {
    await this.page.goto('/agents');
    await this.connectButton.waitFor();
  }

  agent(name) {
    const row = this.table.getByRole('row', { name, exact: true });
    return {
      row,
      link: row.getByRole('link', { name, exact: true }),
      renameButton: row.getByRole('button', { name: `Rename ${name}` }),
      revokeButton: row.getByRole('button', { name: `Revoke ${name}` }),
      nameInput: row.getByRole('textbox', { name: `New name for ${name}` }),
      saveButton: row.getByRole('button', { name: 'Save' }),
    };
  }

  async revealToken() {
    await this.revealButton.click();
    return (await this.token.textContent()).trim();
  }
}
