import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Look up test coverage for a source file: which test file covers it,
 * test names, and count. Use instead of Glob/Grep when you need to find
 * or run tests for a given source file.
 */
export function testMap(root: string, sourceFile?: string): CallToolResult {
  const mapPath = join(root, ".briefed", "test-map.json");
  if (!existsSync(mapPath)) {
    return { content: [{ type: "text", text: "No test map found. Run `briefed init` first." }] };
  }

  let map: Record<string, { test: string; count: number; names: string[] }>;
  try {
    map = JSON.parse(readFileSync(mapPath, "utf-8"));
  } catch {
    return { content: [{ type: "text", text: "Failed to read test map." }] };
  }

  if (sourceFile) {
    // Normalize: strip leading ./ and try both with and without extension
    const key = sourceFile.replace(/^\.\//, "");
    const entry = map[key] ?? map[key.replace(/\.[^.]+$/, "")] ?? null;
    if (!entry) {
      // Fuzzy: find entries whose source path contains the query
      const matches = Object.entries(map).filter(([k]) => k.includes(key));
      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No test mapping found for: ${sourceFile}` }] };
      }
      const lines = matches.map(([src, e]) =>
        `- \`${src}\` → \`${e.test}\` (${e.count} tests${e.names.length ? `: ${e.names.slice(0, 3).join(", ")}` : ""})`,
      );
      return { content: [{ type: "text", text: `Fuzzy matches for "${sourceFile}":\n\n${lines.join("\n")}` }] };
    }
    const names = entry.names.length ? `\n\nTest names:\n${entry.names.map((n) => `- ${n}`).join("\n")}` : "";
    return {
      content: [{
        type: "text",
        text: `**${sourceFile}**\nTest file: \`${entry.test}\`\nTest count: ${entry.count}${names}`,
      }],
    };
  }

  // List all mappings
  const lines = ["# Test map", "", `${Object.keys(map).length} source files with test coverage`, ""];
  for (const [src, entry] of Object.entries(map)) {
    lines.push(`- \`${src}\` → \`${entry.test}\` (${entry.count} tests)`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
