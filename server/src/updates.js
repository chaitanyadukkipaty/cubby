// "Update available" notice for admins. At most once a day the server asks GitHub for the latest Cubby release;
// this is the only outbound request a server makes. Everything that does I/O comes in through arguments so the
// logic is unit-tested without network.
import { isUpdateAvailable } from './version.js';

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// GitHub's "latest release" API → { tag, url } (null when there's no release yet).
export async function fetchLatestRelease(url, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const res = await fetchImpl(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'cubby-update-check' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`release check failed: HTTP ${res.status}`);
  const data = await res.json();
  if (typeof data?.tag_name !== 'string') throw new Error('release check failed: unexpected response');
  return { tag: data.tag_name, url: typeof data.html_url === 'string' ? data.html_url : null };
}

export function createUpdateChecker({ current, fetchLatest, now = Date.now, interval = CHECK_INTERVAL_MS }) {
  let state = { latest: null, url: null, checkedAt: null, error: null };
  let inflight = null;

  async function check({ force = false } = {}) {
    if (!force && state.checkedAt && now() - state.checkedAt < interval) return status();
    inflight ??= (async () => {
      try {
        const release = await fetchLatest();
        state = { latest: release?.tag ?? null, url: release?.url ?? null, checkedAt: now(), error: null };
      } catch (err) {
        // Keep the last good answer; try again on the next tick.
        state = { ...state, checkedAt: now(), error: err.message };
      } finally {
        inflight = null;
      }
    })();
    await inflight;
    return status();
  }

  function status() {
    return {
      current,
      latest: state.latest,
      update_available: isUpdateAvailable(current, state.latest),
      release_url: state.url,
      checked_at: state.checkedAt ? new Date(state.checkedAt).toISOString() : null,
      error: state.error,
    };
  }

  return { check, status };
}

// What /api/admin/overview reports, given the env switch and the admin setting.
export function updateView({ envEnabled, settingEnabled, checker }) {
  if (!envEnabled) return { enabled: false, reason: 'env', current: checker.status().current };
  if (!settingEnabled) return { enabled: false, reason: 'setting', current: checker.status().current };
  return { enabled: true, ...checker.status() };
}

// Runs a check now and then once a day while enabled. Errors never escape.
export function scheduleUpdateChecks({ checker, isEnabled, interval = CHECK_INTERVAL_MS, setIntervalImpl = setInterval }) {
  const tick = async () => {
    try {
      if (await isEnabled()) await checker.check();
    } catch {}
  };
  tick();
  const timer = setIntervalImpl(tick, interval);
  timer?.unref?.();
  return { tick, timer };
}
