#!/usr/bin/env node
// briefed plugin: SessionStart hook
//
// Re-injects briefed's CLAUDE.md skeleton on every session start so the
// model has structural orientation from turn 1, even after `/compact`. This
// is the plugin-mode version of the script briefed used to generate per-
// project under <repo>/.briefed/hooks/session-start.js — the only difference
// is path resolution: per-project scripts use __dirname; plugin scripts use
// process.cwd() to find the user's current project.
//
// Behavior contract:
// - Read <cwd>/.briefed/skeleton.md if it exists
// - Write its contents to stdout (Claude Code injects stdout into context)
// - No-op silently if the project has no .briefed/ directory
// - Never throw — hooks block the user's prompt, so failures must be quiet

const { readFileSync, realpathSync, existsSync } = require("fs");
const { join } = require("path");

try {
  const cwd = process.cwd();
  const briefedDir = join(cwd, ".briefed");
  if (!existsSync(briefedDir)) process.exit(0);

  const skeletonPath = join(briefedDir, "skeleton.md");
  if (!existsSync(skeletonPath)) process.exit(0);

  // Security: verify the skeleton path resolves inside .briefed/ before reading.
  // Defends against symlink shenanigans where .briefed/skeleton.md might point
  // outside the project tree.
  const realSkeleton = realpathSync(skeletonPath);
  const realBriefed = realpathSync(briefedDir);
  if (!realSkeleton.startsWith(realBriefed)) process.exit(0);

  process.stdout.write(readFileSync(realSkeleton, "utf-8"));
} catch {
  // Fail silently — never block the user's session on a hook error
}
process.exit(0);
