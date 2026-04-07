import { spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";

/**
 * Remove all briefed artifacts from a repo while preserving everything else
 * in .claude/settings.json — specifically, the Serena MCP registration and
 * any other user-configured hooks/servers. This is what makes the "serena
 * only" arm of the bench a clean baseline.
 */
export function stripBriefedPreservingMcp(root: string) {
  // 1. Strip briefed block from CLAUDE.md
  const claudeMd = join(root, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    const content = readFileSync(claudeMd, "utf-8");
    if (content.includes("<!-- briefed:start -->")) {
      const stripped = content
        .replace(/<!-- briefed:start -->[\s\S]*?<!-- briefed:end -->\n?/, "")
        .trim();
      writeFileSync(claudeMd, stripped + (stripped ? "\n" : ""));
    }
  }

  // 2. Remove briefed rule files
  const rulesDir = join(root, ".claude", "rules");
  if (existsSync(rulesDir)) {
    for (const f of readdirSync(rulesDir).filter((f) => f.startsWith("briefed-"))) {
      try { rmSync(join(rulesDir, f)); } catch { /* ignore */ }
    }
  }

  // 3. Remove briefed MCP + briefed hooks from settings.json, leaving
  //    everything else (Serena, user-defined hooks, other servers) intact.
  const settingsPath = join(root, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    return;
  }

  const mcpServers = parsed.mcpServers as Record<string, unknown> | undefined;
  if (mcpServers && "briefed" in mcpServers) {
    delete mcpServers.briefed;
  }

  const hooks = parsed.hooks as Record<string, Array<{ hooks: Array<{ command?: string }> }>> | undefined;
  if (hooks) {
    for (const eventName of Object.keys(hooks)) {
      hooks[eventName] = hooks[eventName].filter(
        (entry) => !entry.hooks.some((h) => (h.command || "").includes("briefed")),
      );
      if (hooks[eventName].length === 0) {
        delete hooks[eventName];
      }
    }
  }

  writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + "\n");
}

/**
 * Check whether an MCP server is visible to Claude Code, regardless of where
 * it's registered (repo settings.json, user ~/.claude.json, or a plugin).
 * Uses `claude mcp list` as the authoritative source.
 */
export function isMcpServerRegistered(claudePath: string, cwd: string, name: string): boolean {
  const isWindows = process.platform === "win32";
  try {
    const r = spawnSync(claudePath, ["mcp", "list"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
      encoding: "utf-8",
      shell: isWindows,
    });
    if (r.status !== 0) return false;
    const haystack = ((r.stdout || "") + (r.stderr || "")).toLowerCase();
    return haystack.includes(name.toLowerCase());
  } catch {
    return false;
  }
}

export function findClaude(): string | null {
  const candidates = [
    "claude",
    "claude.cmd",
    join(process.env.APPDATA || "", "npm", "claude.cmd"),
    join(process.env.APPDATA || "", "npm", "claude"),
  ];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["--version"], { stdio: "pipe", timeout: 5000, encoding: "utf-8", shell: true });
      if (r.status === 0) return c;
    } catch { /* next */ }
  }
  return null;
}

export function runClaudeTask(claudePath: string, cwd: string, prompt: string, outputPath: string, timeoutMs: number) {
  // Important: do NOT use shell:true here. With shell:true, the prompt
  // argument is tokenized by whitespace, so "Read the files..." becomes
  // just "Read". On Windows we need shell:true for .cmd files, so detect.
  const isWindows = process.platform === "win32";
  // stream-json (NDJSON) is required to capture per-turn assistant messages
  // with their tool_use blocks and per-turn usage; the plain "json" format only
  // emits the final result object, which loses tool calls and reports only the
  // last turn's token usage.
  const result = spawnSync(
    claudePath,
    [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "20",
      "--permission-mode",
      "acceptEdits",
    ],
    { cwd, stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, encoding: "utf-8", shell: isWindows }
  );
  if (result.error) throw new Error(`CLI failed: ${result.error.message}`);
  if (result.stdout?.trim()) {
    writeFileSync(outputPath, result.stdout);
  } else {
    throw new Error(result.stderr?.slice(0, 200) || "No output");
  }
}
