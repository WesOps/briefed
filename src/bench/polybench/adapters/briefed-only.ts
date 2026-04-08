/**
 * briefed-only arm: only the briefed plugin is active (serena disabled via
 * project-scope settings), and `briefed init --deep --skip-hooks` runs in
 * each cloned repo to generate static artifacts.
 *
 * This isolates briefed's contribution from any ambient Serena MCP tool
 * assistance. The comparison target is serena-only and briefed-and-serena.
 */

import { spawnSync } from "child_process";
import type { PolyAdapter, AdapterOptions } from "../types.js";
import { writeProjectPluginConfig } from "./plugins.js";

export const briefedOnlyAdapter: PolyAdapter = {
  name: "briefed-only",
  async setup(repoPath: string, opts: AdapterOptions): Promise<void> {
    // Run briefed init first so it creates its own .claude/ entries, then
    // overwrite .claude/settings.json with our plugin state. briefed init
    // with --skip-hooks does not touch settings.json, but this order is
    // robust either way.
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

    writeProjectPluginConfig(repoPath, { briefed: true, serena: false });
  },
};
