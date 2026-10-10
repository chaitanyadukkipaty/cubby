// The app a user gets from `cubby init`: created and deployed through the real CLI, then used in a browser.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from './support/fixtures.js';
import { Api, appUrl, serverUrl, uid } from './support/api.js';
import { TemplateAppPage } from './pages/template-app-page.js';
import { ROOT } from '../helpers/server.js';

test.describe.configure({ mode: 'serial' });

let url, appDir, workDir, homeDir;

test.beforeAll(async () => {
  test.setTimeout(300_000); // real npm install + vite build
  const user = await new Api().createUser('tpl');
  homeDir = mkdtempSync(join(tmpdir(), 'cubby-e2e-home-'));
  workDir = mkdtempSync(join(tmpdir(), 'cubby-e2e-work-'));
  const env = { ...process.env, HOME: homeDir, npm_config_cache: join(homedir(), '.npm') };
  delete env.CUBBY_TOKEN;
  const cubby = (args, cwd) => execFileSync(process.execPath, [join(ROOT, 'cli/src/launcher.js'), ...args, '--json'], { cwd, env, encoding: 'utf8' });

  const slug = uid('tpl');
  cubby(['login', serverUrl(), '--token', user.token, '--no-skill'], workDir);
  cubby(['init', slug], workDir);
  appDir = join(workDir, slug);
  cubby(['deploy', '-m', 'e2e'], appDir);
  url = appUrl(slug);
});

test.afterAll(() => {
  for (const dir of [workDir, homeDir]) if (dir) rmSync(dir, { recursive: true, force: true });
});

const newAppUser = () => ({ email: `${uid('member')}@e2e.dev`, password: 'password1234' });

test('sign up, add, complete and delete tasks; everything persists across reloads', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const app = new TemplateAppPage(page);

  await app.goto(url);
  await expect(app.logInButton).toBeVisible(); // logged-out visitors get the auth form
  await app.signUp(newAppUser().email, 'password1234');
  await expect(app.emptyState).toBeVisible();

  await app.addTask('Buy milk');
  await app.addTask('Walk the dog');
  await app.toggleDone('Buy milk');
  await expect(app.task('Buy milk').done).toBeChecked();

  await page.reload();
  await expect(app.task('Walk the dog').item).toBeVisible();
  await expect(app.task('Buy milk').done).toBeChecked();

  await app.task('Walk the dog').deleteButton.click();
  await expect(app.task('Walk the dog').item).toHaveCount(0);
  await page.reload();
  await expect(app.task('Buy milk').item).toBeVisible();
  await expect(app.task('Walk the dog').item).toHaveCount(0);

  expect(errors, 'browser console errors').toEqual([]);
});

test('a new task appears live in a second tab of the same user, without reloading', async ({ browser }) => {
  const user = newAppUser();
  const first = new TemplateAppPage(await browser.newPage());
  await first.goto(url);
  await first.signUp(user.email, user.password);

  const secondContext = await browser.newContext();
  const second = new TemplateAppPage(await secondContext.newPage());
  await second.goto(url);
  await second.logIn(user.email, user.password);
  await expect(second.emptyState).toBeVisible();

  await first.addTask('Shared in real time');
  await expect(second.task('Shared in real time').item).toBeVisible();

  await first.page.close();
  await secondContext.close();
});

test("app users can't see each other's tasks", async ({ browser }) => {
  const alice = new TemplateAppPage(await browser.newPage());
  await alice.goto(url);
  await alice.signUp(newAppUser().email, 'password1234');
  await alice.addTask("Alice's private task");

  const bobContext = await browser.newContext();
  const bob = new TemplateAppPage(await bobContext.newPage());
  await bob.goto(url);
  await bob.signUp(newAppUser().email, 'password1234');
  await expect(bob.emptyState).toBeVisible();
  await expect(bob.task("Alice's private task").item).toHaveCount(0);

  await alice.page.close();
  await bobContext.close();
});

test('the generated app typechecks', () => {
  execFileSync('npm', ['run', 'typecheck'], { cwd: appDir, encoding: 'utf8', stdio: 'pipe' });
});
