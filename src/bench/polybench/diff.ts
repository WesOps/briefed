/**
 * Capture `git diff HEAD` from a repo and strip hunks that touch
 * context-tool artifacts (briefed, codesight, CLAUDE.md, etc.). The SWE-
 * PolyBench evaluator applies the model_patch alongside its own test_patch;
 * anything the harness' tool setup wrote to tracked files (gitignore edits,
 * briefed's deep-cache.json timestamp, codesight's wiki, etc.) shows up in
 * `git diff HEAD` as "the model's changes" and causes the evaluator's
 * `git apply` to collide with the test_patch. Filtering those paths out
 * before we record the prediction gives us a clean source-only diff.
 */

import { spawnSync } from "child_process";

const EXCLUDE_PREFIXES = [
  ".briefed/",
  ".codesight/",
  ".claude/rules/briefed-",
  ".claude/settings.json",
];

const EXCLUDE_EXACT = new Set<string>([
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
  "codex.md",
  ".gitignore",
]);

/** Return true if a file path is a tool-artifact that should not be in the model patch. */
export function isExcludedPath(path: string): boolean {
  if (EXCLUDE_EXACT.has(path)) return true;
  return EXCLUDE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Parse a unified git diff into per-file blocks and drop any block whose
 * file path matches the exclude list. The output is a valid unified diff
 * that `git apply` / SWE-PolyBench's evaluator can process without seeing
 * tool artifacts.
 */
export function filterDiff(diff: string): string {
  const blocks: string[] = [];
  let currentBlock: string[] = [];
  let currentPath: string | null = null;

  const flushCurrent = () => {
    if (currentBlock.length === 0) return;
    if (currentPath === null || !isExcludedPath(currentPath)) {
      blocks.push(currentBlock.join("\n"));
    }
    currentBlock = [];
    currentPath = null;
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flushCurrent();
      currentBlock.push(line);
      // Parse `diff --git a/<path> b/<path>` — we care about the b/ side.
      const parts = line.split(" ");
      if (parts.length >= 4) {
        const bSide = parts[3];
        currentPath = bSide.startsWith("b/") ? bSide.slice(2) : bSide;
      } else {
        currentPath = null;
      }
    } else if (currentBlock.length > 0) {
      currentBlock.push(line);
    }
    // Lines before the first `diff --git` (shouldn't exist in a normal
    // git-diff, but be safe) are discarded.
  }
  flushCurrent();

  if (blocks.length === 0) return "";
  const joined = blocks.join("\n");
  return joined.endsWith("\n") ? joined : joined + "\n";
}

/**
 * Run `git diff HEAD` in the repo and return the filtered unified diff.
 * Throws if the git command fails. Never captures stderr as output.
 */
export function captureAndFilterDiff(repoPath: string): string {
  const result = spawnSync("git", ["diff", "HEAD"], {
    cwd: repoPath,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (result.error) {
    throw new Error(`git diff HEAD failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `git diff HEAD exited ${result.status}: ${(result.stderr || "").slice(0, 200)}`,
    );
  }
  return filterDiff(result.stdout || "");
}
