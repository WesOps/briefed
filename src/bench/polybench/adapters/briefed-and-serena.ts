/**
 * briefed-and-serena arm: BOTH plugins enabled, and `briefed init --deep
 * --skip-hooks` runs in each cloned repo. This is the "full stack" condition
 * — what a power user running both tools would experience.
 *
 * The bench headline delta we care about is:
 *   briefed-and-serena  vs  serena-only
 * which answers "does briefed add value on top of a Serena-equipped
 * environment." That's the real market claim for v1.1.
 */

import { spawnSync } from "child_process";
import type { PolyAdapter, AdapterOptions } from "../types.js";
import { enablePlugin, restoreBothEnabled } from "./plugins.js";

export const briefedAndSerenaAdapter: PolyAdapter = {
  name: "briefed-and-serena",
  async beforeArm(): Promise<void> {
    enablePlugin("briefed");
    enablePlugin("serena");
  },
  async afterArm(): Promise<void> {
    restoreBothEnabled();
  },
  async setup(repoPath: string, opts: AdapterOptions): Promise<void> {
    const result = spawnSync(
      "node",
      [opts.briefedCliPath, "init", "--deep", "--skip-hooks"],
      {
        cwd: repoPath,
        stdio: "inherit",
        timeout: opts.timeoutMs,
      },
    );
    if (result.error) {
      throw new Error(`briefed init failed to spawn: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`briefed init exited with status ${result.status ?? "unknown"}`);
    }
  },
};
