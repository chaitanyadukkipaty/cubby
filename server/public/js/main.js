// Dashboard entry point: loads the server info and the signed-in user, then draws the page for the current URL
// inside the shell (sidebar on wide screens, bottom bar on phones).
import { h, displayName, parseConnectCode } from './helpers.js';
import { navItems } from './routes.js';
import { state, loadMe, logout, setRenderer } from './session.js';
import { currentRoute, navigate, startRouter } from './router.js';
import { credit, httpBanner, icon, logo, toast } from './ui.js';
import { themeButton } from './theme.js';
import { renderAuth } from './views/auth.js';
import { renderConnect } from './views/connect.js';
import { renderHome } from './views/home.js';
import { renderApps, renderApp } from './views/apps.js';
import { renderAgents } from './views/agents.js';
import { renderExplore } from './views/explore.js';
import { renderAdmin } from './views/admin.js';

const $app = document.getElementById('app');

const VIEWS = { home: renderHome, apps: renderApps, app: renderApp, agents: renderAgents, explore: renderExplore, admin: renderAdmin };

function sidebar(route) {
  const { me, info } = state;
  return h('aside', { class: 'side-col' }, h('div', { class: 'side' },
    h('div', { class: 'brand' }, logo(), h('div', {}, h('h1', {}, displayName(info.name)), credit())),
    h('nav', { class: 'nav', 'aria-label': 'Main' }, navItems(me, route).map((n) =>
      h('a', { href: n.href, 'aria-current': n.current ? 'page' : false }, icon(n.icon), h('span', {}, n.label)))),
    h('div', { class: 'foot' },
      h('div', { class: 'who' }, h('span', { class: 'av', 'aria-hidden': 'true' }, me.email[0]), h('span', { class: 'email', title: me.email }, me.email),
        me.is_admin ? h('span', { class: 'badge accent' }, 'admin') : null),
      h('div', { class: 'row' }, themeButton(), h('button', { type: 'button', onclick: logout }, 'Log out')),
    ),
  ));
}

function render() {
  const route = currentRoute();
  if (!state.token || !state.me) return renderAuth($app, route?.name === 'connect' ? parseConnectCode(location.pathname, location.search) : null);
  if (route?.name === 'connect') {
    const code = parseConnectCode(location.pathname, location.search);
    if (code) return renderConnect($app, code);
    return navigate('/', { replace: true });
  }
  if (route?.name === 'admin' && !state.me.is_admin) return navigate('/', { replace: true });
  const main = h('main', { id: 'main' });
  $app.replaceChildren(h('div', { class: 'shell' }, sidebar(route), main));
  const banner = httpBanner();
  const page = h('div');
  main.append(banner ?? '', page);
  if (!route) return page.replaceChildren(h('div', { class: 'placeholder' }, h('p', {}, 'Nothing here.'), h('a', { href: '/' }, 'Go home')));
  Promise.resolve(VIEWS[route.name](page, route)).catch((ex) => toast(ex.message));
}

setRenderer(render);
startRouter(render);
try { state.info = await (await fetch('/api/info')).json(); } catch {}
document.title = displayName(state.info.name);
await loadMe();
render();
