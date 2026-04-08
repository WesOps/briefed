/**
 * serena-only arm: only the serena plugin is active (briefed disabled via
 * project-scope settings), no `briefed init` — the repo stays pristine so
 * the model only has Serena's LSP-backed MCP tools to work with.
 *
 * This is the comparison target for briefed-only and briefed-and-serena.
 */

import type { PolyAdapter } from "../types.js";
import { writeProjectPluginConfig } from "./plugins.js";

export const serenaOnlyAdapter: PolyAdapter = {
  name: "serena-only",
  async setup(repoPath: string): Promise<void> {
    // Pure plugin-state setup. No briefed init, no other repo mutations —
    // Serena's MCP tools act on the repo through runtime tool calls.
    writeProjectPluginConfig(repoPath, { briefed: false, serena: true });
  },
};
