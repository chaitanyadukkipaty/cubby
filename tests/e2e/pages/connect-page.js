// /connect?code=… — a person approving an agent's login.
export class ConnectPage {
  constructor(page) {
    this.page = page;
    // Headings name the server ("…to Priya's Cubby"); the admin spec may rename it mid-run, so match any name.
    this.signInHeading = page.getByRole('heading', { name: /^Connect your agent\s*to .+\.$/ });
    this.approvalHeading = page.getByRole('heading', { name: /^Connect your agent to .+\?$/ });
    this.credit = page.getByText(/runs on\s*Cubby/);
    this.code = page.getByLabel('Connection code');
    this.asker = page.getByLabel('Requesting agent');
    this.approveButton = page.getByRole('button', { name: 'Approve' });
    this.connectedHeading = page.getByRole('heading', { name: /Agent connected/ });
    this.error = page.getByRole('alert');
  }

  async goto(verifyUrl) {
    await this.page.goto(verifyUrl);
  }
}
