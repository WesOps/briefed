/**
 * Helpers for toggling Claude Code plugins between bench arms, so the
 * briefed/serena/briefed+serena comparison produces cleanly-isolated results
 * instead of measuring "whatever the user happened to have installed globally."
 *
 * Uses the official `claude plugin enable|disable <name> --scope user` CLI —
 * per the Claude Code docs, this is the supported mechanism for per-run
 * plugin toggling. It's idempotent and reversible.
 *
 * Invariant every adapter's afterArm must maintain:
 *   after the hook returns, BOTH `briefed` and `serena` are enabled at user
 *   scope. Subsequent arms' beforeArm will set them to their arm-specific
 *   state. Post-bench, the user's pre-bench environment is restored.
 *
 * This assumes both plugins are already installed at user scope before the
 * bench begins. If one isn't installed, the enable/disable calls will fail;
 * that failure is surfaced as a beforeArm throw which aborts the arm with a
 * recorded error, rather than silently running with wrong plugin state.
 */

import { spawnSync } from "child_process";

type Action = "enable" | "disable";

function runPluginAction(action: Action, pluginName: string): void {
  const result = spawnSync(
    "claude",
    ["plugin", action, pluginName, "--scope", "user"],
    {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 15_000,
      shell: process.platform === "win32",
    },
  );
  if (result.error) {
    throw new Error(
      `claude plugin ${action} ${pluginName}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim().slice(0, 300);
    const stdout = (result.stdout || "").trim().slice(0, 300);
    throw new Error(
      `claude plugin ${action} ${pluginName} exited ${result.status}: ${stderr || stdout || "(no output)"}`,
    );
  }
}

export function enablePlugin(name: string): void {
  runPluginAction("enable", name);
}

export function disablePlugin(name: string): void {
  runPluginAction("disable", name);
}

/**
 * Restore both plugins to enabled. Called from every adapter's afterArm so
 * the pre-bench user state is preserved regardless of which arms actually
 * ran or how they exited.
 */
export function restoreBothEnabled(): void {
  enablePlugin("briefed");
  enablePlugin("serena");
}
