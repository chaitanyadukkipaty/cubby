// Admin → Security: IPs fail2ban banned, what a scanner swept, and unbanning one. The test plays the host: it writes
// fail2ban's ban event and Caddy's access log into the shared folder, and answers the unban request.
import { appendFileSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './support/fixtures.js';

const dir = () => process.env.CUBBY_E2E_F2B_DIR;
// Like the host: written in tmp/, then moved in whole.
function hostWrite(sub, name, data) {
  writeFileSync(join(dir(), 'tmp', name), JSON.stringify(data));
  renameSync(join(dir(), 'tmp', name), join(dir(), sub, name));
}
// Answers every unban request with ok, like the host's unit after `fail2ban-client unban`.
function answerUnbans() {
  const timer = setInterval(() => {
    for (const name of readdirSync(join(dir(), 'requests'))) {
      const req = JSON.parse(readFileSync(join(dir(), 'requests', name), 'utf8'));
      rmSync(join(dir(), 'requests', name));
      hostWrite('results', `${req.id}.json`, { id: req.id, ok: true });
    }
  }, 50);
  return () => clearInterval(timer);
}

test.beforeEach(async ({ api, dashboard }) => {
  await dashboard.openAs(await api.adminToken());
});

test('security: a scanner\'s ban shows what it swept, and unbanning moves it to the last 90 days', async ({ page, dashboard }) => {
  const { admin } = dashboard;
  // An address from the benchmarking range (never a real visitor), different on every run.
  const ip = `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
  const line = (host, uri) => JSON.stringify({ level: 'info', ts: new Date().toISOString(), logger: 'http.log.access.log0', msg: 'handled request',
    request: { remote_ip: ip, remote_port: '1', client_ip: ip, proto: 'HTTP/1.1', method: 'GET', host, uri }, bytes_read: 0, user_id: '', duration: 0.001, size: 0, status: 404 });
  appendFileSync(process.env.CUBBY_E2E_ACCESS_LOG, `${line('todo.example.test', '/.env')}\n${line('chat.example.test', '/.git/config')}\n`);
  hostWrite('events', `${Date.now()}.json`, { event: 'ban', ip, jail: 'cubby-probe', time: Math.floor(Date.now() / 1000), bantime: 600 });

  // Straight to the tab (it's in the URL): the Overview would cache the storage scan the next spec checks.
  await page.goto('/admin/security');
  await expect(admin.currentTab).toHaveText('Security');
  const row = admin.banRow(ip);
  await expect(row).toBeVisible();
  // Nothing renders as stray text (DOM methods print null and undefined as words).
  expect(await page.locator('body').innerText()).not.toMatch(/\b(null|undefined)\b/);
  await expect(row).toContainText('Scanning for secret files');
  await expect(row).toContainText(/lifts in (9|10) min/);
  await expect(row).toContainText('Swept 2 apps: todo.example.test, chat.example.test');
  await row.getByRole('button', { name: `Show paths ${ip} asked for` }).click();
  await expect(row.getByRole('list', { name: `Paths ${ip} asked for` })).toContainText('/.git/config');

  const stop = answerUnbans();
  try {
    let message = '';
    page.once('dialog', (d) => { message = d.message(); d.accept(); });
    await row.getByRole('button', { name: `Unban ${ip}` }).click();
    await expect(dashboard.toast).toHaveText(`Unbanned ${ip}`);
    expect(message).toBe(`Unban ${ip} (Scanning for secret files)? It can reach every app on this server again right away.`);
  } finally { stop(); }
  await expect(admin.banRow(ip)).toHaveCount(0);
  await expect(admin.pastBanRow(ip)).toContainText('Unbanned by admin@test.dev');
});
