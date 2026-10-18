// Who is signed in, what the server is called, and the API client. One shared state object for every view.
import { apiErrorMessage, isHttps } from './helpers.js';

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content ?? '';
export const SERVER = meta('cubby-server');
export const VERSION = meta('cubby-version');

export const state = {
  token: null,
  me: null,
  info: { name: 'Cubby', open_signup: false, https: isHttps(SERVER) },
};
function storedToken() {
  try { return localStorage.getItem('cubby_token'); } catch { return null; }
}
state.token = storedToken();

// main.js registers how to redraw the current page; views call rerender() after changing something.
let redraw = () => {};
export const setRenderer = (fn) => { redraw = fn; };
export const rerender = () => redraw();

export function setToken(t) {
  state.token = t;
  try { t ? localStorage.setItem('cubby_token', t) : localStorage.removeItem('cubby_token'); } catch {}
}

export function logout() {
  setToken(null);
  state.me = null;
  rerender();
}

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { ...(state.token && { authorization: `Bearer ${state.token}` }), ...(body && { 'content-type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) {
    // Tabs share one stored token. If another tab stored a newer one (it signed in again or regenerated), this tab's
    // token is just stale: switch to the stored one rather than deleting it, which would sign out every tab.
    const stored = storedToken();
    if (stored && stored !== state.token) {
      state.token = stored;
      await loadMe();
      rerender();
      throw new Error('Signed in again in another tab. Try that again.');
    }
    logout();
    throw new Error('Session expired');
  }
  if (!res.ok) throw new Error(apiErrorMessage(res.status, data));
  return data;
}

/** Fetches the signed-in user (null if the token is missing or no longer valid). */
export async function loadMe() {
  try { state.me = state.token ? await api('GET', '/api/me') : null; } catch { state.me = null; }
  return state.me;
}
