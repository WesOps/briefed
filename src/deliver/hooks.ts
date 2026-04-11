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

  // No MCP registration here. The auto-install of mcpServers.briefed was
  // removed in v0.4.0 — see the note in src/deliver/output.ts and the
  // src/mcp/ directory for the still-shipped MCP server users can register
  // at user scope manually.

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
const artifactsDir = join(briefedDir, "artifacts");
const dangerIndexPath = join(briefedDir, "danger-index.json");

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

    // Danger zone injection — BM25-match user prompt against flattened danger
    // zones and inject the top matches. This is guaranteed delivery of critical
    // constraints without requiring the model to navigate to the right directory.
    const dangerOutputs = [];
    if (safeExists(dangerIndexPath)) {
      try {
        const dangerIndex = JSON.parse(safeRead(dangerIndexPath) || "{}");
        const items = dangerIndex.items || [];
        const dIdf = (dangerIndex.bm25 && dangerIndex.bm25.idf) || {};
        const dAvgdl = (dangerIndex.bm25 && dangerIndex.bm25.avgdl) || 5;
        const promptTerms = safePrompt.toLowerCase().replace(/[^a-z0-9\\s]/g, " ").split(/\\s+/).filter((t) => t.length >= 4);
        if (promptTerms.length > 0 && items.length > 0) {
          const k1 = 1.5, b = 0.75;
          const scored = items.map((item) => {
            const kws = item.keywords || [];
            const dl = kws.length || 1;
            let score = 0;
            for (const term of promptTerms) {
              const matching = kws.filter((kw) =>
                kw === term ||
                (term.length >= 4 && (kw.startsWith(term) || kw.endsWith(term))) ||
                (kw.length >= 4 && (term.startsWith(kw) || term.endsWith(kw)))
              );
              if (matching.length === 0) continue;
              const tf = matching.length;
              let bestIdf = 0;
              for (const kw of matching) {
                const v = dIdf[kw];
                if (v !== undefined && v > bestIdf) bestIdf = v;
              }
              if (bestIdf === 0) continue;
              score += bestIdf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / dAvgdl));
            }
            return { item, score };
          })
          .filter((s) => s.score > 2.0) // confidence threshold — only strong matches
          .sort((a, b) => b.score - a.score)
          .slice(0, 5); // top 5 danger zones max

          for (const { item } of scored) {
            dangerOutputs.push("\u26A0 " + item.file + ":" + item.symbol + " \u2014 " + item.danger);
          }
        }
      } catch {}
    }

    // Task classifier — inject pre-built artifacts for known query types.
    // Fires before BM25 so task-native answers arrive without module retrieval.
    const TASK_CLASSIFIERS = [
      {
        patterns: [/\\benv\\b/i, /environment variable/i, /\\.env/i, /\\bDATABASE_URL\\b/, /\\bSESSION_SECRET\\b/, /\\bconfig\\b.*(?:var|key|secret)/i, /what.*(?:env|variable|secret)/i],
        artifact: "env-audit.md",
        label: "env-audit",
      },
      {
        patterns: [/\\blogin\\b/i, /\\bauth(?:entication|oriz)/i, /\\bsession\\b/i, /\\bjwt\\b/i, /\\boauth\\b/i, /\\bsignup\\b/i, /\\bpassword\\b/i, /how.*(?:auth|login|user.*log)/i, /trace.*login/i],
        artifact: "auth-context.md",
        label: "auth-context",
      },
    ];

    const artifactOutputs = [];
    for (const classifier of TASK_CLASSIFIERS) {
      if (classifier.patterns.some((p) => p.test(safePrompt))) {
        const artifactPath = join(artifactsDir, classifier.artifact);
        const content = safeExists(artifactPath) ? safeRead(artifactPath) : null;
        if (content) {
          artifactOutputs.push({ label: classifier.label, content });
        }
      }
    }

    const index = JSON.parse(safeRead(indexPath) || "{}");
    if (!index.modules) {
      if (artifactOutputs.length > 0) {
        const header = "# briefed: injected " + artifactOutputs.map((a) => a.label).join(", ") + "\\n";
        process.stdout.write(header + artifactOutputs.map((a) => a.content).join("\\n---\\n"));
      }
      process.exit(0);
      return;
    }
    const complexity = scorePrompt(safePrompt);

    let used = 0;
    const loaded = new Set();
    const output = [];

    // BM25 module scoring — replaces binary keyword hit count.
    // Uses pre-computed IDF from index.bm25 so rare/discriminative keywords
    // score higher than common ones. Partial matching: term "modal" hits keyword
    // "modaldialog" and vice versa, capturing synonyms keyword expansion missed.
    const bm25 = index.bm25 || null;
    const N = index.modules.length;

    function extractTerms(text) {
      return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 4);
    }

    function scoreBM25(keywords, queryTerms, idf, avgdl) {
      const k1 = 1.5, b = 0.75;
      const dl = keywords.length || 1;
      let score = 0;
      for (const term of queryTerms) {
        // Collect matching keywords using prefix/suffix only (not arbitrary infix).
        // IDF is keyed by keyword — look it up on the matched keyword, not the query term,
        // so TF and IDF live in the same token space.
        const matchingKws = [];
        for (const kw of keywords) {
          if (kw === term ||
              (term.length >= 4 && (kw.startsWith(term) || kw.endsWith(term))) ||
              (kw.length >= 4 && (term.startsWith(kw) || term.endsWith(kw)))) {
            matchingKws.push(kw);
          }
        }
        if (matchingKws.length === 0) continue;
        const tf = matchingKws.length;
        // Use highest IDF among matched keywords (rarest = most discriminative)
        let bestIdf = 0;
        for (const kw of matchingKws) {
          const v = idf[kw];
          if (v !== undefined && v > bestIdf) bestIdf = v;
        }
        if (bestIdf === 0) continue; // no known IDF — skip rather than guess
        score += bestIdf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl));
      }
      return score;
    }

    const queryTerms = extractTerms(safePrompt);

    const scored = index.modules.map((mod) => {
      const keywords = (mod.keywords || []).map((k) => k.toLowerCase());
      let score;
      if (bm25 && queryTerms.length > 0) {
        score = scoreBM25(keywords, queryTerms, bm25.idf, bm25.avgdl);
      } else {
        // Fallback: binary hit count (no bm25 params in old index)
        score = keywords.filter((k) => safePrompt.includes(k)).length;
      }
      return { mod, score, complexity: mod.complexity || 0 };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.complexity - a.complexity);

    // Gate injection budget on retrieval confidence.
    // If the top BM25 score is weak (< 1.5), the match is speculative — use a
    // small budget so we don't flood a large-repo agent with irrelevant contracts.
    // Strong match (≥ 3.0) unlocks the full budget regardless of prompt complexity.
    const topScore = scored.length > 0 ? scored[0].score : 0;
    const confidenceMultiplier = topScore >= 3.0 ? 1.0 : topScore >= 1.5 ? 0.6 : 0.3;
    const basebudget = complexity <= 3 ? 1500 : complexity <= 6 ? 5000 : 9000;
    const budget = Math.round(basebudget * confidenceMultiplier);
    const includeDeps = complexity >= 7 && topScore >= 2.0;
    const includeTests = complexity >= 7 && topScore >= 2.0;

    // Helper: load related modules (dependencies or dependents) from a contract.
    // Parses the YAML list under the "field:" header line-by-line — avoids RegExp
    // string escaping issues where character classes collapsed in non-strict mode.
    function loadRelated(mod, label, field) {
      const contractText = safeRead(join(contractsDir, mod.file));
      if (!contractText) return;
      const lines = contractText.split('\\n');
      const headerIdx = lines.indexOf(field + ':');
      if (headerIdx === -1) return;
      const names = [];
      for (let i = headerIdx + 1; i < lines.length; i++) {
        const m = lines[i].match(/^  - (.+)/);
        if (!m) break;
        names.push(m[1].trim());
      }
      for (const name of names) {
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
              const lines = ["# Tests for " + file + ": " + testInfo.test + " (" + testInfo.count + " tests)"];
              for (const n of (testInfo.names || []).slice(0, 5)) {
                lines.push("  - " + n);
                const asserts = testInfo.assertions && testInfo.assertions[n];
                if (asserts) {
                  for (const a of asserts.slice(0, 2)) {
                    lines.push("    " + a);
                  }
                }
              }
              const testLine = lines.join("\\n");
              if (used + testLine.length <= budget) {
                output.push(testLine);
                used += testLine.length;
              }
            }
          }
        } catch {}
      }
    }

    // Danger zones go at the TOP — critical constraints the model must see first
    const dangerSection = dangerOutputs.length > 0
      ? "# \u26A0 DANGER ZONES (do NOT ignore these — call briefed_symbol for full context before editing)\\n" + dangerOutputs.join("\\n") + "\\n---\\n"
      : "";

    const allParts = [
      ...artifactOutputs.map((a) => a.content),
      ...output,
    ];
    if (allParts.length > 0 || dangerSection) {
      const artifactLabels = artifactOutputs.map((a) => a.label);
      const moduleNames = scored.slice(0, loaded.size).map((s) => s.mod.dir);
      const dangerLabel = dangerOutputs.length > 0 ? ["danger-zones"] : [];
      const allLabels = [...dangerLabel, ...artifactLabels, ...moduleNames].join(", ");
      const header = "# briefed: injected " + allLabels + "\\n";
      process.stdout.write(header + dangerSection + allParts.join("\\n---\\n"));
    }
  } catch {
    // Fail silently
  }
  process.exit(0);
});
`.trim();

  writeFileSync(join(hooksDir, "prompt-submit.js"), promptSubmitScript);
}
