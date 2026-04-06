import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { updateClaudeMd, saveSkeletonFile } from "./claudemd.js";
import { installHooks, installMcpServer, generateHookScripts } from "./hooks.js";
import { writeCursorRules, writeAgentsMd, writeCopilotInstructions, writeCodexMd } from "./cross-tool.js";
import { installGitHook } from "./git-hook.js";
import { generateRuleFiles } from "../generate/rules.js";
import type { ExtractionResult } from "../extract/pipeline.js";


export interface OutputSummary {
  ruleFilesWritten: number;
  hooksInstalled: boolean;
  gitHookInstalled: boolean;
  testMapEntries: number;
  historyEntries: number;
}

export interface WriteOutputsOptions {
  skipHooks?: boolean;
  skipRules?: boolean;
}

/**
 * Write all output files: skeleton, rules, hooks, cross-tool output, test-map, history.
 */
export function writeOutputs(
  root: string,
  result: ExtractionResult,
  enrichedSkeleton: string,
  convText: string,
  opts: WriteOutputsOptions
): OutputSummary {
  const summary: OutputSummary = {
    ruleFilesWritten: 0,
    hooksInstalled: false,
    gitHookInstalled: false,
    testMapEntries: result.testMappings.length,
    historyEntries: result.histories.size,
  };

  // Ensure .briefed/ directory exists
  const briefedDir = join(root, ".briefed");
  if (!existsSync(briefedDir)) mkdirSync(briefedDir, { recursive: true });

  // Save test mappings to .briefed/ for hook use
  writeFileSync(
    join(briefedDir, "test-map.json"),
    JSON.stringify(
      Object.fromEntries(result.testMappings.map((t) => [t.sourceFile, { test: t.testFile, count: t.testCount, names: t.testNames.slice(0, 10) }])),
      null,
      2
    )
  );

  // Save histories to .briefed/ for hook use (frequency only — used as priority boost)
  if (result.histories.size > 0) {
    const histObj: Record<string, number> = {};
    for (const [file, hist] of result.histories) {
      if (hist.changeFrequency > 0) {
        histObj[file] = hist.changeFrequency;
      }
    }
    writeFileSync(join(briefedDir, "history.json"), JSON.stringify(histObj, null, 2));
  }

  // Write skeleton to CLAUDE.md
  console.log("  Writing skeleton to CLAUDE.md...");
  updateClaudeMd(root, enrichedSkeleton);
  saveSkeletonFile(root, enrichedSkeleton);

  // Write rule files from gotchas
  if (!opts.skipRules) {
    console.log("  Writing gotchas to .claude/rules/...");
    const ruleFiles = generateRuleFiles(result.gotchas, root);
    const rulesDir = join(root, ".claude", "rules");
    if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });

    for (const [filename, content] of ruleFiles) {
      writeFileSync(join(rulesDir, filename), content);
    }
    summary.ruleFilesWritten = ruleFiles.size;
    console.log(`  Wrote ${ruleFiles.size} rule files`);
  }

  // Always register the briefed MCP server. It's the always-on integration
  // and has zero side effects beyond adding an mcpServers entry to
  // .claude/settings.json. Bundling this with --skip-hooks would silently
  // disable Claude's ability to call briefed_find_usages / briefed_blast_radius
  // / etc., which is exactly the wrong thing for a "minimal install" flag.
  installMcpServer(root);
  console.log("  briefed MCP server registered in .claude/settings.json");

  // Install event hooks (SessionStart, UserPromptSubmit, PostToolUse, Stop).
  // These are the "adaptive" pieces — telemetry, learning loop, dynamic
  // context injection. They're heavier and some users prefer to skip them.
  if (!opts.skipHooks) {
    console.log("  Installing hooks...");
    generateHookScripts(root);
    installHooks(root);
    summary.hooksInstalled = true;
    console.log("  Hooks installed in .claude/settings.json");
  }

  // Cross-tool output
  console.log("  Writing cross-tool context...");
  writeCursorRules(root, enrichedSkeleton, convText);
  writeAgentsMd(root, enrichedSkeleton, convText);
  writeCopilotInstructions(root, enrichedSkeleton, convText);
  writeCodexMd(root, enrichedSkeleton, convText);

  // Git hook for auto-updates
  summary.gitHookInstalled = installGitHook(root);
  if (summary.gitHookInstalled) {
    console.log("  Git hook installed (auto-updates on every commit)");
  }

  // Add briefed's runtime artifacts to .gitignore so they don't get committed
  // and don't trigger false-positive "context is stale" warnings.
  updateGitignore(root);

  return summary;
}

const GITIGNORE_MARKER_START = "# briefed:start";
const GITIGNORE_MARKER_END = "# briefed:end";
// Everything briefed generates is local-only by default. The repo stays clean
// of generated context; the SessionStart hook re-runs `briefed init` to keep
// each developer's local copy fresh. To bootstrap a fresh clone, run
// `briefed init` once.
const GITIGNORE_ENTRIES = [
  "# briefed: all generated context is local-only.",
  "# Run `briefed init` once after cloning to bootstrap.",
  ".briefed/",
  ".claude/",
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules",
  "codex.md",
  ".github/copilot-instructions.md",
  "*.briefed-backup",
];

/**
 * Append briefed's runtime artifacts to .gitignore inside a marked block.
 * Idempotent: re-running init replaces the existing block instead of appending.
 */
function updateGitignore(root: string) {
  const path = join(root, ".gitignore");
  const block = [
    GITIGNORE_MARKER_START,
    ...GITIGNORE_ENTRIES,
    GITIGNORE_MARKER_END,
  ].join("\n");

  let content = "";
  if (existsSync(path)) {
    content = readFileSync(path, "utf-8");
    const startIdx = content.indexOf(GITIGNORE_MARKER_START);
    const endIdx = content.indexOf(GITIGNORE_MARKER_END);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      // Replace existing block
      const before = content.slice(0, startIdx).trimEnd();
      const after = content.slice(endIdx + GITIGNORE_MARKER_END.length);
      content = (before ? before + "\n\n" : "") + block + after;
      writeFileSync(path, content.endsWith("\n") ? content : content + "\n");
      return;
    }
  }

  const sep = content && !content.endsWith("\n") ? "\n\n" : content ? "\n" : "";
  writeFileSync(path, content + sep + block + "\n");
}
