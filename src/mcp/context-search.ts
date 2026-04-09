import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

interface ModuleEntry {
  name: string;
  dir: string;
  files: string[];
  keywords: string[];
  complexity: number;
  file: string;
}

/**
 * briefed_context — on-demand module context retrieval.
 *
 * The hook injects context passively based on keyword overlap with the raw
 * user prompt. This tool lets the agent pull context actively mid-task, when
 * it has a clearer picture of what it needs. Same keyword index, agent-driven
 * instead of heuristic-driven.
 *
 * Returns the top matching module contracts (exports, dependencies, call graph)
 * up to a token budget. Call at task start to orient without reading files, or
 * mid-task when you realize you need context about a specific subsystem.
 */
export function contextSearch(root: string, query: string): CallToolResult {
  const indexPath = join(root, ".briefed", "index.json");
  const contractsDir = join(root, ".briefed", "contracts");

  if (!existsSync(indexPath)) {
    return {
      content: [{
        type: "text",
        text: "No briefed index found. Run `briefed init` first.",
      }],
    };
  }

  let index: { modules: ModuleEntry[] };
  try {
    index = JSON.parse(readFileSync(indexPath, "utf-8"));
  } catch {
    return { content: [{ type: "text", text: "Failed to read briefed index." }] };
  }

  // Extract meaningful terms from the query
  const stopWords = new Set([
    "the", "and", "for", "not", "are", "with", "from", "this", "that",
    "have", "will", "when", "does", "its", "was", "has", "can", "should",
    "would", "could", "into", "then", "than", "how", "why", "what", "where",
  ]);
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3 && !stopWords.has(t));

  if (terms.length === 0) {
    return { content: [{ type: "text", text: "No meaningful terms found in query." }] };
  }

  // Score each module by keyword hits
  const scored = index.modules
    .map(mod => {
      const hits = terms.filter(t => mod.keywords.some(k => k.includes(t) || t.includes(k)));
      return { mod, hits };
    })
    .filter(s => s.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length || b.mod.complexity - a.mod.complexity);

  if (scored.length === 0) {
    return {
      content: [{
        type: "text",
        text: `No modules matched query terms: ${terms.join(", ")}\n\nTry broader terms or use briefed_symbol / briefed_issue_candidates instead.`,
      }],
    };
  }

  // Budget: ~8K tokens worth of contracts
  const BUDGET = 12000;
  const output: string[] = [];
  const loaded: string[] = [];
  let used = 0;

  for (const { mod, hits } of scored) {
    if (used >= BUDGET) break;
    const contractPath = join(contractsDir, mod.file);
    if (!existsSync(contractPath)) continue;
    const contract = readFileSync(contractPath, "utf-8");
    if (used + contract.length > BUDGET) continue;
    output.push(`# ${mod.dir}  *(matched: ${hits.join(", ")})*\n${contract}`);
    used += contract.length;
    loaded.push(mod.dir);
  }

  if (output.length === 0) {
    return { content: [{ type: "text", text: "Matched modules found but contracts are missing. Re-run `briefed init`." }] };
  }

  const header = `# briefed context for: "${query.slice(0, 80)}"\n*Loaded ${loaded.length} module(s): ${loaded.join(", ")}*\n\n`;
  return {
    content: [{
      type: "text",
      text: header + output.join("\n---\n"),
    }],
  };
}
