import { dirname, relative } from "path";
import type { Gotcha } from "../extract/gotchas.js";

/**
 * Group gotchas by directory and format as .claude/rules/ files.
 * Each file gets YAML frontmatter with path matchers.
 */
export function generateRuleFiles(
  gotchas: Gotcha[],
  root: string
): Map<string, string> {
  // Group gotchas by directory
  const byDir = new Map<string, Gotcha[]>();

  for (const g of gotchas) {
    const relPath = relative(root, g.file).replace(/\\/g, "/");
    const dir = dirname(relPath);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push({ ...g, file: relPath });
  }

  // Generate rule files
  const files = new Map<string, string>();

  for (const [dir, dirGotchas] of byDir) {
    if (dirGotchas.length === 0) continue;

    // Create a safe filename
    const safeDir = dir.replace(/[\/\\]/g, "-").replace(/^-/, "");
    const fileName = `briefed-${safeDir || "root"}.md`;

    const lines: string[] = [];

    // YAML frontmatter with path matcher
    lines.push("---");
    lines.push(`paths:`);
    lines.push(`  - "${dir}/**"`);
    lines.push("---");
    lines.push("");
    lines.push(`# Constraints: ${dir}/`);
    lines.push("");

    // Group by category
    const byCategory = new Map<string, Gotcha[]>();
    for (const g of dirGotchas) {
      if (!byCategory.has(g.category)) byCategory.set(g.category, []);
      byCategory.get(g.category)!.push(g);
    }

    // Important comments first
    const comments = byCategory.get("important_comment") || [];
    if (comments.length > 0) {
      for (const g of comments) {
        lines.push(`- ${g.text}`);
      }
    }

    // Guard clauses
    const guards = byCategory.get("guard_clause") || [];
    if (guards.length > 0) {
      for (const g of guards) {
        lines.push(`- ${g.text}`);
      }
    }

    // State transitions
    const states = byCategory.get("state_transition") || [];
    if (states.length > 0) {
      for (const g of states) {
        lines.push(`- ${g.text}`);
      }
    }

    // Side effects
    const effects = byCategory.get("side_effect") || [];
    if (effects.length > 0) {
      for (const g of effects) {
        lines.push(`- ${g.text}`);
      }
    }

    // Soft deletes
    const deletes = byCategory.get("soft_delete") || [];
    if (deletes.length > 0) {
      for (const g of deletes) {
        lines.push(`- ${g.text}`);
      }
    }

    // Unique constraints
    const uniques = byCategory.get("unique_constraint") || [];
    if (uniques.length > 0) {
      for (const g of uniques) {
        lines.push(`- ${g.text}`);
      }
    }

    // Other
    for (const [cat, gs] of byCategory) {
      if (["important_comment", "guard_clause", "state_transition", "side_effect", "soft_delete", "unique_constraint"].includes(cat)) continue;
      for (const g of gs) {
        lines.push(`- ${g.text}`);
      }
    }

    files.set(fileName, lines.join("\n"));
  }

  return files;
}
