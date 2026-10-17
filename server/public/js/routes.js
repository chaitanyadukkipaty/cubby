// The dashboard's pages. Shared by the browser router and the server (which serves the shell for these paths), so
// keep it free of DOM and Node APIs.
const PAGES = new Map([['/', 'home'], ['/apps', 'apps'], ['/agents', 'agents'], ['/explore', 'explore'], ['/admin', 'admin'], ['/connect', 'connect']]);
// Same shape as SLUG_RE in server/src/config.js.
const APP_PAGE = /^\/apps\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;

/** "/apps/polls" → { name: 'app', slug: 'polls' }; a path that isn't a dashboard page → null. */
export function matchRoute(pathname) {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (PAGES.has(path)) return { name: PAGES.get(path) };
  const app = path.match(APP_PAGE);
  return app ? { name: 'app', slug: app[1] } : null;
}

const NAV = [
  { href: '/', label: 'Home', icon: 'home', pages: ['home'] },
  { href: '/apps', label: 'Apps', icon: 'apps', pages: ['apps', 'app'] },
  { href: '/agents', label: 'Agents', icon: 'agents', pages: ['agents'] },
  { href: '/explore', label: 'Explore', icon: 'explore', pages: ['explore'] },
  { href: '/admin', label: 'Admin', icon: 'admin', pages: ['admin'], admin: true },
];

/** The sidebar's links for this user, with the one for the current route marked. */
export function navItems(me, route) {
  return NAV.filter((n) => !n.admin || me?.is_admin)
    .map(({ href, label, icon, pages }) => ({ href, label, icon, current: Boolean(route && pages.includes(route.name)) }));
}
