import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { updateClaudeMd, saveSkeletonFile } from "./claudemd.js";
import { installHooks, generateHookScripts } from "./hooks.js";
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

  // Install hooks
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

  return summary;
}
