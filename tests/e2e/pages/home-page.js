// Home: first-run connect steps, or the agent activity timeline with its summary column.
export class HomeSection {
  constructor(page) {
    this.page = page;
    this.steps = page.getByRole('list', { name: 'Get started' });
    this.nextPrompts = page.getByRole('region', { name: 'What should your agent do next?' });
    this.feed = page.getByRole('region', { name: 'Agent activity' });
    this.summary = page.getByRole('complementary', { name: 'Summary' });
    this.agentsCard = this.summary.getByRole('region', { name: 'Your agents' });
    this.activeNow = this.summary.getByRole('region', { name: 'Active now' });
    this.views = this.summary.getByRole('region', { name: 'Views · 7 days' });
  }

  /** The feed line that mentions `text` (e.g. "deployed my-app"). */
  entry(text) {
    const line = this.feed.getByRole('listitem').filter({ hasText: text });
    return {
      line,
      rollBackButton: line.getByRole('button', { name: 'Roll back' }),
      fixItButton: line.getByRole('button', { name: 'Copy fix-it prompt' }),
    };
  }
}
