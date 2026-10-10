// /connect?code=… — a person approving an agent's login.
export class ConnectPage {
  constructor(page) {
    this.page = page;
    this.signInHeading = page.getByRole('heading', { name: /Connect your agent\s*to this server/ });
    this.approvalHeading = page.getByRole('heading', { name: 'Connect your agent?' });
    this.code = page.getByLabel('Connection code');
    this.approveButton = page.getByRole('button', { name: 'Approve' });
    this.connectedHeading = page.getByRole('heading', { name: /Agent connected/ });
    this.error = page.getByRole('alert');
  }

  async goto(verifyUrl) {
    await this.page.goto(verifyUrl);
  }
}
