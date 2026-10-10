// Agent login: the agent prints a link, a person approves it in the browser, the agent gets a token.
import { test, expect } from './support/fixtures.js';
import { uid } from './support/api.js';

test('a person approves an agent login from its link, and the agent receives a working token', async ({ page, api, authPage, connectPage }) => {
  const device = await api.startDeviceLogin();
  expect(await api.pollDeviceLogin(device.device_id)).toEqual({ status: 'pending' });

  await connectPage.goto(device.verify_url);
  await expect(connectPage.signInHeading).toBeVisible();
  await expect(connectPage.credit).toBeVisible();
  const email = `${uid('agentowner')}@e2e.dev`;
  const { signup_code: code } = await api.settings();
  await authPage.signUp({ email, password: 'password1234', code });

  await expect(connectPage.approvalHeading).toBeVisible();
  await expect(connectPage.code).toHaveText(device.user_code);
  await expect(page.getByText(email)).toBeVisible();
  await connectPage.approveButton.click();
  await expect(connectPage.connectedHeading).toBeVisible();

  const result = await api.pollDeviceLogin(device.device_id);
  expect(result.status).toBe('approved');
  expect(await api.meStatus(result.token)).toBe(200);
  // Single use: the same login can't be collected twice.
  expect((await api.as()('POST', '/api/device/poll', { body: { device_id: device.device_id } })).status).toBe(410);
});

test('an unknown or expired code shows a clear error instead of approving', async ({ page, api, connectPage }) => {
  const user = await api.createUser('conn');
  await page.goto('/');
  await page.evaluate((t) => localStorage.setItem('cubby_token', t), user.token);
  await connectPage.goto('/connect?code=ZZZZ-9999');

  await expect(connectPage.code).toHaveText('ZZZZ-9999');
  await connectPage.approveButton.click();
  await expect(connectPage.error).toHaveText(/expired or was already used/);
  await expect(connectPage.connectedHeading).toHaveCount(0);
});
