import { readFileSync, existsSync } from "fs";
import { join, basename } from "path";
import { loadCachedExtractions } from "./cached-loader.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Look up a symbol (function, class, type, etc.) and show:
 * - Signature + description
 * - File location
 * - Who imports it (callers)
 * - What it imports (callees/dependencies)
 * - Test coverage (from test-map.json)
 */
export function symbolLookup(root: string, name: string): CallToolResult {
  const { extractions, depGraph } = loadCachedExtractions(root);

  // Find all symbols matching the name (case-insensitive)
  const query = name.toLowerCase();
  const matches: Array<{
    name: string;
    kind: string;
    signature: string;
    description: string | null;
    file: string;
    line: number;
    exported: boolean;
    calls?: string[];
  }> = [];

  for (const ext of extractions) {
    for (const sym of ext.symbols) {
      if (sym.name.toLowerCase() === query || sym.name.toLowerCase().includes(query)) {
        matches.push({
          name: sym.name,
          kind: sym.kind,
          signature: sym.signature,
          description: sym.description,
          file: ext.path,
          line: sym.line,
          exported: sym.exported,
          calls: sym.calls,
        });
      }
    }
  }

  if (matches.length === 0) {
    // Suggest closest matches
    const allSymbols = extractions.flatMap((e) =>
      e.symbols.filter((s) => s.exported).map((s) => s.name)
    );
    const suggestions = allSymbols
      .filter((s) => s.toLowerCase().includes(query.slice(0, 3)))
      .slice(0, 10);

    return {
      content: [{
        type: "text",
        text: `No symbol found matching "${name}".${suggestions.length > 0 ? `\n\nDid you mean:\n${suggestions.map((s) => `- ${s}`).join("\n")}` : ""}`,
      }],
      isError: true,
    };
  }

  const lines: string[] = [];

  for (const match of matches.slice(0, 5)) {
    lines.push(`## ${match.kind} \`${match.name}\``);
    lines.push(`**File:** \`${match.file}:${match.line}\``);
    lines.push(`**Signature:** \`${match.signature}\``);
    if (match.description) {
      lines.push(`**Description:** ${match.description}`);
    }
    lines.push(`**Exported:** ${match.exported ? "yes" : "no (internal)"}`);
    if (match.calls && match.calls.length > 0) {
      lines.push(`**Calls:** ${match.calls.join(", ")}`);
    }
    lines.push("");

    // Symbol-level callers (who imports this symbol)
    const symKey = `${match.file}#${match.name}`;
    const callers = depGraph.symbolRefs.get(symKey) || [];
    if (callers.length > 0) {
      lines.push(`### Imported by (${callers.length} files)`);
      for (const caller of callers.slice(0, 20)) {
        lines.push(`- \`${caller}\``);
      }
      if (callers.length > 20) {
        lines.push(`- ... and ${callers.length - 20} more`);
      }
      lines.push("");
    } else if (match.exported) {
      lines.push("### Imported by: none (exported but unused)");
      lines.push("");
    }

    // What does this file import (callees/deps)
    const fileNode = depGraph.nodes.get(match.file);
    if (fileNode && fileNode.outEdges.length > 0) {
      lines.push(`### Dependencies (file-level)`);
      for (const dep of fileNode.outEdges) {
        lines.push(`- \`${dep}\``);
      }
      lines.push("");
    }

    // Test coverage from test-map.json
    const testMapPath = join(root, ".briefed", "test-map.json");
    if (existsSync(testMapPath)) {
      try {
        const testMap = JSON.parse(readFileSync(testMapPath, "utf-8"));
        const testInfo = testMap[match.file];
        if (testInfo) {
          lines.push(`### Test coverage`);
          lines.push(`**Test file:** \`${testInfo.test}\` (${testInfo.count} tests)`);
          if (testInfo.names && testInfo.names.length > 0) {
            lines.push(`**Key tests:** ${testInfo.names.slice(0, 8).join(", ")}`);
          }
          lines.push(`**Run:** \`npx vitest run ${testInfo.test}\``);
          lines.push("");
        } else {
          lines.push("### Test coverage: none found");
          lines.push("");
        }
      } catch {}
    }

    // PageRank importance
    const rank = depGraph.pageRank.get(match.file) || 0;
    const refs = depGraph.refCounts.get(match.file) || 0;
    if (rank > 0) {
      lines.push(`**Importance:** PageRank ${rank.toFixed(3)}, ${refs} files depend on \`${basename(match.file)}\``);
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  if (matches.length > 5) {
    lines.push(`*${matches.length - 5} more matches not shown.*`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
