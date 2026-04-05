import { readFileSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";
import type { FileExtraction, Symbol } from "./signatures.js";
import type { DepGraph } from "./depgraph.js";
import type { ComplexityScore } from "./complexity.js";

/**
 * Deep analysis: use Claude to generate one-line behavioral descriptions
 * for ALL exported functions, grouped by directory.
 *
 * Uses `claude -p` (subscription, $0 extra cost).
 * Sends files in batches to stay within prompt limits.
 * Returns descriptions keyed by file path → symbol name.
 */
export async function deepAnnotate(
  extractions: FileExtraction[],
  depGraph: DepGraph,
  complexity: ComplexityScore[],
  root: string,
): Promise<Map<string, Map<string, string>>> {
  const annotations = new Map<string, Map<string, string>>();

  const claudePath = findClaudeCli();
  if (!claudePath) {
    console.log("  Claude CLI not found — install Claude Code first");
    return annotations;
  }

  // Collect all files that have exported functions without descriptions
  const filesNeedingDesc = extractions
    .filter(e => e.symbols.some(s => s.exported && !s.description &&
      ["function", "method", "class", "component"].includes(s.kind)))
    .sort((a, b) => {
      const aScore = (depGraph.pageRank.get(a.path) || 0) + (depGraph.refCounts.get(a.path) || 0);
      const bScore = (depGraph.pageRank.get(b.path) || 0) + (depGraph.refCounts.get(b.path) || 0);
      return bScore - aScore;
    });

  if (filesNeedingDesc.length === 0) return annotations;

  // Batch files — ~10 files per Claude call to stay within prompt limits
  const BATCH_SIZE = 10;
  const batches: FileExtraction[][] = [];
  for (let i = 0; i < filesNeedingDesc.length; i += BATCH_SIZE) {
    batches.push(filesNeedingDesc.slice(i, i + BATCH_SIZE));
  }

  console.log(`  ${filesNeedingDesc.length} files to analyze in ${batches.length} batch${batches.length > 1 ? "es" : ""}...`);

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    if (batches.length > 1) {
      process.stdout.write(`  Batch ${batchIdx + 1}/${batches.length}...`);
    }

    const fileSections: string[] = [];
    for (const extraction of batch) {
      const fullPath = join(root, extraction.path);
      let content: string;
      try { content = readFileSync(fullPath, "utf-8"); } catch { continue; }

      const needsDesc = extraction.symbols
        .filter(s => s.exported && !s.description &&
          ["function", "method", "class", "component"].includes(s.kind));

      if (needsDesc.length === 0) continue;

      const relevantContent = extractRelevantLines(content, needsDesc);
      fileSections.push(
        `FILE: ${extraction.path}\n` +
        `SYMBOLS: ${needsDesc.map(s => s.name).join(", ")}\n` +
        `CODE:\n${relevantContent}\n`
      );
    }

    if (fileSections.length === 0) continue;

    const prompt = `Analyze these source files and describe each listed function in ONE short line (max 12 words).

Focus on: WHAT it does, SIDE EFFECTS (emits events, writes DB, sends email), and CONSTRAINTS (validation, guards, required state).

Good: "creates draft invoice, validates project active, emits InvoiceCreated"
Good: "hashes password with bcrypt 12 rounds, throws on empty"
Good: "returns paginated users, filters soft-deleted, requires admin role"
Bad: "handles invoice logic" (too vague)
Bad: "main service function" (says nothing)

Reply ONLY in this format, one line per symbol, no other text:
FILE_PATH:SYMBOL_NAME: description

${fileSections.join("\n---\n")}`;

    try {
      const result = await runClaude(claudePath, prompt, root);
      let batchCount = 0;

      for (const line of result.split("\n")) {
        const match = line.match(/^(.+?):(\w+):\s*(.+)$/);
        if (match) {
          const [, filePath, symbolName, description] = match;
          const cleanPath = filePath.trim();
          if (!annotations.has(cleanPath)) annotations.set(cleanPath, new Map());
          annotations.get(cleanPath)!.set(symbolName, description.trim());
          batchCount++;
        }
      }

      if (batches.length > 1) {
        console.log(` ${batchCount} descriptions`);
      }
    } catch (err: any) {
      if (batches.length > 1) console.log(" failed");
      console.log(`  Batch ${batchIdx + 1} error: ${err.message?.split("\n")[0] || "unknown"}`);
    }
  }

  return annotations;
}

async function runClaude(claudePath: string, prompt: string, cwd: string): Promise<string> {
  const { spawnSync } = await import("child_process");

  const result = spawnSync(claudePath, ["-p", "-", "--output-format", "text"], {
    input: prompt,
    encoding: "utf-8",
    timeout: 120_000,
    cwd,
    shell: true,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `claude exited with ${result.status}`);
  return (result.stdout || "").trim();
}

/**
 * Extract the relevant lines around each symbol (function body context).
 */
function extractRelevantLines(content: string, symbols: Symbol[]): string {
  const lines = content.split("\n");
  const ranges = new Set<number>();

  for (const sym of symbols) {
    const start = Math.max(0, sym.line - 2);
    const end = Math.min(lines.length, sym.line + 30);
    for (let i = start; i < end; i++) ranges.add(i);
  }

  const sortedLines = [...ranges].sort((a, b) => a - b);
  const output: string[] = [];
  let lastLine = -2;

  for (const i of sortedLines) {
    if (i > lastLine + 1) output.push("...");
    output.push(lines[i]);
    lastLine = i;
  }

  return output.length > 200
    ? output.slice(0, 200).join("\n") + "\n..."
    : output.join("\n");
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

/**
 * Generate .claude/rules/ files with behavioral descriptions per directory.
 * These are path-scoped — only loaded when Claude touches files in that directory.
 */
export function generateDeepRules(
  extractions: FileExtraction[],
  annotations: Map<string, Map<string, string>>,
): Map<string, string> {
  const rules = new Map<string, string>();

  // Group annotated files by directory
  const byDir = new Map<string, Array<{ file: string; symbols: Array<{ name: string; sig: string; desc: string }> }>>();

  for (const ext of extractions) {
    const fileAnnotations = annotations.get(ext.path);
    if (!fileAnnotations || fileAnnotations.size === 0) continue;

    const dir = dirname(ext.path);
    if (!byDir.has(dir)) byDir.set(dir, []);

    const symbols: Array<{ name: string; sig: string; desc: string }> = [];
    for (const sym of ext.symbols) {
      const desc = fileAnnotations.get(sym.name);
      if (desc) {
        symbols.push({
          name: sym.name,
          sig: sym.signature,
          desc,
        });
      }
    }

    if (symbols.length > 0) {
      byDir.get(dir)!.push({ file: ext.path, symbols });
    }
  }

  // Generate a rule file per directory
  for (const [dir, files] of byDir) {
    const safeDir = dir.replace(/[\/\\]/g, "-").replace(/^-/, "");
    const fileName = `briefed-deep-${safeDir || "root"}.md`;

    const lines: string[] = [
      "---",
      `paths:`,
      `  - "${dir}/**"`,
      "---",
      "",
      `# ${dir}/ — behavioral context`,
      "",
    ];

    for (const file of files) {
      const fname = file.file.split("/").pop() || file.file;
      lines.push(`## ${fname}`);
      for (const sym of file.symbols) {
        lines.push(`- **${sym.name}**: ${sym.desc}`);
      }
      lines.push("");
    }

    rules.set(fileName, lines.join("\n"));
  }

  return rules;
}

/**
 * Generate a high-level system overview — how modules connect and data flows.
 * This goes into CLAUDE.md so Claude always has the big picture.
 */
export async function generateSystemOverview(
  extractions: FileExtraction[],
  depGraph: DepGraph,
  root: string,
  annotations: Map<string, Map<string, string>>,
): Promise<string | null> {
  const claudePath = findClaudeCli();
  if (!claudePath) return null;

  // Build a summary of what we know about the system
  const modulesSummary: string[] = [];

  // Group by top-level directory
  const byTopDir = new Map<string, string[]>();
  for (const ext of extractions) {
    const topDir = ext.path.split("/").slice(0, 2).join("/");
    if (!byTopDir.has(topDir)) byTopDir.set(topDir, []);

    const fileAnnotations = annotations.get(ext.path);
    if (fileAnnotations && fileAnnotations.size > 0) {
      const descs = [...fileAnnotations.entries()]
        .map(([name, desc]) => `${name}: ${desc}`)
        .join("; ");
      byTopDir.get(topDir)!.push(`${ext.path}: ${descs}`);
    } else {
      const exports = ext.symbols.filter(s => s.exported).map(s => s.name).join(", ");
      if (exports) byTopDir.get(topDir)!.push(`${ext.path}: exports ${exports}`);
    }
  }

  for (const [dir, files] of byTopDir) {
    modulesSummary.push(`${dir}/:\n${files.slice(0, 5).join("\n")}`);
  }

  const prompt = `Based on these modules and their functions, write a concise SYSTEM OVERVIEW (5-10 lines max) describing:
1. What this application does (one sentence)
2. How the main modules connect (data flow, which calls which)
3. Key architectural patterns (e.g. "tRPC routes → services → Prisma → PostgreSQL")

Be specific to THIS codebase. No generic advice. No bullet points. Just dense, useful prose.

Format: plain text, no markdown headers, no bullets. Just a paragraph.

MODULES:
${modulesSummary.join("\n\n")}`;

  try {
    const result = await runClaude(claudePath, prompt, root);
    // Clean up — remove any markdown formatting Claude might add
    return result
      .replace(/^#+\s*/gm, "")
      .replace(/^\*\*/gm, "")
      .trim();
  } catch {
    return null;
  }
}

function findClaudeCli(): string | null {
  const candidates = [
    "claude",
    `${process.env.HOME || ""}/.npm-global/bin/claude`,
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    `${process.env.APPDATA || ""}/npm/claude.cmd`,
  ];

  for (const candidate of candidates) {
    try {
      execSync(`${candidate} --version`, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
        timeout: 5000,
      });
      return candidate;
    } catch { /* try next */ }
  }
  return null;
}
