import { loadCachedExtractions } from "./cached-loader.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Given an issue description, find the top candidate files using keyword
 * matching against symbol names, descriptions, and deep annotations.
 *
 * Strategy:
 * 1. Extract terms from the issue text (words 3+ chars, no stop words)
 * 2. Score each file by how many terms match its symbols and descriptions
 * 3. Return top 8 files with match details
 */
export function issueCandidates(root: string, issueText: string): CallToolResult {
  const { extractions, depGraph } = loadCachedExtractions(root);

  // Extract meaningful terms from issue text
  const stopWords = new Set(["the", "and", "for", "not", "are", "with", "from", "this", "that", "have", "will", "when", "does", "its", "was", "has", "can", "should", "would", "could", "into", "then", "than"]);
  const terms = issueText
    .toLowerCase()
    .replace(/[^a-z0-9\s_/-]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3 && !stopWords.has(t));

  if (terms.length === 0) {
    return { content: [{ type: "text", text: "No meaningful terms found in issue text." }] };
  }

  // Score each file
  const scores = new Map<string, { score: number; matches: string[] }>();

  for (const ext of extractions) {
    let score = 0;
    const matches: string[] = [];

    // Score per term per file: each term contributes once, weighted by whether
    // any matching symbol is exported. This prevents files with many symbols
    // from getting inflated scores just because a term appears in many symbols.
    for (const term of terms) {
      let termScore = 0;
      for (const sym of ext.symbols) {
        const haystack = [
          sym.name.toLowerCase(),
          sym.signature.toLowerCase(),
          sym.description?.toLowerCase() ?? "",
        ].join(" ");
        if (haystack.includes(term)) {
          termScore = Math.max(termScore, sym.exported ? 2 : 1);
        }
      }
      if (termScore > 0) {
        score += termScore;
        if (!matches.includes(term)) matches.push(term);
      }
    }

    // Also check file path itself
    const pathLower = ext.path.toLowerCase();
    for (const term of terms) {
      if (pathLower.includes(term)) {
        score += 1;
        if (!matches.includes(term)) matches.push(term);
      }
    }

    if (score > 0) {
      scores.set(ext.path, { score, matches });
    }
  }

  if (scores.size === 0) {
    return { content: [{ type: "text", text: `No files matched the terms: ${terms.slice(0, 10).join(", ")}` }] };
  }

  // Sort by score, take top 8
  const ranked = [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 8);

  const lines: string[] = [];
  lines.push(`# Issue candidates for: "${issueText.slice(0, 80)}${issueText.length > 80 ? "..." : ""}"`);
  lines.push(`*Matched terms: ${terms.slice(0, 10).join(", ")}*`);
  lines.push("");

  for (const [file, { score, matches }] of ranked) {
    const refs = depGraph.refCounts.get(file) || 0;
    lines.push(`## \`${file}\``);
    lines.push(`**Score:** ${score} | **Matched:** ${matches.join(", ")} | **Depended on by:** ${refs} files`);

    // Show top matching symbols
    const matchingSyms = extractions
      .find(e => e.path === file)
      ?.symbols.filter(s => {
        const h = [s.name, s.description ?? ""].join(" ").toLowerCase();
        return matches.some(m => h.includes(m));
      })
      .slice(0, 4) ?? [];

    for (const sym of matchingSyms) {
      lines.push(`- \`${sym.name}\`: ${sym.description ?? sym.signature}`);
    }
    lines.push("");
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
