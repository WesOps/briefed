/**
 * codesight adapter — runs `npx -y codesight --init` in the task's cloned
 * repo. codesight writes its own CLAUDE.md breadcrumb plus a richer
 * `.codesight/CODESIGHT.md` dump that the model can read on demand.
 *
 * We use `npx -y` so the bench doesn't need codesight globally installed —
 * npx fetches it from npm per invocation and caches it in `~/.npm/_npx`.
 * First run per machine is ~5-10s slower; subsequent runs hit the cache.
 */

import { spawnSync } from "child_process";
import type { PolyAdapter } from "../types.js";
import { writeProjectPluginConfig } from "./plugins.js";

export const codesightAdapter: PolyAdapter = {
  name: "codesight",
  async setup(repoPath: string): Promise<void> {
    const result = spawnSync(
      "npx",
      ["-y", "codesight", "--init"],
      {
        cwd: repoPath,
        stdio: "inherit",
        timeout: 300_000,
      },
    );
    if (result.error) {
      throw new Error(`codesight --init failed to spawn: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`codesight --init exited with status ${result.status ?? "unknown"}`);
    }

    // Disable briefed and serena plugins so neither contaminates codesight's arm.
    writeProjectPluginConfig(repoPath, { briefed: false, serena: false });
  },
};
