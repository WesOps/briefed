/**
 * Per-cell plugin isolation via project-scope `.claude/settings.json`.
 *
 * Each bench arm writes a `.claude/settings.json` into the cloned repo
 * with an explicit `enabledPlugins` block. Project-scope `enabledPlugins`
 * **overrides** user-scope state, so this lets us toggle briefed/serena per
 * cell without mutating the user's `~/.claude/settings.json` at all.
 *
 * Verified empirically — running `claude mcp list` from a repo with
 *
 *   { "enabledPlugins": { "briefed@briefed": false,
 *                         "serena@claude-plugins-official": true } }
 *
 * shows only `plugin:serena:serena` in the active plugin list; `briefed` is
 * cleanly filtered out even though it's still enabled at user scope. The
 * reverse and both-enabled cases work identically.
 *
 * Why not `claude plugin enable|disable --scope user`?
 *   - Mutates user's global state; mid-run crash leaves them with disabled
 *     plugins they didn't intend
 *   - Not cleanly idempotent (enable-already-enabled errors)
 *   - Each toggle is a subprocess call
 *   - Can't run two bench arms in parallel without racing on global config
 *
 * This approach has none of those problems. Settings get wiped with the
 * clone dir after each cell, so there's no teardown step at all.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

/** Plugin ID strings as they appear in `claude plugin list` output. */
export const BRIEFED_PLUGIN_ID = "briefed@briefed";
export const SERENA_PLUGIN_ID = "serena@claude-plugins-official";

export interface PluginState {
  briefed: boolean;
  serena: boolean;
}

/**
 * Write a project-scope `.claude/settings.json` into `repoPath` that
 * explicitly enables/disables briefed and serena. Preserves any existing
 * settings content (e.g. from `briefed init`'s hook installation) — only
 * the `enabledPlugins` key is overwritten.
 */
export function writeProjectPluginConfig(repoPath: string, state: PluginState): void {
  const claudeDir = join(repoPath, ".claude");
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }
  const settingsPath = join(claudeDir, "settings.json");

  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      // corrupt or non-JSON — overwrite with our own
      existing = {};
    }
  }

  existing.enabledPlugins = {
    [BRIEFED_PLUGIN_ID]: state.briefed,
    [SERENA_PLUGIN_ID]: state.serena,
  };

  writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + "\n");
}
