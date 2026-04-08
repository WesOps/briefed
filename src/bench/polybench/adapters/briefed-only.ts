/**
 * briefed-only arm: briefed plugin enabled, Serena plugin DISABLED, and
 * `briefed init --deep --skip-hooks` runs in each cloned repo.
 *
 * This isolates briefed's contribution from any ambient Serena MCP tool
 * assistance. The comparison target is serena-only and briefed-and-serena.
 */

import { spawnSync } from "child_process";
import type { PolyAdapter, AdapterOptions } from "../types.js";
import { disablePlugin, enablePlugin, restoreBothEnabled } from "./plugins.js";

export const briefedOnlyAdapter: PolyAdapter = {
  name: "briefed-only",
  async beforeArm(): Promise<void> {
    enablePlugin("briefed");
    disablePlugin("serena");
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
