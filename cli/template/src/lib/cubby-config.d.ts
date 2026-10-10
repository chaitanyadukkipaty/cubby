export interface CubbyConfig {
  project: string;
  prefix: string;
  pbUrl: string;
}

export function readConfig(win: { __CUBBY__?: CubbyConfig } | undefined): CubbyConfig;
export function makeCol(prefix: string): (name: string) => string;
