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
    "briefed is installed. Prefer these MCP tools over Read/Grep for codebase navigation:",
    "",
    "- `briefed_issue_candidates` — **call first** on any new task: finds relevant files from the index",
    "- `briefed_symbol` — look up any function/class/type by name (faster than Grep)",
    "- `briefed_routes` — all API routes instantly (no need to read route files)",
    "- `briefed_schema` — all DB models instantly (no need to read schema files)",
    "- `briefed_find_usages` — all call sites for a symbol (faster than Grep)",
    "- `briefed_blast_radius` — transitive dependents of a file before refactoring",
    "- `briefed_test_map` — find the test file for any source file",
    "",
    "Static context (read on demand if MCP tools are unavailable):",
    "- `.briefed/skeleton.md` — full file tree, symbols, dep graph, schema, routes, env vars",
    "- `.briefed/contracts/` — per-module behavioral contracts",
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
