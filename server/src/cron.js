// Five-field cron schedules ("minute hour day-of-month month day-of-week"), always in UTC. Pure, unit-tested.
// Supports *, numbers, ranges (1-5), lists (1,3,5) and steps (*/15, 0-30/10). Day-of-week 0 and 7 are Sunday.
// Like Vixie cron, when both day fields are restricted a day matches if either one does.

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

function parseField(text, { name, min, max }) {
  const values = new Set();
  for (const part of text.split(',')) {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`invalid ${name} "${part}"`);
    const step = m[4] === undefined ? 1 : Number(m[4]);
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      lo = Number(m[2]);
      hi = m[3] === undefined ? (m[4] === undefined ? lo : max) : Number(m[3]);
    }
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`invalid ${name} "${part}" (allowed ${min}-${max})`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

export function parseCron(expr) {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('schedule needs 5 fields: minute hour day-of-month month day-of-week');
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.delete(7)) dow.add(0);
  return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

export function isValidCron(expr) {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

function dayMatches(c, date) {
  const dom = c.dom.has(date.getUTCDate());
  const dow = c.dow.has(date.getUTCDay());
  if (c.domAny || c.dowAny) return (c.domAny || dom) && (c.dowAny || dow);
  return dom || dow;
}

export const cronMatches = (c, date) =>
  c.minute.has(date.getUTCMinutes()) && c.hour.has(date.getUTCHours()) && c.month.has(date.getUTCMonth() + 1) && dayMatches(c, date);

// The first matching minute strictly after `from`, or null if none within about four years (e.g. "0 0 30 2 *").
export function nextRun(c, from) {
  const t = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  const limit = t.getTime() + 4 * 366 * 86_400_000;
  while (t.getTime() < limit) {
    if (!c.month.has(t.getUTCMonth() + 1) || !dayMatches(c, t)) {
      t.setUTCHours(24, 0, 0, 0);
    } else if (!c.hour.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
    } else if (!c.minute.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
    } else {
      return t;
    }
  }
  return null;
}
