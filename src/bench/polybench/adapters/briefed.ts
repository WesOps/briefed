/**
 * briefed adapter — runs `briefed init --deep --skip-hooks` in the task's
 * cloned repo so the model gets briefed's static skeleton + deep-annotated
 * rules before the claude -p invocation.
 *
 * `--skip-hooks` deliberately: the bench is testing the tool's PRE-LOADED
 * context value, not the Claude Code hook layer. If a user installs
 * briefed as a plugin, they get the hooks automatically; the bench
 * measures the static artifact layer so cross-arm comparisons stay apples-
 * to-apples (codesight, repowise, etc. don't install hooks either).
 */

import { spawnSync } from "child_process";
import type { PolyAdapter, AdapterOptions } from "../types.js";

export const briefedAdapter: PolyAdapter = {
  name: "briefed",
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
