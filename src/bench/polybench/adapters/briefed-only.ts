/**
 * briefed-only arm: only the briefed plugin is active (serena disabled via
 * project-scope settings), and `briefed init --deep` runs in each cloned
 * repo to generate static artifacts + adaptive hooks.
 *
 * This isolates briefed's contribution from any ambient Serena MCP tool
 * assistance. The comparison target is serena-only and briefed-and-serena.
 */

import { spawn } from "child_process";
import { existsSync, copyFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { PolyAdapter, AdapterOptions } from "../types.js";
import { writeProjectPluginConfig } from "./plugins.js";

export const briefedOnlyAdapter: PolyAdapter = {
  name: "briefed-only",
  async setup(repoPath: string, opts: AdapterOptions): Promise<void> {
    const briefedDir = join(repoPath, ".briefed");

    // Restore persisted deep cache so briefed init --deep skips already-annotated
    // files. The cache is keyed by content hash so it stays valid across clones of
    // the same commit. First run pays full annotation cost; every re-run is free.
    if (opts.deepCachePath && existsSync(opts.deepCachePath)) {
      mkdirSync(briefedDir, { recursive: true });
      copyFileSync(opts.deepCachePath, join(briefedDir, "deep-cache.json"));
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "node",
        [opts.briefedCliPath, "init", "--deep"],
        {
          cwd: repoPath,
          stdio: "inherit",
        },
      );
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`briefed init timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`briefed init failed to spawn: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`briefed init exited with status ${code ?? "unknown"}`));
        } else {
          resolve();
        }
      });
    });

    // Harvest updated cache back to persistent location for next run
    if (opts.deepCachePath) {
      const freshCache = join(briefedDir, "deep-cache.json");
      if (existsSync(freshCache)) {
        mkdirSync(dirname(opts.deepCachePath), { recursive: true });
        copyFileSync(freshCache, opts.deepCachePath);
      }
    }

    writeProjectPluginConfig(repoPath, { briefed: true, serena: false });
  },
};
