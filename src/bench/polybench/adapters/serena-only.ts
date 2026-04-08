/**
 * serena-only arm: Serena plugin enabled, briefed plugin DISABLED, NO
 * `briefed init` run — the cloned repo stays pristine so the model only has
 * Serena's LSP-backed MCP tools to work with.
 *
 * This is the comparison target for briefed-only and briefed-and-serena.
 */

import type { PolyAdapter } from "../types.js";
import { disablePlugin, enablePlugin, restoreBothEnabled } from "./plugins.js";

export const serenaOnlyAdapter: PolyAdapter = {
  name: "serena-only",
  async beforeArm(): Promise<void> {
    disablePlugin("briefed");
    enablePlugin("serena");
  },
  async afterArm(): Promise<void> {
    restoreBothEnabled();
  },
  async setup(_repoPath: string): Promise<void> {
    // No-op: Serena-only means the repo is untouched. Serena's MCP tools
    // act on the repo through the model's on-demand tool calls at runtime.
  },
};
