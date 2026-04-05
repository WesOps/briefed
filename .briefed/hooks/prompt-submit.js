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

    if (!prompt || !safeExists(indexPath)) {
      process.exit(0);
      return;
    }

    // Security: truncate prompt analysis to prevent ReDoS on long inputs
    const safePrompt = prompt.slice(0, 2000);
    const index = JSON.parse(safeRead(indexPath) || "{}");
    if (!index.modules) { process.exit(0); return; }
    const complexity = scorePrompt(safePrompt);

    // Adaptive budget based on prompt complexity
    // Simple (1-3): 1500 chars (~400 tokens) — contracts only
    // Moderate (4-6): 5000 chars (~1350 tokens) — contracts + deps
    // Complex (7-10): 9000 chars (~2400 tokens) — contracts + deps + tests + history
    const budget = complexity <= 3 ? 1500 : complexity <= 6 ? 5000 : 9000;
    const includeDeps = complexity >= 4;
    const includeTests = complexity >= 7;
    const includeHistory = complexity >= 7;

    let used = 0;
    const loaded = new Set();
    const output = [];

    // Score each module by keyword hits
    const scored = index.modules.map((mod) => {
      const keywords = mod.keywords || [];
      const hits = keywords.filter((k) => safePrompt.includes(k.toLowerCase()));
      return { mod, hits: hits.length, complexity: mod.complexity || 0 };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.complexity - a.complexity);

    // Load matching modules + their dependencies
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

      // Load dependency modules (moderate+ complexity)
      if (includeDeps) {
        const contractPath2 = join(contractsDir, mod.file);
        const contractText = safeRead(contractPath2);
        if (contractText) {
          const depMatch = contractText.match(/dependencies:\n([\s\S]*?)(?:\n\w|$)/);
          if (depMatch) {
            const deps = depMatch[1].match(/- (.+)/g) || [];
            for (const dep of deps) {
              const depName = dep.replace("- ", "").trim();
              const depMod = index.modules.find((m) => m.name === depName);
              if (depMod && !loaded.has(depMod.file) && used < budget) {
                const depPath = join(contractsDir, depMod.file);
                const depContract = safeRead(depPath);
                if (depContract) {
                  if (used + depContract.length <= budget) {
                    output.push("# Dependency: " + depMod.dir + "\n" + depContract);
                    used += depContract.length;
                    loaded.add(depMod.file);
                  }
                }
              }
            }
          }
        }
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

      // Inject history for matched modules (complex tasks only)
      if (includeHistory && safeExists(historyPath) && used < budget) {
        try {
          const history = JSON.parse(safeRead(historyPath) || "{}");
          for (const file of mod.files || []) {
            const hist = history[file];
            if (hist && hist.recent && hist.recent.length > 0 && used < budget) {
              const histLine = "# History for " + file + " (" + hist.frequency + " recent commits):\n" +
                hist.recent.slice(0, 3).map((m) => "  - " + m).join("\n");
              if (used + histLine.length <= budget) {
                output.push(histLine);
                used += histLine.length;
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