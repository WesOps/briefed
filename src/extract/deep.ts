import { readFileSync } from "fs";
import { join, basename } from "path";
import { execSync } from "child_process";
import type { FileExtraction, Symbol } from "./signatures.js";
import type { DepGraph } from "./depgraph.js";
import type { ComplexityScore } from "./complexity.js";

/**
 * Deep analysis: use Claude to generate one-line behavioral descriptions
 * for important functions that lack JSDoc.
 *
 * Uses `claude -p` (subscription, $0 extra cost).
 * Only runs on the top N most-referenced files.
 */
export async function deepAnnotate(
  extractions: FileExtraction[],
  depGraph: DepGraph,
  complexity: ComplexityScore[],
  root: string,
  maxFiles: number = 15,
): Promise<Map<string, Map<string, string>>> {
  // Map<filePath, Map<symbolName, description>>
  const annotations = new Map<string, Map<string, string>>();

  // Rank files by importance (PageRank + refs)
  const ranked = extractions
    .filter(e => e.symbols.some(s => s.exported && !s.description))
    .map(e => ({
      extraction: e,
      score: (depGraph.pageRank.get(e.path) || 0) + (depGraph.refCounts.get(e.path) || 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles);

  if (ranked.length === 0) return annotations;

  // Build a single prompt with all files that need descriptions
  const fileSections: string[] = [];

  for (const { extraction } of ranked) {
    const fullPath = join(root, extraction.path);
    let content: string;
    try { content = readFileSync(fullPath, "utf-8"); } catch { continue; }

    // Only include functions that lack descriptions
    const needsDesc = extraction.symbols
      .filter(s => s.exported && !s.description && ["function", "method", "class"].includes(s.kind))
      .slice(0, 10);

    if (needsDesc.length === 0) continue;

    // Truncate file content to relevant parts (around each function)
    const relevantContent = extractRelevantLines(content, needsDesc);

    fileSections.push(
      `FILE: ${extraction.path}\n` +
      `SYMBOLS NEEDING DESCRIPTIONS: ${needsDesc.map(s => s.name).join(", ")}\n` +
      `CODE:\n${relevantContent}\n`
    );
  }

  if (fileSections.length === 0) return annotations;

  const prompt = `You are analyzing source code to generate one-line behavioral descriptions for exported functions.

For each function listed under SYMBOLS NEEDING DESCRIPTIONS, write a single short line (under 15 words) describing WHAT IT DOES and any important SIDE EFFECTS or CONSTRAINTS. Focus on behavior, not implementation.

Good examples:
- "creates draft invoice, validates project not archived, enforces one-draft-per-project"
- "transitions status draft→approved, requires different user than creator, emits webhook"
- "returns paginated results, filters soft-deleted, caches for 60s"
- "hashes password with bcrypt, 12 rounds, throws on empty input"

Bad examples (too vague):
- "handles the invoice logic"
- "processes the request"
- "main function for the service"

Reply in this exact format, one line per symbol, nothing else:
FILE_PATH:SYMBOL_NAME: description

${fileSections.join("\n---\n")}`;

  try {
    const claudePath = findClaudeCli();
    if (!claudePath) {
      console.log("  Claude CLI not found — skipping deep analysis");
      return annotations;
    }

    // Use child_process.spawn with stdin to avoid shell escaping issues
    const { execFileSync } = await import("child_process");
    const { writeFileSync: writeSync, unlinkSync, mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");

    // Write prompt to temp file, pass via --prompt-file or stdin
    const tmpDir = mkdtempSync(join(tmpdir(), "briefed-"));
    const promptFile = join(tmpDir, "prompt.txt");
    writeSync(promptFile, prompt);

    let result: string;
    try {
      result = execSync(
        `cat "${promptFile}" | ${claudePath} -p - --output-format text`,
        {
          encoding: "utf-8",
          timeout: 120_000,
          stdio: ["pipe", "pipe", "pipe"],
          cwd: root,
          shell: "/bin/sh",
        }
      ).trim();
    } finally {
      try { unlinkSync(promptFile); } catch {}
      try { unlinkSync(tmpDir); } catch {}
    }

    // Parse results
    for (const line of result.split("\n")) {
      const match = line.match(/^(.+?):(\w+):\s*(.+)$/);
      if (match) {
        const [, filePath, symbolName, description] = match;
        const cleanPath = filePath.trim();
        if (!annotations.has(cleanPath)) annotations.set(cleanPath, new Map());
        annotations.get(cleanPath)!.set(symbolName, description.trim());
      }
    }
  } catch (err: any) {
    console.log(`  Deep analysis failed: ${err.message?.split("\n")[0] || "unknown error"}`);
  }

  return annotations;
}

/**
 * Extract the relevant lines around each symbol (function body context).
 * Keeps the file content focused so we don't blow up the prompt.
 */
function extractRelevantLines(content: string, symbols: Symbol[]): string {
  const lines = content.split("\n");
  const ranges = new Set<number>();

  for (const sym of symbols) {
    // Include 30 lines starting from the function definition
    const start = Math.max(0, sym.line - 2);
    const end = Math.min(lines.length, sym.line + 30);
    for (let i = start; i < end; i++) {
      ranges.add(i);
    }
  }

  // Build output with line gaps indicated
  const sortedLines = [...ranges].sort((a, b) => a - b);
  const output: string[] = [];
  let lastLine = -2;

  for (const i of sortedLines) {
    if (i > lastLine + 1) output.push("...");
    output.push(lines[i]);
    lastLine = i;
  }

  // Cap at 200 lines
  if (output.length > 200) {
    return output.slice(0, 200).join("\n") + "\n... (truncated)";
  }

  return output.join("\n");
}

/**
 * Merge deep annotations into extractions (mutates in place).
 */
export function mergeAnnotations(
  extractions: FileExtraction[],
  annotations: Map<string, Map<string, string>>
): number {
  let count = 0;
  for (const ext of extractions) {
    const fileAnnotations = annotations.get(ext.path);
    if (!fileAnnotations) continue;

    for (const sym of ext.symbols) {
      const desc = fileAnnotations.get(sym.name);
      if (desc && !sym.description) {
        sym.description = desc;
        count++;
      }
    }
  }
  return count;
}

function findClaudeCli(): string | null {
  const candidates = [
    "claude",
    `${process.env.HOME || ""}/.npm-global/bin/claude`,
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];

  for (const candidate of candidates) {
    try {
      execSync(`${candidate} --version`, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: "/bin/sh",
        timeout: 5000,
      });
      return candidate;
    } catch { /* try next */ }
  }
  return null;
}

function escapeShellArg(arg: string): string {
  // Replace double quotes and limit length
  return arg.replace(/"/g, '\\"').slice(0, 15000);
}
