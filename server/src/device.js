// Browser-approved CLI login (like `gh auth login`): the CLI gets a short code and a link,
// the person approves it on the dashboard, and the CLI picks up a new key of its own: an agent.
import { randomBytes, randomInt } from 'node:crypto';
import { HttpError } from './http.js';
import { issueAgentToken } from './auth.js';
import { agentName } from './logic.js';

const TTL_MS = 10 * 60 * 1000;
const pending = new Map(); // deviceId -> { userCode, expires, userId, hint }
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const USER_CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const userCode = () => Array.from({ length: 8 }, (_, i) => (i === 4 ? '-' : '') + ALPHABET[randomInt(ALPHABET.length)]).join('');

setInterval(() => {
  const now = Date.now();
  for (const [id, d] of pending) if (d.expires < now) pending.delete(id);
}, 60_000).unref();

// `now` and `issueToken` are injectable for tests. `hint` is what the CLI says about itself (logic.agentHint).
export function startDevice(publicUrl, now = Date.now(), hint = {}) {
  const deviceId = randomBytes(24).toString('base64url');
  const code = userCode();
  pending.set(deviceId, { userCode: code, expires: now + TTL_MS, userId: null, hint });
  return { device_id: deviceId, user_code: code, verify_url: `${publicUrl}/connect?code=${code}`, expires_in: TTL_MS / 1000, interval: 2 };
}

const findByCode = (code, now) => [...pending.values()].find((d) => d.userCode === String(code).trim().toUpperCase() && d.expires > now);

// Whether a code is live and, for a signed-in `user` (the approval page), which agent is asking: null for CLIs
// from before agents, which send no hint. Anonymous callers never see the agent, since it names a machine.
export function deviceInfo(code, now = Date.now(), user = null) {
  const d = findByCode(code, now);
  if (!d) throw new HttpError(404, 'This login link has expired or was already used. Ask your agent to run `cubby login` again.');
  if (!user) return { ok: true };
  const { tool, machine } = d.hint;
  return { ok: true, agent: tool || machine ? { name: agentName(d.hint), tool: tool || null, machine: machine || null } : null };
}

export function approveDevice(user, code, now = Date.now()) {
  const d = findByCode(code, now);
  if (!d) throw new HttpError(404, 'This login link has expired or was already used. Ask your agent to run `cubby login` again.');
  d.userId = user.id;
  return { ok: true };
}

export async function pollDevice(deviceId, { now = Date.now(), issueToken = issueAgentToken } = {}) {
  const d = pending.get(deviceId);
  if (!d || d.expires < now) throw new HttpError(410, 'Login request expired. Run `cubby login` again.');
  if (!d.userId) return { status: 'pending' };
  pending.delete(deviceId);
  return { status: 'approved', token: await issueToken(d.userId, d.hint) };
}
