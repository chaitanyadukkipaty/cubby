// Agent login: the agent prints a link, a person approves it in the browser, the agent gets a token.
import { test, expect } from './support/fixtures.js';
import { uid } from './support/api.js';

test('a person approves an agent login from its link, and the agent receives a working token of its own', async ({ page, api, authPage, connectPage }) => {
  const device = await api.startDeviceLogin({ tool: 'Claude Code', machine: 'e2e-laptop' });
  expect(await api.pollDeviceLogin(device.device_id)).toEqual({ status: 'pending' });

  await connectPage.goto(device.verify_url);
  await expect(connectPage.signInHeading).toBeVisible();
  await expect(connectPage.credit).toBeVisible();
  // Before sign-in the page can't know (and mustn't reveal) which machine is asking.
  await expect(connectPage.asker).toHaveText('An AI agent on your computer wants access');
  expect((await api.as()('GET', `/api/device/${device.user_code}`)).data).toEqual({ ok: true });
  const email = `${uid('agentowner')}@e2e.dev`;
  const { signup_code: code } = await api.settings();
  await authPage.signUp({ email, password: 'password1234', code });

  await expect(connectPage.approvalHeading).toBeVisible();
  await expect(connectPage.code).toHaveText(device.user_code);
  await expect(connectPage.asker).toHaveText('Claude Code on e2e-laptop wants access');
  await expect(page.getByText(email)).toBeVisible();
  await connectPage.approveButton.click();
  await expect(connectPage.connectedHeading).toBeVisible();

  const result = await api.pollDeviceLogin(device.device_id);
  expect(result.status).toBe('approved');
  expect(await api.meStatus(result.token)).toBe(200);
  const agents = (await api.as(result.token)('GET', '/api/agents')).data;
  expect(agents.find((a) => a.current)).toMatchObject({ name: 'Claude Code · e2e-laptop', tool: 'Claude Code', machine: 'e2e-laptop' });
  // Single use: the same login can't be collected twice.
  expect((await api.as()('POST', '/api/device/poll', { body: { device_id: device.device_id } })).status).toBe(410);
});

test('an unknown or expired code shows a clear error instead of approving', async ({ page, api, connectPage }) => {
  const user = await api.createUser('conn');
  await page.goto('/');
  await page.evaluate((t) => localStorage.setItem('cubby_token', t), user.token);
  await connectPage.goto('/connect?code=ZZZZ-9999');

  await expect(connectPage.code).toHaveText('ZZZZ-9999');
  await expect(connectPage.asker).toHaveText('An AI agent on your computer wants access');
  await connectPage.approveButton.click();
  await expect(connectPage.error).toHaveText(/expired or was already used/);
  await expect(connectPage.connectedHeading).toHaveCount(0);
});
