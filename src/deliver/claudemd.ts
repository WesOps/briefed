import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const BRIEFED_START = "<!-- briefed:start -->";
const BRIEFED_END = "<!-- briefed:end -->";

/**
 * Append or update the briefed skeleton section in CLAUDE.md.
 * Preserves existing CLAUDE.md content. Only modifies the briefed section.
 */
export function updateClaudeMd(root: string, skeleton: string) {
  const claudeDir = join(root, ".claude");
  const claudeMdPath = join(root, "CLAUDE.md");

  // Ensure directories exist
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  const briefedSection = `${BRIEFED_START}\n${skeleton}\n${BRIEFED_END}`;

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
