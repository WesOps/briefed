#!/usr/bin/env node
// briefed: SessionStart hook — re-inject skeleton after compaction
// Security: only reads from .briefed/ directory, never writes, never persists input
const { readFileSync, realpathSync } = require("fs");
const { join, resolve } = require("path");

const briefedDir = resolve(join(__dirname, ".."));
const skeletonPath = join(briefedDir, "skeleton.md");

// Verify the skeleton file is inside .briefed/ (prevent path traversal)
try {
  const realPath = realpathSync(skeletonPath);
  if (!realPath.startsWith(realpathSync(briefedDir))) process.exit(0);
  process.stdout.write(readFileSync(realPath, "utf-8"));
} catch {}