// "My apps" tab: the connect-your-agent card, the token, and the user's own apps.
export class MyAppsSection {
  constructor(page) {
    this.page = page;
    this.connectHeading = page.getByRole('heading', { name: /^A home for every/ });
    this.appIdea = this.connectHeading.locator('.chip');
    this.setupPrompt = page.getByLabel('Setup prompt');
    this.copyPromptButton = page.getByRole('button', { name: 'Copy prompt for agent' });
    this.tokenToggle = page.getByText('Token for scripts and CI');
    this.token = page.getByLabel('Your token');
    this.revealButton = page.getByRole('button', { name: 'Reveal' });
    this.regenerateButton = page.getByRole('button', { name: 'Regenerate' });
    this.emptyState = page.getByText('No apps yet.');
  }

  app(name) {
    const card = this.page.getByRole('article', { name, exact: true });
    return {
      card,
      status: card.getByText(/^Deployed |^Not deployed yet$/),
      openLink: card.getByRole('link', { name: /Open/ }),
      showInGallery: card.getByLabel('Show in gallery'),
      unlistedBadge: card.getByText('unlisted', { exact: true }),
      deleteButton: card.getByRole('button', { name: 'Delete' }),
    };
  }

  async revealToken() {
    await this.tokenToggle.click();
    await this.revealButton.click();
    return (await this.token.textContent()).trim();
  }
}
