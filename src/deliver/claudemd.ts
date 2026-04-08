import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const BRIEFED_START = "<!-- briefed:start -->";
const BRIEFED_END = "<!-- briefed:end -->";

/**
 * Generate the breadcrumb content that goes into CLAUDE.md by default.
 *
 * Context: the v1.1 bench (src/bench/polybench) validated that a thin
 * CLAUDE.md pointing at on-demand files beats a fat dump by ~40
 * percentage points on SWE-PolyBench TypeScript tasks (breadcrumb 5/5 vs
 * fat 3/5 vs codesight 4/5 at n=5). The model with a fat always-loaded
 * skeleton rushed to partial fixes; the model with a thin breadcrumb
 * explored more and wrote complete patches.
 *
 * The breadcrumb points at:
 *   - `.briefed/skeleton.md` — full file tree, symbols, deps, schema, routes, env (also injected by the SessionStart hook when briefed init installed it)
 *   - `.briefed/contracts/` — per-module behavioral contracts (loaded on-demand)
 *   - `.claude/rules/briefed-deep-*.md` — path-scoped rule files that
 *     Claude Code auto-loads when matching files are touched (no read needed)
 *
 * This is a static template; it takes no skeleton content because the model
 * reads the real content from .briefed/skeleton.md (or receives it via the
 * SessionStart hook). Keep the template short — every byte here is
 * always-loaded tax on every prompt.
 */
export function generateBreadcrumb(): string {
  return [
    "# Project context",
    "",
    "briefed-generated context for this repo. Read on demand:",
    "",
    "- `.briefed/skeleton.md` — full file tree, symbols, dep graph, schema, routes, env vars",
    "- `.briefed/contracts/` — per-module behavioral contracts (one file per top-level dir)",
    "- `.claude/rules/briefed-deep-*.md` — path-scoped behavioral annotations that",
    "  Claude Code auto-loads when you touch files matching their globs — no explicit read needed",
    "",
    "The skeleton covers structural questions; contracts cover behavioral questions.",
    "Don't read these unless your current task needs them — the SessionStart hook",
    "(if briefed installed it) already re-injects the skeleton on session start.",
  ].join("\n");
}

/**
 * Append or update the briefed section in CLAUDE.md.
 * Preserves existing CLAUDE.md content. Only modifies the briefed section.
 *
 * The `body` parameter is what goes between the briefed:start/briefed:end
 * markers — callers pass `generateBreadcrumb()`.
 */
export function updateClaudeMd(root: string, body: string) {
  const claudeDir = join(root, ".claude");
  const claudeMdPath = join(root, "CLAUDE.md");

  // Ensure directories exist
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  const briefedSection = `${BRIEFED_START}\n${body}\n${BRIEFED_END}`;

  if (existsSync(claudeMdPath)) {
    let content = readFileSync(claudeMdPath, "utf-8");

    // Remove legacy cctx section if present (superseded by briefed)
    const cctxStart = content.indexOf("<!-- cctx:start -->");
    const cctxEnd = content.indexOf("<!-- cctx:end -->");
    if (cctxStart !== -1 && cctxEnd !== -1) {
      content = content.slice(0, cctxStart) + content.slice(cctxEnd + "<!-- cctx:end -->".length);
      content = content.replace(/^\n{2,}/, "\n"); // clean up leading blank lines
    }

    if (content.includes(BRIEFED_START)) {
      // Replace existing briefed section
      const startIdx = content.indexOf(BRIEFED_START);
      const endIdx = content.indexOf(BRIEFED_END);
      if (endIdx !== -1) {
        content =
          content.slice(0, startIdx) +
          briefedSection +
          content.slice(endIdx + BRIEFED_END.length);
      }
    } else {
      // Append briefed section
      content = content.trimEnd() + "\n\n" + briefedSection + "\n";
    }

    writeFileSync(claudeMdPath, content);
  } else {
    // Create new CLAUDE.md with just the briefed section
    writeFileSync(claudeMdPath, briefedSection + "\n");
  }
}

/**
 * Save the skeleton as a standalone file in .briefed/ for hook re-injection.
 */
export function saveSkeletonFile(root: string, skeleton: string) {
  const briefedDir = join(root, ".briefed");
  if (!existsSync(briefedDir)) {
    mkdirSync(briefedDir, { recursive: true });
  }
  writeFileSync(join(briefedDir, "skeleton.md"), skeleton);
}
