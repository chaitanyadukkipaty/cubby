// Shared fixtures: an API client for test data, and page objects bound to the current page.
import { test as base, expect } from '@playwright/test';
import { Api, serverUrl } from './api.js';
import { AuthPage } from '../pages/auth-page.js';
import { DashboardPage } from '../pages/dashboard-page.js';
import { ConnectPage } from '../pages/connect-page.js';

export const test = base.extend({
  baseURL: async ({}, use) => use(serverUrl()),
  api: async ({}, use) => use(new Api()),
  authPage: async ({ page }, use) => use(new AuthPage(page)),
  dashboard: async ({ page }, use) => use(new DashboardPage(page)),
  connectPage: async ({ page }, use) => use(new ConnectPage(page)),
});

export { expect };

/** Answers the next confirm()/prompt() the page opens. Pass text for a prompt; omit to accept a confirm. */
export function answerNextDialog(page, text) {
  page.once('dialog', (dialog) => (dialog.type() === 'prompt' ? dialog.accept(text) : dialog.accept()));
}
