#!/usr/bin/env node
// briefed plugin: UserPromptSubmit hook
//
// Adaptive per-prompt context injection. Scores the user's prompt by
// keyword complexity, picks a token budget (1.5K / 5K / 9K), then loads
// matching module contracts from <cwd>/.briefed/contracts/ — including
// their dependencies/dependents for medium-or-higher complexity tasks
// and their test mappings for high-complexity tasks. Whatever this
// script writes to stdout is injected into the user's prompt context
// before Claude sees it.
//
// This is the plugin-mode counterpart to the script briefed init used to
// generate at <repo>/.briefed/hooks/prompt-submit.js. Same logic, but
// project root resolved from process.cwd() instead of __dirname so the
// single plugin install works across every project the user opens.
//
// Behavior contract:
// - Read <cwd>/.briefed/index.json + <cwd>/.briefed/contracts/* + test-map.json
// - All file reads scoped inside .briefed/ via realpath check
// - Truncate prompt to 2000 chars before regex matching (ReDoS guard)
// - No-op silently if the project has no .briefed/ directory
// - Never throw — hooks block prompts, so failures must be quiet

const { readFileSync, existsSync, realpathSync } = require("fs");
const { join } = require("path");

const cwd = process.cwd();
const briefedDir = join(cwd, ".briefed");
if (!existsSync(briefedDir)) process.exit(0);

const contractsDir = join(briefedDir, "contracts");
const indexPath = join(briefedDir, "index.json");
const testMapPath = join(briefedDir, "test-map.json");

// Security: verify a path is inside .briefed/ before reading
let realBriefedDir;
try {
  realBriefedDir = realpathSync(briefedDir);
} catch {
  process.exit(0);
}

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
  const highSignals = [/refactor/i, /restructur/i, /redesign/i, /migrat/i, /debug/i, /investigate/i, /\bwhy\b/i, /architect/i, /\bsystem\b/i, /security/i, /vulnerab/i, /performance/i, /optimiz/i];
  for (const s of highSignals) { if (s.test(prompt)) score += 2; }

  // Medium signals (+1 each)
  const medSignals = [/\badd\b/i, /implement/i, /create/i, /build/i, /integrat/i, /\btest/i, /endpoint/i, /feature/i, /module/i, /service/i];
  for (const s of medSignals) { if (s.test(prompt)) score += 1; }

  // Low complexity signals (-2 each)
  const lowSignals = [/typo/i, /rename/i, /comment/i, /\blog\b/i, /print/i, /format/i, /lint/i, /spell/i];
  for (const s of lowSignals) { if (s.test(prompt)) score -= 2; }

  // Long prompts = more complex
  if (prompt.length > 200) score += 1;
  if (prompt.length > 500) score += 1;
  if (prompt.length < 30) score -= 1;

  // Multiple file/module mentions = complex
  const fileRefs = (prompt.match(/\w+\.\w{2,4}/g) || []).length;
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
      const match = contractText.match(new RegExp(field + ":\\n([\\s\\S]*?)(?:\\n\\w|$)"));
      if (!match) return;
      const items = match[1].match(/- (.+)/g) || [];
      for (const item of items) {
        const name = item.replace("- ", "").trim();
        const relMod = index.modules.find((m) => m.name === name);
        if (relMod && !loaded.has(relMod.file) && used < budget) {
          const contract = safeRead(join(contractsDir, relMod.file));
          if (contract && used + contract.length <= budget) {
            output.push("# " + label + ": " + relMod.dir + "\n" + contract);
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
            output.push("# Module: " + mod.dir + "\n" + contract);
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
              const testLine = "# Tests for " + file + ": " + testInfo.test + " (" + testInfo.count + " tests)\n" +
                (testInfo.names || []).slice(0, 5).map((n) => "  - " + n).join("\n");
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
      process.stdout.write(output.join("\n---\n"));
    }
  } catch {
    // Fail silently
  }
  process.exit(0);
});
