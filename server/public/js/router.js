// History-API routing on the root host. The server serves the same shell for every path in routes.js, so a
// reload or a pasted link lands on the same page.
import { matchRoute } from './routes.js';

let onChange = () => {};

export const currentRoute = () => matchRoute(location.pathname);

export function navigate(path, { replace = false } = {}) {
  if (path !== location.pathname + location.search) history[replace ? 'replaceState' : 'pushState'](null, '', path);
  onChange();
  if (!replace) window.scrollTo(0, 0);
}

/** Calls render on back/forward and turns clicks on same-origin dashboard links into in-page navigation. */
export function startRouter(render) {
  onChange = render;
  window.addEventListener('popstate', render);
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target || a.origin !== location.origin || !matchRoute(a.pathname)) return;
    e.preventDefault();
    navigate(a.pathname + a.search);
  });
}
