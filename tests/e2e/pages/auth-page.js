// Logged-out dashboard: the sign up / log in card (also shown on /connect before approving).
export class AuthPage {
  constructor(page) {
    this.page = page;
    this.signUpTab = page.getByRole('tab', { name: 'Sign up' });
    this.logInTab = page.getByRole('tab', { name: 'Log in' });
    this.email = page.getByLabel('Email');
    this.password = page.getByLabel('Password');
    this.signupCode = page.getByLabel('Signup code');
    this.createAccountButton = page.getByRole('button', { name: 'Create account' });
    this.logInButton = page.getByRole('button', { name: 'Log in', exact: true });
    this.error = page.getByRole('alert');
    this.httpWarning = page.getByText('runs on plain HTTP');
  }

  async goto() {
    await this.page.goto('/');
  }

  async signUp({ email, password, code }) {
    await this.signUpTab.click();
    await this.email.fill(email);
    await this.password.fill(password);
    if (code !== undefined) await this.signupCode.fill(code);
    await this.createAccountButton.click();
  }

  async logIn({ email, password }) {
    await this.logInTab.click();
    await this.email.fill(email);
    await this.password.fill(password);
    await this.logInButton.click();
  }
}
