// The dashboard's pages. Shared by the browser router and the server (which serves the shell for these paths), so
// keep it free of DOM and Node APIs.
const PAGES = new Map([['/', 'home'], ['/apps', 'apps'], ['/agents', 'agents'], ['/explore', 'explore'], ['/connect', 'connect']]);
// An app page's tabs, in order. The first is the default and has no path segment of its own.
export const APP_TABS = ['overview', 'activity', 'deploys', 'jobs', 'env', 'data', 'settings'];
// The admin page's tabs, the same way: /admin is the overview, /admin/storage another tab.
export const ADMIN_TABS = ['overview', 'users', 'apps', 'agents', 'jobs', 'settings', 'storage'];
// /admin[/<tab>], or /admin/apps/<slug>: an admin clearing data of any app.
const ADMIN_PAGE = /^\/admin(?:\/([a-z]+)(?:\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*))?)?$/;
// Same shape as SLUG_RE in server/src/config.js.
const APP_PAGE = /^\/apps\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:\/([a-z]+))?$/;
// An agent is its API key's PocketBase id.
const AGENT_PAGE = /^\/agents\/([a-z0-9]{15})$/;

/** "/apps/polls/deploys" → { name: 'app', slug: 'polls', tab: 'deploys' }; a path that isn't a dashboard page → null. */
export function matchRoute(pathname) {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (PAGES.has(path)) return { name: PAGES.get(path) };
  const adm = path.match(ADMIN_PAGE);
  if (adm) {
    const [, tab = ADMIN_TABS[0], slug] = adm;
    if (!ADMIN_TABS.includes(tab) || (adm[1] === ADMIN_TABS[0]) || (slug && tab !== 'apps')) return null;
    return slug ? { name: 'admin', tab, slug } : { name: 'admin', tab };
  }
  const app = path.match(APP_PAGE);
  if (app && (!app[2] || APP_TABS.includes(app[2]))) return { name: 'app', slug: app[1], tab: app[2] || APP_TABS[0] };
  const agent = path.match(AGENT_PAGE);
  return agent ? { name: 'agent', id: agent[1] } : null;
}

/** The URL of an app page's tab: "/apps/polls" for the overview, "/apps/polls/deploys" for another tab. */
export const appPath = (slug, tab = APP_TABS[0]) => (tab === APP_TABS[0] ? `/apps/${slug}` : `/apps/${slug}/${tab}`);

/** The URL of an admin tab ("/admin", "/admin/storage"), or of the data page of one app ("/admin/apps/polls"). */
export const adminPath = (tab = ADMIN_TABS[0], slug) => (slug ? `/admin/${tab}/${slug}` : tab === ADMIN_TABS[0] ? '/admin' : `/admin/${tab}`);

const NAV = [
  { href: '/', label: 'Home', icon: 'home', pages: ['home'] },
  { href: '/apps', label: 'Apps', icon: 'apps', pages: ['apps', 'app'] },
  { href: '/agents', label: 'Agents', icon: 'agents', pages: ['agents', 'agent'] },
  { href: '/explore', label: 'Explore', icon: 'explore', pages: ['explore'] },
  { href: '/admin', label: 'Admin', icon: 'admin', pages: ['admin'], admin: true },
];

/** The sidebar's links for this user, with the one for the current route marked. */
export function navItems(me, route) {
  return NAV.filter((n) => !n.admin || me?.is_admin)
    .map(({ href, label, icon, pages }) => ({ href, label, icon, current: Boolean(route && pages.includes(route.name)) }));
}
