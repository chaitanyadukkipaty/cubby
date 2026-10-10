// Runtime config helpers. Plain JS (typed by cubby-config.d.ts) so tests can import it without a build step.

const MISSING = 'Cubby runtime config missing: keep <script src="/__cubby/config.js"> in index.html';

/** Returns the config injected by /__cubby/config.js, or throws a clear error if it's absent or malformed. */
export function readConfig(win) {
  const cfg = win && win.__CUBBY__;
  if (!cfg || typeof cfg.prefix !== 'string' || !cfg.prefix || typeof cfg.pbUrl !== 'string' || !cfg.pbUrl) {
    throw new Error(MISSING);
  }
  return cfg;
}

/** Builds col(): maps a collection name from cubby/schema.json to its real, prefixed name. */
export function makeCol(prefix) {
  return (name) => {
    if (typeof name !== 'string' || !name) throw new TypeError('col() needs a collection name, e.g. col("tasks")');
    return name.startsWith(prefix) ? name : `${prefix}${name}`;
  };
}
