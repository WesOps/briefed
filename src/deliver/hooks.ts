import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { debug } from "../utils/log.js";

interface ClaudeSettings {
  hooks?: Record<string, Array<{
    matcher?: string;
    hooks: Array<{
      type: string;
      command: string;
      timeout?: number;
    }>;
  }>>;
  [key: string]: unknown;
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
        command: `node "${join(root, ".briefed", "hooks", "session-start.js")}"`,
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
        command: `node "${join(root, ".briefed", "hooks", "prompt-submit.js")}"`,
        timeout: 5,
      },
    ],
  });

  // Add PostToolUse hooks — learning loop (tracks file reads and edits)
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
  settings.hooks.PostToolUse.push({
    matcher: "Read",
    hooks: [
      {
        type: "command",
        command: `node "${join(root, ".briefed", "hooks", "post-read.js")}"`,
        timeout: 2,
      },
    ],
  });
  settings.hooks.PostToolUse.push({
    matcher: "Edit",
    hooks: [
      {
        type: "command",
        command: `node "${join(root, ".briefed", "hooks", "post-edit.js")}"`,
        timeout: 2,
      },
    ],
  });
  settings.hooks.PostToolUse.push({
    matcher: "Write",
    hooks: [
      {
        type: "command",
        command: `node "${join(root, ".briefed", "hooks", "post-edit.js")}"`,
        timeout: 2,
      },
    ],
  });

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

/**
 * Generate the hook scripts that get executed by Claude Code.
 */
export function generateHookScripts(root: string) {
  const hooksDir = join(root, ".briefed", "hooks");
  mkdirSync(hooksDir, { recursive: true });

  // SessionStart hook — re-inject skeleton after compaction + auto-reindex if stale
  const sessionStartScript = `#!/usr/bin/env node
// briefed: SessionStart hook — re-inject skeleton + auto-reindex if stale
// Security: only reads from .briefed/ directory, spawns briefed init in background
const { readFileSync, realpathSync, existsSync, statSync, writeFileSync } = require("fs");
const { join, resolve } = require("path");
const { spawn } = require("child_process");

const briefedDir = resolve(join(__dirname, ".."));
const root = resolve(join(briefedDir, ".."));
const skeletonPath = join(briefedDir, "skeleton.md");

// 1. Output skeleton (existing behavior)
try {
  const realPath = realpathSync(skeletonPath);
  if (realPath.startsWith(realpathSync(briefedDir))) {
    process.stdout.write(readFileSync(realPath, "utf-8"));
  }
} catch {}

// 2. Staleness check — spawn background reindex if needed
try {
  const indexPath = join(briefedDir, "index.json");
  if (!existsSync(indexPath)) process.exit(0);

  const indexMtime = statSync(indexPath).mtime;
  const { execSync } = require("child_process");
  const changed = execSync(
    'git status --porcelain -- "*.ts" "*.tsx" "*.js" "*.jsx" "*.py" "*.go" "*.rs" "*.java"',
    { cwd: root, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }
  ).trim();

  const changedFiles = changed ? changed.split("\\n").filter(Boolean) : [];
  let staleCount = 0;
  for (const line of changedFiles) {
    const file = line.trim().slice(3);
    const fullPath = join(root, file);
    try { if (existsSync(fullPath) && statSync(fullPath).mtime > indexMtime) staleCount++; }
    catch {}
  }

  const index = JSON.parse(readFileSync(indexPath, "utf-8"));
  const totalFiles = (index.modules || []).reduce((sum, m) => sum + (m.files || []).length, 0);
  const stalePct = totalFiles > 0 ? (staleCount / totalFiles) * 100 : 0;

  if (stalePct > 10 || staleCount > 5) {
    // Prevent concurrent reindex runs
    const lockPath = join(briefedDir, ".reindex-lock");
    if (existsSync(lockPath)) {
      try {
        if (Date.now() - statSync(lockPath).mtime.getTime() < 300000) process.exit(0);
      } catch {}
    }
    writeFileSync(lockPath, Date.now().toString());
    const child = spawn("npx", ["briefed", "init", "--repo", root], {
      cwd: root, detached: true, stdio: "ignore",
    });
    child.unref();
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
const historyPath = join(briefedDir, "history.json");

// Security: verify a path is inside .briefed/ before reading
function safeRead(filePath) {
  try {
    const real = realpathSync(filePath);
    if (!real.startsWith(realpathSync(briefedDir))) return null;
    return readFileSync(real, "utf-8");
  } catch { return null; }
}
function safeExists(filePath) {
  try {
    if (!existsSync(filePath)) return false;
    return realpathSync(filePath).startsWith(realpathSync(briefedDir));
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

    // Learning loop: process session reads + edits into relevance scores
    const learningPath = join(briefedDir, "learning.json");
    const readsLogPath = join(briefedDir, "session-reads.log");
    const editsLogPath = join(briefedDir, "session-edits.log");
    let learning = { moduleRelevance: {} };
    try { learning = JSON.parse(safeRead(learningPath) || "{}"); } catch {}
    if (!learning.moduleRelevance) learning.moduleRelevance = {};

    // Process file reads (weight: 1) and edits (weight: 3) into learning scores
    function processLog(logPath, weight) {
      try {
        if (!existsSync(logPath)) return;
        const entries = readFileSync(logPath, "utf-8").trim().split("\\n").filter(Boolean);
        if (entries.length === 0) return;
        for (const filePath of entries) {
          for (const mod of index.modules) {
            if ((mod.files || []).some((f) => filePath.includes(f))) {
              for (const kw of (mod.keywords || []).slice(0, 5)) {
                if (!learning.moduleRelevance[kw]) learning.moduleRelevance[kw] = {};
                learning.moduleRelevance[kw][mod.name] = (learning.moduleRelevance[kw][mod.name] || 0) + weight;
              }
            }
          }
        }
        require("fs").writeFileSync(logPath, "");
      } catch {}
    }
    processLog(readsLogPath, 1);
    processLog(editsLogPath, 3);
    try { require("fs").writeFileSync(learningPath, JSON.stringify(learning, null, 2)); } catch {}

    // Adaptive budget based on prompt complexity
    const budget = complexity <= 3 ? 1500 : complexity <= 6 ? 5000 : 9000;
    const includeDeps = complexity >= 4;
    const includeTests = complexity >= 7;

    // Load hot-file data (change frequency) for priority boosting
    let hotFiles = {};
    try { hotFiles = JSON.parse(safeRead(historyPath) || "{}"); } catch {}

    let used = 0;
    const loaded = new Set();
    const output = [];

    // Score each module by keyword hits + learned relevance + hot-file boost
    const scored = index.modules.map((mod) => {
      const keywords = mod.keywords || [];
      const hits = keywords.filter((k) => safePrompt.includes(k.toLowerCase()));

      // Add learned relevance boost
      let learnedBoost = 0;
      for (const kw of safePrompt.split(/\\s+/)) {
        if (kw.length < 3) continue;
        const relevance = learning.moduleRelevance[kw];
        if (relevance && relevance[mod.name]) {
          learnedBoost += relevance[mod.name];
        }
      }

      // Hot-file boost: frequently-changed modules get priority (0.5x weight as tiebreaker)
      let hotBoost = 0;
      for (const file of (mod.files || [])) {
        const freq = hotFiles[file];
        if (typeof freq === "number") hotBoost += Math.min(freq, 10);
      }

      return { mod, hits: hits.length + learnedBoost + (hotBoost * 0.5), complexity: mod.complexity || 0 };
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

  // PostToolUse hook — tracks file reads for learning loop
  writeFileSync(join(hooksDir, "post-read.js"), `#!/usr/bin/env node
// briefed: PostToolUse hook — tracks which files Claude reads
const { appendFileSync, mkdirSync, existsSync } = require("fs");
const { join } = require("path");

let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    if (data.tool_name !== "Read") { process.exit(0); return; }
    const filePath = data.tool_input && data.tool_input.file_path;
    if (!filePath) { process.exit(0); return; }
    const briefedDir = join(process.cwd(), ".briefed");
    if (!existsSync(briefedDir)) mkdirSync(briefedDir, { recursive: true });
    appendFileSync(join(briefedDir, "session-reads.log"), filePath + "\\n");
  } catch {}
  process.exit(0);
});
`);

  // PostToolUse hook — tracks file edits for learning loop (3x weight vs reads)
  writeFileSync(join(hooksDir, "post-edit.js"), `#!/usr/bin/env node
// briefed: PostToolUse hook — tracks which files Claude edits (weighted 3x in learning)
const { appendFileSync, mkdirSync, existsSync } = require("fs");
const { join } = require("path");

let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    if (data.tool_name !== "Edit" && data.tool_name !== "Write") { process.exit(0); return; }
    const filePath = data.tool_input && data.tool_input.file_path;
    if (!filePath) { process.exit(0); return; }
    const briefedDir = join(process.cwd(), ".briefed");
    if (!existsSync(briefedDir)) mkdirSync(briefedDir, { recursive: true });
    appendFileSync(join(briefedDir, "session-edits.log"), filePath + "\\n");
  } catch {}
  process.exit(0);
});
`);
}
