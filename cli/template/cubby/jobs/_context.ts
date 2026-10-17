// What every job receives. Files in cubby/jobs/ starting with _ are shared helpers, not jobs.
import type PocketBase from 'pocketbase';

export interface JobContext {
  /** This app's data, with admin rights (API rules don't apply). Use unprefixed names: pb.collection('tasks'). */
  pb: PocketBase;
  /** The real (prefixed) collection name, for @collection.<name> in filters. */
  col: (name: string) => string;
  /** Secrets set with `cubby env set NAME=value`. */
  env: Readonly<Record<string, string>>;
  /** Shown by `cubby jobs run` and `cubby jobs logs`. */
  log: (...args: unknown[]) => void;
  /** fetch() to the public internet. */
  fetch: typeof fetch;
}
