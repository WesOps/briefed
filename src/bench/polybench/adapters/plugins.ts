/**
 * Per-cell plugin isolation via project-scope `.claude/settings.json`.
 *
 * Each bench arm writes a `.claude/settings.json` into the cloned repo
 * with an explicit `enabledPlugins` block that disables EVERY user-scope
 * plugin except the ones the arm explicitly wants. This is a confounding-
 * variable fix: before this, plugins like superpowers, context7, playwright,
 * etc. would leak into every bench cell at whatever user-scope state they
 * were at, making baseline vs briefed comparisons noisy.
 *
 * Project-scope `enabledPlugins` overrides user-scope state, so writing
 * `false` for a plugin disables it cleanly for this cell without mutating
 * the user's `~/.claude/settings.json`.
 *
 * Settings get wiped with the clone dir after each cell, so there's no
 * teardown step.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";

/** Plugin ID strings as they appear in `claude plugin list` output. */
export const BRIEFED_PLUGIN_ID = "briefed@briefed";
export const SERENA_PLUGIN_ID = "serena@claude-plugins-official";

export interface PluginState {
  briefed: boolean;
  serena: boolean;
}

/**
 * Enumerate every plugin installed at user scope so we can disable them
 * all explicitly in bench cells. Cached after first call per process.
 */
let cachedInstalledPlugins: string[] | null = null;
function listInstalledPlugins(): string[] {
  if (cachedInstalledPlugins !== null) return cachedInstalledPlugins;
  try {
    const result = spawnSync("claude", ["plugin", "list"], {
      encoding: "utf-8",
      timeout: 10_000,
      shell: false,
    });
    if (result.status !== 0 || !result.stdout) {
      cachedInstalledPlugins = [];
      return cachedInstalledPlugins;
    }
    const ids: string[] = [];
    for (const line of result.stdout.split("\n")) {
      const match = line.match(/^\s*❯\s+(\S+)/);
      if (match) ids.push(match[1]);
    }
    cachedInstalledPlugins = ids;
    return ids;
  } catch {
    cachedInstalledPlugins = [];
    return [];
  }
}

/**
 * Write a project-scope `.claude/settings.json` into `repoPath` that
 * disables every installed user-scope plugin and then selectively enables
 * only the ones this arm wants (briefed, serena).
 *
 * Preserves any existing non-enabledPlugins settings content (e.g. hooks
 * installed by `briefed init`). Only the `enabledPlugins` key is rewritten.
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
      existing = {};
    }
  }

  // Start by disabling every installed plugin
  const enabled: Record<string, boolean> = {};
  for (const pluginId of listInstalledPlugins()) {
    enabled[pluginId] = false;
  }

  // Make sure briefed/serena appear in the map even if not returned by
  // `claude plugin list` (defensive — their state is what the bench toggles).
  enabled[BRIEFED_PLUGIN_ID] = state.briefed;
  enabled[SERENA_PLUGIN_ID] = state.serena;

  existing.enabledPlugins = enabled;

  writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + "\n");
}
