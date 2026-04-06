import { loadCachedExtractions } from "./cached-loader.js";
import { extractRoutes } from "../extract/routes.js";
import { extractSchemas } from "../extract/schema.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * BFS over the dependency graph to find all files transitively affected
 * by changing a given file. Also cross-references affected files with
 * routes and schema models.
 */
export function blastRadius(root: string, file: string): CallToolResult {
  const { depGraph } = loadCachedExtractions(root);

  // Normalize the input file path
  const normalized = file.replace(/\\/g, "/");
  const node = depGraph.nodes.get(normalized);

  if (!node) {
    return {
      content: [{
        type: "text",
        text: `File "${file}" not found in dependency graph. Available files:\n${[...depGraph.nodes.keys()].slice(0, 20).join("\n")}${depGraph.nodes.size > 20 ? `\n... and ${depGraph.nodes.size - 20} more` : ""}`,
      }],
      isError: true,
    };
  }

  // BFS to find all transitive dependents (files affected by a change)
  const affected = new Set<string>();
  const queue = [normalized];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentNode = depGraph.nodes.get(current);
    if (!currentNode) continue;

    for (const dependent of currentNode.inEdges) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }

  // Cross-reference with routes
  const routes = extractRoutes(root);
  const affectedRoutes = routes.filter((r) =>
    r.file === normalized || affected.has(r.file)
  );

  // Cross-reference with schemas
  const schemas = extractSchemas(root);
  const affectedModels = schemas.filter((m) =>
    m.source === normalized || affected.has(m.source)
  );

  // Build result
  const lines: string[] = [];
  lines.push(`## Blast radius for \`${file}\``);
  lines.push(`**${affected.size} files affected** (transitive dependents)`);
  lines.push(`PageRank: ${(depGraph.pageRank.get(normalized) || 0).toFixed(3)} | Ref count: ${depGraph.refCounts.get(normalized) || 0}`);
  lines.push("");

  if (affected.size > 0) {
    // Sort by PageRank (most important files first)
    const sorted = [...affected].sort((a, b) =>
      (depGraph.pageRank.get(b) || 0) - (depGraph.pageRank.get(a) || 0)
    );
    lines.push("### Affected files (by importance)");
    for (const f of sorted) {
      const rank = (depGraph.pageRank.get(f) || 0).toFixed(3);
      lines.push(`- \`${f}\` (rank: ${rank})`);
    }
    lines.push("");
  }

  // Direct dependents vs transitive
  const direct = node.inEdges;
  const transitive = [...affected].filter((f) => !direct.includes(f));
  if (direct.length > 0) {
    lines.push(`### Direct dependents (${direct.length})`);
    for (const f of direct) lines.push(`- \`${f}\``);
    lines.push("");
  }
  if (transitive.length > 0) {
    lines.push(`### Transitive dependents (${transitive.length})`);
    for (const f of transitive) lines.push(`- \`${f}\``);
    lines.push("");
  }

  // Direct dependencies (what this file imports)
  if (node.outEdges.length > 0) {
    lines.push(`### Dependencies (${node.outEdges.length})`);
    for (const f of node.outEdges) lines.push(`- \`${f}\``);
    lines.push("");
  }

  if (affectedRoutes.length > 0) {
    lines.push(`### Affected API routes (${affectedRoutes.length})`);
    for (const r of affectedRoutes) {
      lines.push(`- ${r.method} ${r.path} → \`${r.file}\`${r.middleware.length > 0 ? ` [${r.middleware.join(", ")}]` : ""}`);
    }
    lines.push("");
  }

  if (affectedModels.length > 0) {
    lines.push(`### Affected schema models (${affectedModels.length})`);
    for (const m of affectedModels) {
      const fields = m.fields.map((f) => f.name).join(", ");
      lines.push(`- **${m.name}** (${fields}) → \`${m.source}\``);
    }
    lines.push("");
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
