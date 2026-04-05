import { readFileSync } from "fs";
import { basename } from "path";
import type { FileExtraction } from "./signatures.js";

export interface UsageExample {
  symbol: string;       // the function/class being used
  file: string;         // file where the usage was found
  line: number;
  snippet: string;      // the usage line (trimmed)
}

/**
 * Find how functions/classes are actually USED in the codebase.
 * Research shows API usage examples improve LLM output by 3x vs descriptions alone.
 * Instead of telling Claude what a function does, show it how the project calls it.
 */
export function findUsageExamples(
  extractions: FileExtraction[],
  maxExamplesPerSymbol: number = 3
): Map<string, UsageExample[]> {
  const examples = new Map<string, UsageExample[]>();

  // Build a set of all exported symbol names worth tracking
  const exportedSymbols = new Map<string, string>(); // name → defining file
  for (const ext of extractions) {
    for (const sym of ext.symbols) {
      if (sym.exported && (sym.kind === "function" || sym.kind === "class" || sym.kind === "method")) {
        const shortName = sym.name.split(".").pop()!;
        if (shortName.length > 2 && !isCommonName(shortName)) {
          exportedSymbols.set(shortName, ext.path);
        }
      }
    }
  }

  if (exportedSymbols.size === 0) return examples;

  // Scan files for usages of these symbols
  for (const ext of extractions) {
    // Only look in files that import something
    if (ext.imports.length === 0) continue;

    let content: string;
    try {
      content = readFileSync(ext.path, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");

    // What does this file import?
    const importedNames = new Set<string>();
    for (const imp of ext.imports) {
      for (const name of imp.names) {
        importedNames.add(name);
      }
    }

    // Find lines where imported symbols are called/used
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Skip imports, comments, empty lines
      if (!line || line.startsWith("import ") || line.startsWith("//") ||
          line.startsWith("/*") || line.startsWith("*") || line.startsWith("from ") ||
          line.startsWith("require(")) continue;

      for (const symName of importedNames) {
        if (!exportedSymbols.has(symName)) continue;

        // Check if this line calls/uses the symbol
        // Match: symName( or new SymName( or symName. or await symName(
        const callPattern = new RegExp(`\\b${escapeRegex(symName)}\\s*[.(]`);
        if (callPattern.test(line)) {
          if (!examples.has(symName)) examples.set(symName, []);
          const existing = examples.get(symName)!;

          if (existing.length < maxExamplesPerSymbol) {
            // Don't duplicate from same file
            if (!existing.some((e) => e.file === ext.path)) {
              existing.push({
                symbol: symName,
                file: ext.path,
                line: i + 1,
                snippet: line.slice(0, 120), // truncate long lines
              });
            }
          }
        }
      }
    }
  }

  return examples;
}

/**
 * Format usage examples for context injection.
 */
export function formatUsageExamples(
  examples: Map<string, UsageExample[]>,
  maxTotal: number = 20
): string {
  if (examples.size === 0) return "";

  const lines: string[] = [];
  let count = 0;

  // Sort by number of usages (most-used first)
  const sorted = [...examples.entries()]
    .sort((a, b) => b[1].length - a[1].length);

  for (const [symbol, usages] of sorted) {
    if (count >= maxTotal) break;

    for (const usage of usages) {
      if (count >= maxTotal) break;
      lines.push(`  ${symbol}: ${usage.snippet} (${basename(usage.file)}:${usage.line})`);
      count++;
    }
  }

  if (lines.length === 0) return "";
  return "Usage examples:\n" + lines.join("\n");
}

function isCommonName(name: string): boolean {
  const common = new Set([
    "get", "set", "map", "filter", "reduce", "find", "push", "pop",
    "log", "error", "warn", "info", "debug", "toString", "valueOf",
    "then", "catch", "finally", "resolve", "reject", "use", "run",
  ]);
  return common.has(name);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
