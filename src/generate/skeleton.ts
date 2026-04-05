import { dirname, basename, relative } from "path";
import type { FileExtraction, Symbol } from "../extract/signatures.js";
import type { DepGraph } from "../extract/depgraph.js";
import type { ComplexityScore } from "../extract/complexity.js";
import type { StackInfo } from "../utils/detect.js";
import { countTokens } from "../utils/tokens.js";

export interface SkeletonOptions {
  maxTokens: number;   // target token budget for skeleton
  topN: number;        // max files to include
}

const DEFAULT_OPTIONS: SkeletonOptions = {
  maxTokens: 1000,
  topN: 50,
};

/**
 * Generate the L1 skeleton — a token-efficient structural map of the codebase.
 * Uses PageRank to prioritize the most central files.
 * Output format: Markdown (most token-efficient for hierarchical text).
 */
export function generateSkeleton(
  stack: StackInfo,
  extractions: FileExtraction[],
  depGraph: DepGraph,
  complexity: ComplexityScore[],
  opts: Partial<SkeletonOptions> = {}
): string {
  const options = { ...DEFAULT_OPTIONS, ...opts };

  // Rank files by PageRank score
  const ranked = extractions
    .filter((e) => e.symbols.length > 0)
    .map((e) => ({
      extraction: e,
      score: depGraph.pageRank.get(e.path) || 0,
      refs: depGraph.refCounts.get(e.path) || 0,
      complexity: complexity.find((c) => c.file === e.path)?.score || 0,
    }))
    .sort((a, b) => b.score - a.score);

  // Group files by directory
  const dirGroups = new Map<string, typeof ranked>();
  for (const item of ranked) {
    const dir = dirname(item.extraction.path);
    if (!dirGroups.has(dir)) dirGroups.set(dir, []);
    dirGroups.get(dir)!.push(item);
  }

  // Sort directories by total PageRank of their files
  const sortedDirs = [...dirGroups.entries()]
    .map(([dir, files]) => ({
      dir,
      files,
      totalScore: files.reduce((s, f) => s + f.score, 0),
      totalFiles: files.length,
    }))
    .sort((a, b) => b.totalScore - a.totalScore);

  // Build skeleton
  const lines: string[] = [];

  // Header
  const projectName = basename(extractions[0]?.path?.split("/")[0] || "project");
  lines.push(`# briefed: ${stack.frameworks.length > 0 ? stack.frameworks.join(", ") : stack.languages.join(", ")} project`);
  lines.push(`Stack: ${[...stack.languages, ...stack.frameworks].join(", ")}${stack.dbORM ? `, ${stack.dbORM}` : ""}`);
  if (stack.entryPoints.length > 0) {
    lines.push(`Entry: ${stack.entryPoints.join(", ")}`);
  }
  lines.push(
    `Files: ${extractions.length} source files across ${dirGroups.size} directories`
  );
  lines.push("");

  // Directory sections with file signatures
  let tokenCount = countTokens(lines.join("\n"));
  let filesIncluded = 0;

  for (const { dir, files, totalFiles } of sortedDirs) {
    if (filesIncluded >= options.topN) break;
    if (tokenCount >= options.maxTokens) break;

    // Count all source files in directory (not just those with symbols)
    const allInDir = extractions.filter(
      (e) => dirname(e.path) === dir
    ).length;

    const dirLine = `## ${dir}/ (${allInDir} files)`;
    lines.push(dirLine);
    tokenCount += countTokens(dirLine);

    for (const { extraction, refs, complexity: cx } of files) {
      if (filesIncluded >= options.topN) break;
      if (tokenCount >= options.maxTokens) break;

      const fname = basename(extraction.path);
      const refTag = refs > 0 ? ` ★${refs}` : "";

      // For high-complexity files, show full signatures
      // For low-complexity files, just show the file name with exports
      const exportedSymbols = extraction.symbols.filter((s) => s.exported);

      if (cx >= 5 || refs >= 3) {
        // Detailed: show signatures
        const fileLine = `${fname}${refTag}`;
        lines.push(fileLine);
        tokenCount += countTokens(fileLine);

        for (const sym of exportedSymbols.slice(0, 10)) {
          const sigLine = `  ${formatSignature(sym)}`;
          const sigTokens = countTokens(sigLine);
          if (tokenCount + sigTokens > options.maxTokens) break;
          lines.push(sigLine);
          tokenCount += sigTokens;
        }
        if (exportedSymbols.length > 10) {
          lines.push(`  ... +${exportedSymbols.length - 10} more exports`);
        }
      } else {
        // Compact: file name with all export names
        const exportNames = exportedSymbols
          .map((s) => {
            const name = s.name.split(".").pop()!;
            return s.description ? `${name} — ${s.description}` : name;
          })
          .join(", ");
        const compactLine = `${fname}${refTag}: ${exportNames}`;
        lines.push(compactLine);
        tokenCount += countTokens(compactLine);
      }

      filesIncluded++;
    }

    lines.push("");
    tokenCount += 1;
  }

  // Footer with token count
  lines.push(`<!-- briefed skeleton: ${filesIncluded} files, ~${countTokens(lines.join("\n"))} tokens -->`);

  return lines.join("\n");
}

function formatSignature(sym: Symbol): string {
  let base: string;
  switch (sym.kind) {
    case "route":
      base = sym.signature; break;
    case "method":
      base = sym.signature; break;
    case "class":
    case "interface":
      base = `${sym.kind} ${sym.signature}`; break;
    case "enum":
      base = `enum ${sym.signature}`; break;
    case "type":
      base = `type ${sym.signature}`; break;
    case "component":
      base = `<${sym.name}> ${sym.signature}`; break;
    default:
      base = sym.signature;
  }
  // Append description if available (one-liner from docstring/JSDoc)
  if (sym.description) {
    return `${base} — ${sym.description}`;
  }
  return base;
}
