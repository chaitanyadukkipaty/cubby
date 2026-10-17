// Explore (/explore): everyone's listed apps.
export class GallerySection {
  constructor(page) {
    this.page = page;
  }

  app(name) {
    const card = this.page.getByRole('article', { name, exact: true });
    return { card, owner: card.getByText(/^by /), openLink: card.getByRole('link', { name: /Open/ }) };
  }
}
