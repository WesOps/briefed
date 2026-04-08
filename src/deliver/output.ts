import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { updateClaudeMd, saveSkeletonFile, generateBreadcrumb } from "./claudemd.js";
import { installHooks, generateHookScripts } from "./hooks.js";
import { writeCursorRules, writeAgentsMd, writeCopilotInstructions, writeCodexMd } from "./cross-tool.js";
import { installGitHook } from "./git-hook.js";
import type { ExtractionResult } from "../extract/pipeline.js";


export interface OutputSummary {
  hooksInstalled: boolean;
  gitHookInstalled: boolean;
  testMapEntries: number;
}

export interface WriteOutputsOptions {
  skipHooks?: boolean;
}

/**
 * Write all output files: skeleton, hooks, cross-tool output, test-map.
 */
export function writeOutputs(
  root: string,
  result: ExtractionResult,
  enrichedSkeleton: string,
  convText: string,
  opts: WriteOutputsOptions
): OutputSummary {
  const summary: OutputSummary = {
    hooksInstalled: false,
    gitHookInstalled: false,
    testMapEntries: result.testMappings.length,
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

  // Write the full skeleton to .briefed/skeleton.md — it's the source of
  // truth that the SessionStart hook reads and that users can open directly.
  // CLAUDE.md gets a thin breadcrumb pointing at it.
  saveSkeletonFile(root, enrichedSkeleton);

  console.log("  Writing breadcrumb to CLAUDE.md (full skeleton at .briefed/skeleton.md)...");
  updateClaudeMd(root, generateBreadcrumb());

  // NOTE: briefed used to auto-register an MCP server entry in
  // .claude/settings.json here. The audit for v0.4.0 confirmed that
  // `claude -p` does not load MCP servers from project-scoped settings,
  // and the model never called any briefed.* tools across the entire
  // bench. Auto-install was misleading dead code, so it was removed.
  // The MCP server itself (`briefed mcp` command, src/mcp/) is still
  // shipped — users who want it can register at user scope manually:
  //   claude mcp add briefed --scope user node /path/to/dist/cli.js mcp --repo .
  // Future: package as a Claude Code plugin so it loads automatically.

  // Install event hooks (SessionStart + UserPromptSubmit).
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
const GITIGNORE_ENTRIES = [
  ".briefed/extract-cache.json",
  ".briefed/hooks/",
  ".claude/settings.json.briefed-backup",
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
