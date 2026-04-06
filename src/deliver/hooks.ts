import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "fs";
import { join } from "path";
import { debug } from "../utils/log.js";

interface McpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ClaudeSettings {
  hooks?: Record<string, Array<{
    matcher?: string;
    hooks: Array<{
      type: string;
      command: string;
      timeout?: number;
    }>;
  }>>;
  mcpServers?: Record<string, McpServer>;
  [key: string]: unknown;
}

/**
 * Register the briefed MCP server in .claude/settings.json without touching
 * event hooks. The MCP server is the always-on, low-cost integration: it
 * exposes briefed's lookup tools (find_usages, blast_radius, schema, routes,
 * symbol) so Claude can call them directly. We register it independently of
 * event hooks so that `briefed init --skip-hooks` (a common choice for users
 * who don't want SessionStart/PostToolUse plumbing) still gets MCP.
 */
export function installMcpServer(root: string) {
  const claudeDir = join(root, ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch (e) {
      debug(`failed to parse settings.json, starting fresh: ${(e as Error).message}`);
      settings = {};
    }
  }

  if (!settings.mcpServers) settings.mcpServers = {};
  const isBriefedRepo = (() => {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
      return pkg.name === "briefed" && existsSync(join(root, "dist", "cli.js"));
    } catch {
      return false;
    }
  })();

  // Resolve absolute paths for the MCP server command. macOS GUI Claude Code
  // launches with a minimal PATH that excludes asdf/nvm/volta/fnm shim
  // directories, so a bare `"command": "briefed"` works in the terminal but
  // fails when Claude tries to spawn the MCP server. By writing absolute
  // paths to node + cli.js we bypass version-manager shims entirely.
  if (isBriefedRepo) {
    settings.mcpServers["briefed"] = {
      command: process.execPath, // absolute path to the running node binary
      args: [join(root, "dist", "cli.js"), "mcp", "--repo", root],
    };
  } else {
    // We're being run by an installed briefed CLI. import.meta.dirname is
    // dist/deliver/ inside the install — walk up to find dist/cli.js and
    // resolve it to a real absolute path that Claude Code can spawn without
    // any PATH lookups or shim resolution.
    let cliJsPath: string | null = null;
    try {
      const candidate = join(import.meta.dirname, "..", "cli.js");
      if (existsSync(candidate)) {
        cliJsPath = realpathSync(candidate);
      }
    } catch {
      cliJsPath = null;
    }

    if (cliJsPath) {
      settings.mcpServers["briefed"] = {
        command: process.execPath,
        args: [cliJsPath, "mcp", "--repo", root],
      };
    } else {
      // Last-resort fallback: bare command. Better than nothing, but users
      // on version managers launching Claude Code from the GUI will hit PATH
      // issues and need to fix this manually.
      settings.mcpServers["briefed"] = {
        command: "briefed",
        args: ["mcp", "--repo", root],
      };
    }
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

/**
 * Install briefed hooks into .claude/settings.json.
 * Adds SessionStart (compact) and UserPromptSubmit hooks.
 */
export function installHooks(root: string) {
  const claudeDir = join(root, ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  // Ensure .claude directory exists
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  // Load existing settings or create new
  // Security: backup existing settings before modifying
  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, "utf-8");
      settings = JSON.parse(raw);
      // Backup before modifying
      writeFileSync(settingsPath + ".briefed-backup", raw);
    } catch (e) {
      debug(`failed to parse settings.json, starting fresh: ${(e as Error).message}`);
      settings = {};
    }
  }

  // Initialize hooks object
  if (!settings.hooks) settings.hooks = {};

  // Remove any existing briefed hooks (for idempotency)
  for (const eventName of Object.keys(settings.hooks)) {
    settings.hooks[eventName] = settings.hooks[eventName].filter(
      (entry) => !entry.hooks.some((h) => h.command.includes("briefed"))
    );
    if (settings.hooks[eventName].length === 0) {
      delete settings.hooks[eventName];
    }
  }

  // Add SessionStart hook (compact matcher) — re-inject skeleton after compaction
  if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
  settings.hooks.SessionStart.push({
    matcher: "compact",
    hooks: [
      {
        type: "command",
        command: `"${process.execPath}" "${join(root, ".briefed", "hooks", "session-start.js")}"`,
        timeout: 5,
      },
    ],
  });

  // Add UserPromptSubmit hook — dynamic per-prompt context injection
  if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
  settings.hooks.UserPromptSubmit.push({
    hooks: [
      {
        type: "command",
        command: `"${process.execPath}" "${join(root, ".briefed", "hooks", "prompt-submit.js")}"`,
        timeout: 5,
      },
    ],
  });

  // MCP server registration is handled by installMcpServer() — called
  // unconditionally from writeOutputs so --skip-hooks still gets MCP. We
  // intentionally don't touch settings.mcpServers here to avoid clobbering
  // the absolute-path resolution that installMcpServer does for asdf/nvm/
  // volta/fnm users.

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

/**
 * Generate the hook scripts that get executed by Claude Code.
 */
export function generateHookScripts(root: string) {
  const hooksDir = join(root, ".briefed", "hooks");
  mkdirSync(hooksDir, { recursive: true });

  const sessionStartScript = `#!/usr/bin/env node
// briefed: SessionStart hook — re-inject skeleton after compaction
const { readFileSync, realpathSync } = require("fs");
const { join, resolve } = require("path");

const briefedDir = resolve(join(__dirname, ".."));
const skeletonPath = join(briefedDir, "skeleton.md");

try {
  const realPath = realpathSync(skeletonPath);
  if (realPath.startsWith(realpathSync(briefedDir))) {
    process.stdout.write(readFileSync(realPath, "utf-8"));
  }
} catch {}
`.trim();

  writeFileSync(join(hooksDir, "session-start.js"), sessionStartScript);

  // UserPromptSubmit hook — analyze prompt, inject relevant contracts + dependencies
  const promptSubmitScript = `
#!/usr/bin/env node
// briefed: UserPromptSubmit hook — adaptive context injection
// Security: read-only, never persists prompt data, all file reads scoped to .briefed/
const { readFileSync, existsSync, realpathSync } = require("fs");
const { join, resolve } = require("path");

const briefedDir = resolve(join(__dirname, ".."));
const contractsDir = join(briefedDir, "contracts");
const indexPath = join(briefedDir, "index.json");
const testMapPath = join(briefedDir, "test-map.json");

// Security: verify a path is inside .briefed/ before reading
const realBriefedDir = realpathSync(briefedDir);
function safeRead(filePath) {
  try {
    const real = realpathSync(filePath);
    if (!real.startsWith(realBriefedDir)) return null;
    return readFileSync(real, "utf-8");
  } catch { return null; }
}
function safeExists(filePath) {
  try {
    if (!existsSync(filePath)) return false;
    return realpathSync(filePath).startsWith(realBriefedDir);
  } catch { return false; }
}

// Complexity scoring — determines how much context to inject
function scorePrompt(prompt) {
  let score = 3; // baseline: moderate

  // High complexity signals (+2 each)
  const highSignals = [/refactor/i, /restructur/i, /redesign/i, /migrat/i, /debug/i, /investigate/i, /\\bwhy\\b/i, /architect/i, /\\bsystem\\b/i, /security/i, /vulnerab/i, /performance/i, /optimiz/i];
  for (const s of highSignals) { if (s.test(prompt)) score += 2; }

  // Medium signals (+1 each)
  const medSignals = [/\\badd\\b/i, /implement/i, /create/i, /build/i, /integrat/i, /\\btest/i, /endpoint/i, /feature/i, /module/i, /service/i];
  for (const s of medSignals) { if (s.test(prompt)) score += 1; }

  // Low complexity signals (-2 each)
  const lowSignals = [/typo/i, /rename/i, /comment/i, /\\blog\\b/i, /print/i, /format/i, /lint/i, /spell/i];
  for (const s of lowSignals) { if (s.test(prompt)) score -= 2; }

  // Long prompts = more complex
  if (prompt.length > 200) score += 1;
  if (prompt.length > 500) score += 1;
  if (prompt.length < 30) score -= 1;

  // Multiple file/module mentions = complex
  const fileRefs = (prompt.match(/\\w+\\.\\w{2,4}/g) || []).length;
  if (fileRefs >= 2) score += 2;

  return Math.max(1, Math.min(10, score));
}

let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const prompt = (data.prompt || data.message || "").toLowerCase();

    // Security: truncate FIRST to prevent ReDoS on long inputs
    const safePrompt = (prompt || "").slice(0, 2000);
    if (!safePrompt || !safeExists(indexPath)) {
      process.exit(0);
      return;
    }

    const index = JSON.parse(safeRead(indexPath) || "{}");
    if (!index.modules) { process.exit(0); return; }
    const complexity = scorePrompt(safePrompt);

    // Adaptive budget based on prompt complexity
    const budget = complexity <= 3 ? 1500 : complexity <= 6 ? 5000 : 9000;
    const includeDeps = complexity >= 4;
    const includeTests = complexity >= 7;

    let used = 0;
    const loaded = new Set();
    const output = [];

    // Score each module by keyword hits against the prompt
    const scored = index.modules.map((mod) => {
      const keywords = mod.keywords || [];
      const hits = keywords.filter((k) => safePrompt.includes(k.toLowerCase()));
      return { mod, hits: hits.length, complexity: mod.complexity || 0 };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.complexity - a.complexity);

    // Helper: load related modules (dependencies or dependents) from a contract
    function loadRelated(mod, label, field) {
      const contractText = safeRead(join(contractsDir, mod.file));
      if (!contractText) return;
      const match = contractText.match(new RegExp(field + ":\\\\n([\\\\s\\\\S]*?)(?:\\\\n\\\\w|$)"));
      if (!match) return;
      const items = match[1].match(/- (.+)/g) || [];
      for (const item of items) {
        const name = item.replace("- ", "").trim();
        const relMod = index.modules.find((m) => m.name === name);
        if (relMod && !loaded.has(relMod.file) && used < budget) {
          const contract = safeRead(join(contractsDir, relMod.file));
          if (contract && used + contract.length <= budget) {
            output.push("# " + label + ": " + relMod.dir + "\\n" + contract);
            used += contract.length;
            loaded.add(relMod.file);
          }
        }
      }
    }

    // Load matching modules + their dependencies + dependents
    for (const { mod } of scored) {
      if (used >= budget) break;

      // Load the module's contract
      if (!loaded.has(mod.file)) {
        const contractPath = join(contractsDir, mod.file);
        const contract = safeRead(contractPath);
        if (contract) {
          if (used + contract.length <= budget) {
            output.push("# Module: " + mod.dir + "\\n" + contract);
            used += contract.length;
            loaded.add(mod.file);
          }
        }
      }

      // Load dependency + dependent modules (moderate+ complexity)
      if (includeDeps) {
        loadRelated(mod, "Dependency", "dependencies");
        loadRelated(mod, "Dependent", "dependents");
      }

      // Inject test info for matched modules (complex tasks only)
      if (includeTests && safeExists(testMapPath) && used < budget) {
        try {
          const testMap = JSON.parse(safeRead(testMapPath) || "{}");
          for (const file of mod.files || []) {
            const testInfo = testMap[file];
            if (testInfo && used < budget) {
              const testLine = "# Tests for " + file + ": " + testInfo.test + " (" + testInfo.count + " tests)\\n" +
                (testInfo.names || []).slice(0, 5).map((n) => "  - " + n).join("\\n");
              if (used + testLine.length <= budget) {
                output.push(testLine);
                used += testLine.length;
              }
            }
          }
        } catch {}
      }
    }

    if (output.length > 0) {
      process.stdout.write(output.join("\\n---\\n"));
    }
  } catch {
    // Fail silently
  }
  process.exit(0);
});
`.trim();

  writeFileSync(join(hooksDir, "prompt-submit.js"), promptSubmitScript);
}
