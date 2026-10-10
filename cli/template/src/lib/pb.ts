import PocketBase from 'pocketbase';
import { readConfig, makeCol, type CubbyConfig } from './cubby-config.js';

declare global {
  interface Window {
    __CUBBY__?: CubbyConfig;
  }
}

const cubby = readConfig(window);

/** PocketBase client for this app's backend. */
export const pb = new PocketBase(cubby.pbUrl);

/**
 * Every collection lives under this project's prefix in the shared backend.
 * Always go through `col()`:  pb.collection(col('tasks')).getList()
 */
export const col = makeCol(cubby.prefix);
