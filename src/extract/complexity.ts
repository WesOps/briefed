import { readFileSync } from "fs";
import { join, isAbsolute } from "path";
import type { FileExtraction } from "./signatures.js";
import type { DepGraph } from "./depgraph.js";

export interface ComplexityScore {
  file: string;
  score: number;         // 0-10 scale
  fanOut: number;        // number of imports
  fanIn: number;         // number of dependents (from dep graph)
  branchCount: number;   // if/switch/ternary count
  lineCount: number;
  symbolCount: number;
}

/**
 * Compute complexity score for a file.
 * Higher score = more context needed when working with this file.
 */
export function computeComplexity(
  extraction: FileExtraction,
  depGraph: DepGraph,
  root = "",
): ComplexityScore {
  // extraction.path may be relative (set by pipeline after extraction).
  // Resolve against root so --repo /other/path doesn't silently fail.
  const fullPath = isAbsolute(extraction.path) ? extraction.path : join(root, extraction.path);
  const content = readFileSync(fullPath, "utf-8");

  const fanOut = extraction.imports.filter((i) => i.isRelative).length;
  const node = depGraph.nodes.get(
    extraction.path.replace(/\\/g, "/")
  );
  const fanIn = node?.inEdges.length || 0;

  // Count branching constructs
  const branchPatterns = [
    /\bif\s*\(/g,
    /\belse\s+if\s*\(/g,
    /\bswitch\s*\(/g,
    /\bcase\s+/g,
    /\bcatch\s*\(/g,
    /\?\s*[^:]/g,  // ternary
  ];
  let branchCount = 0;
  for (const pattern of branchPatterns) {
    const matches = content.match(pattern);
    if (matches) branchCount += matches.length;
  }

  // Compute weighted score (0-10)
  const score = Math.min(10, (
    clamp(fanOut / 3, 0, 3) +       // 0-3 points for imports
    clamp(fanIn / 3, 0, 3) +        // 0-3 points for dependents
    clamp(branchCount / 15, 0, 2) + // 0-2 points for branching
    clamp(extraction.lineCount / 200, 0, 1) + // 0-1 points for size
    clamp(extraction.symbols.length / 10, 0, 1) // 0-1 points for symbol density
  ));

  return {
    file: extraction.path,
    score: Math.round(score * 10) / 10,
    fanOut,
    fanIn,
    branchCount,
    lineCount: extraction.lineCount,
    symbolCount: extraction.symbols.length,
  };
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}
