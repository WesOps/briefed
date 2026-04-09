import { dirname, basename } from "path";
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
 * Compute adaptive skeleton budget based on codebase size.
 * Small repos get the compact default. Large repos scale up so the skeleton
 * covers a meaningful fraction of files instead of a fixed 50-file slice.
 *
 * Token budget: 1000 base + 2 per file, capped at 8000.
 *   50 files → ~1100 tok   200 files → ~1400 tok
 *   500 files → ~2000 tok  3000 files → ~7000 tok
 * topN: 50 base + 1 per 5 files, capped at 200.
 *   50 files → 60   500 files → 150   1000+ files → 200
 */
export function adaptiveSkeletonOptions(fileCount: number): SkeletonOptions {
  const maxTokens = Math.min(8000, 1000 + fileCount * 2);
  const topN = Math.min(200, 50 + Math.floor(fileCount / 5));
  return { maxTokens, topN };
}

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
  // Build file→caller count map from depGraph inEdges
  const fileCallerCount = new Map<string, number>();
  for (const [path, node] of depGraph.nodes) {
    fileCallerCount.set(path, node.inEdges.length);
  }
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

  for (const { dir, files } of sortedDirs) {
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
      const callers = fileCallerCount.get(extraction.path) || 0;
      const refTag = callers > 0 ? ` ★${callers}` : "";

      // For high-complexity files, show full signatures
      // For low-complexity files, just show the file name with exports
      const exportedSymbols = extraction.symbols.filter((s) => s.exported);

      if (cx >= 5 || refs >= 3) {
        // Detailed: show signatures
        const fileLine = `${fname}${refTag}`;
        lines.push(fileLine);
        tokenCount += countTokens(fileLine);

        for (const sym of exportedSymbols.slice(0, 10)) {
          const symCallers = depGraph.symbolRefs.get(`${extraction.path}#${sym.name}`)?.length || 0;
          const callerTag = symCallers > 1 ? ` [${symCallers} callers]` : "";
          const sigLine = `  ${formatSignature(sym)}${callerTag}`;
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
    const desc = sym.description.length > 80 ? sym.description.slice(0, 77) + "..." : sym.description;
    return `${base} — ${desc}`;
  }
  return base;
}
