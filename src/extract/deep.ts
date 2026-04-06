import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { debug } from "../utils/log.js";
import type { FileExtraction, Symbol } from "./signatures.js";
import type { DepGraph } from "./depgraph.js";

/**
 * Deep analysis: use `claude -p` (the user's Claude Code subscription, $0
 * marginal cost) to generate one-line behavioral descriptions for the most
 * important exported functions, plus a system overview paragraph.
 *
 * This is the only place briefed calls an LLM. Everything else is static.
 *
 * Key properties:
 *   - SHA256-keyed cache: only files whose symbol hash has changed get
 *     re-annotated. Re-runs are near-free after the first init.
 *   - Prioritized by PageRank + refCount: we annotate the load-bearing
 *     stuff first and stop when the budget is hit.
 *   - Graceful degradation: if `claude` isn't in PATH, we skip silently
 *     and the static skeleton still ships.
 *   - JSON output format: robust against Claude drifting on free-form text.
 */

export interface DeepResult {
  /** file path → (symbol name → one-line description) */
  annotations: Map<string, Map<string, string>>;
  /** Optional system overview paragraph for the top of CLAUDE.md. */
  systemOverview: string | null;
  /** How many symbols were freshly annotated (vs served from cache). */
  freshAnnotations: number;
  /** How many symbols were served from the cache. */
  cachedAnnotations: number;
  /** True if claude CLI was found and invoked. */
  ran: boolean;
}

interface DeepCacheEntry {
  /** Hash of (file content + symbol names) — invalidates on any relevant change. */
  hash: string;
  /** symbolName → description */
  annotations: Record<string, string>;
}

interface DeepCache {
  version: 1;
  files: Record<string, DeepCacheEntry>;
  overview: { hash: string; text: string } | null;
}

const CACHE_VERSION = 1;
const MAX_FILES_TO_ANNOTATE = 60; // top-N by importance
const BATCH_SIZE = 8; // files per claude call
const CLAUDE_TIMEOUT_MS = 120_000;

export async function runDeepAnalysis(
  extractions: FileExtraction[],
  depGraph: DepGraph,
  root: string,
): Promise<DeepResult> {
  const empty: DeepResult = {
    annotations: new Map(),
    systemOverview: null,
    freshAnnotations: 0,
    cachedAnnotations: 0,
    ran: false,
  };

  const claudePath = findClaudeCli();
  if (!claudePath) {
    console.log("  [deep] claude CLI not in PATH — skipping (static-only output)");
    return empty;
  }

  const cache = loadCache(root);
  const annotations = new Map<string, Map<string, string>>();
  let freshAnnotations = 0;
  let cachedAnnotations = 0;

  // Pick the files worth annotating: must have at least one undocumented
  // exported function/method/class, ranked by PageRank + refCount.
  const candidates = extractions
    .filter((e) =>
      e.symbols.some(
        (s) =>
          s.exported &&
          !s.description &&
          ["function", "method", "class", "component"].includes(s.kind),
      ),
    )
    .sort((a, b) => scoreFile(b, depGraph) - scoreFile(a, depGraph))
    .slice(0, MAX_FILES_TO_ANNOTATE);

  if (candidates.length === 0) {
    console.log("  [deep] nothing to annotate (all exported symbols already documented)");
    return { ...empty, ran: true };
  }

  // Split into cache-hit vs cache-miss
  const misses: FileExtraction[] = [];
  for (const ext of candidates) {
    const content = safeRead(join(root, ext.path));
    if (!content) continue;
    const hash = hashFileForCache(content, ext.symbols);
    const cached = cache.files[ext.path];
    if (cached && cached.hash === hash) {
      const map = new Map<string, string>();
      for (const [name, desc] of Object.entries(cached.annotations)) {
        map.set(name, desc);
        cachedAnnotations++;
      }
      annotations.set(ext.path, map);
    } else {
      misses.push(ext);
    }
  }

  if (misses.length === 0) {
    console.log(`  [deep] ${cachedAnnotations} annotations served from cache`);
  } else {
    console.log(
      `  [deep] annotating ${misses.length} files (${cachedAnnotations} cached)...`,
    );
  }

  // Batch-annotate the misses
  for (let i = 0; i < misses.length; i += BATCH_SIZE) {
    const batch = misses.slice(i, i + BATCH_SIZE);
    const prompt = buildBatchPrompt(batch, root);
    if (!prompt) continue;

    const raw = runClaudeJson(claudePath, prompt, root);
    if (!raw) continue;

    const parsed = parseBatchResponse(raw);
    for (const ext of batch) {
      const fileAnnotations = parsed.get(ext.path) || new Map<string, string>();
      if (fileAnnotations.size === 0) continue;

      // Merge into the live map
      const existing = annotations.get(ext.path) || new Map();
      for (const [name, desc] of fileAnnotations) {
        existing.set(name, desc);
        freshAnnotations++;
      }
      annotations.set(ext.path, existing);

      // Update cache entry
      const content = safeRead(join(root, ext.path));
      if (content) {
        cache.files[ext.path] = {
          hash: hashFileForCache(content, ext.symbols),
          annotations: Object.fromEntries(existing),
        };
      }
    }
  }

  // System overview — one more call, cached by hash of the candidate list
  const overviewHash = hashString(
    candidates.map((e) => e.path).sort().join("\n"),
  );
  let systemOverview: string | null = null;
  if (cache.overview && cache.overview.hash === overviewHash) {
    systemOverview = cache.overview.text;
    console.log("  [deep] system overview served from cache");
  } else {
    systemOverview = await generateSystemOverview(
      claudePath,
      extractions,
      annotations,
      root,
    );
    if (systemOverview) {
      cache.overview = { hash: overviewHash, text: systemOverview };
    }
  }

  saveCache(root, cache);

  console.log(
    `  [deep] ${freshAnnotations} fresh + ${cachedAnnotations} cached annotations`,
  );

  return {
    annotations,
    systemOverview,
    freshAnnotations,
    cachedAnnotations,
    ran: true,
  };
}

/**
 * Build per-directory rule files that Claude Code loads only when it
 * touches files in that directory. This is how the original `--deep`
 * shipped in v0.3.0: path-scoped, not always-loaded.
 *
 * Returns: Map<filename, file content>. Caller writes these into
 * .claude/rules/.
 */
export function buildDeepRules(
  extractions: FileExtraction[],
  annotations: Map<string, Map<string, string>>,
): Map<string, string> {
  const rules = new Map<string, string>();

  // Group annotated files by directory
  type FileEntry = {
    file: string;
    symbols: Array<{ name: string; sig: string; desc: string }>;
  };
  const byDir = new Map<string, FileEntry[]>();

  for (const ext of extractions) {
    const fileAnns = annotations.get(ext.path);
    if (!fileAnns || fileAnns.size === 0) continue;

    const dir = dirname(ext.path);
    if (!byDir.has(dir)) byDir.set(dir, []);

    const syms: FileEntry["symbols"] = [];
    for (const sym of ext.symbols) {
      const desc = fileAnns.get(sym.name);
      if (desc) {
        syms.push({ name: sym.name, sig: sym.signature, desc });
      }
    }
    if (syms.length > 0) {
      byDir.get(dir)!.push({ file: ext.path, symbols: syms });
    }
  }

  for (const [dir, files] of byDir) {
    const safeDir = dir.replace(/[\/\\]/g, "-").replace(/^-/, "") || "root";
    const fileName = `briefed-deep-${safeDir}.md`;

    const lines: string[] = [];
    lines.push("---");
    lines.push("paths:");
    lines.push(`  - "${dir}/**"`);
    lines.push("---");
    lines.push("");
    lines.push(`# ${dir}/ — behavioral context`);
    lines.push("");
    for (const entry of files) {
      const fname = entry.file.split("/").pop() || entry.file;
      lines.push(`## ${fname}`);
      for (const sym of entry.symbols) {
        lines.push(`- **${sym.name}**: ${sym.desc}`);
      }
      lines.push("");
    }

    rules.set(fileName, lines.join("\n"));
  }

  return rules;
}

/**
 * Merge deep annotations into the extraction symbols. Only used when we
 * want the descriptions surfaced in the always-loaded skeleton — which is
 * NOT the default. The preferred delivery is path-scoped rules via
 * buildDeepRules.
 */
export function mergeDeepAnnotations(
  extractions: FileExtraction[],
  annotations: Map<string, Map<string, string>>,
): number {
  let count = 0;
  for (const ext of extractions) {
    const fileMap = annotations.get(ext.path);
    if (!fileMap) continue;
    for (const sym of ext.symbols) {
      if (sym.description) continue;
      const desc = fileMap.get(sym.name);
      if (desc) {
        sym.description = desc;
        count++;
      }
    }
  }
  return count;
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function scoreFile(ext: FileExtraction, depGraph: DepGraph): number {
  return (depGraph.pageRank.get(ext.path) || 0) + (depGraph.refCounts.get(ext.path) || 0);
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function hashFileForCache(content: string, symbols: Symbol[]): string {
  // Hash file content + the set of exported symbol names. If either
  // changes, we re-annotate.
  const names = symbols
    .filter((s) => s.exported)
    .map((s) => s.name)
    .sort()
    .join(",");
  return hashString(content + "\u0000" + names);
}

function buildBatchPrompt(batch: FileExtraction[], root: string): string | null {
  const sections: string[] = [];
  for (const ext of batch) {
    const content = safeRead(join(root, ext.path));
    if (!content) continue;

    const needsDesc = ext.symbols.filter(
      (s) =>
        s.exported &&
        !s.description &&
        ["function", "method", "class", "component"].includes(s.kind),
    );
    if (needsDesc.length === 0) continue;

    const relevant = sliceRelevantLines(content, needsDesc);
    sections.push(
      `FILE: ${ext.path}\nSYMBOLS: ${needsDesc.map((s) => s.name).join(", ")}\nCODE:\n${relevant}`,
    );
  }

  if (sections.length === 0) return null;

  return `Analyze these source files. For each listed symbol, write ONE short behavioral description (max 14 words).

Focus on: WHAT it does, SIDE EFFECTS (DB writes, events, I/O, mutations), and CONSTRAINTS (guards, required state, throws).

Good: "creates draft invoice, validates project active, emits InvoiceCreated"
Good: "hashes password with bcrypt 12 rounds, throws on empty input"
Bad: "handles invoice logic" (too vague)
Bad: "main service function" (says nothing)

Respond with a JSON object mapping "filepath::symbolName" to the description string. No prose, no markdown, just the JSON object on a single line or pretty-printed. Example:

{"src/foo.ts::createInvoice": "creates draft invoice, validates project active, emits InvoiceCreated", "src/foo.ts::deleteInvoice": "soft-deletes invoice, requires admin role, emits InvoiceDeleted"}

${sections.join("\n---\n")}`;
}

function sliceRelevantLines(content: string, symbols: Symbol[]): string {
  const lines = content.split("\n");
  const keep = new Set<number>();
  for (const sym of symbols) {
    const start = Math.max(0, sym.line - 2);
    const end = Math.min(lines.length, sym.line + 25);
    for (let i = start; i < end; i++) keep.add(i);
  }
  const sorted = [...keep].sort((a, b) => a - b);
  const out: string[] = [];
  let last = -2;
  for (const i of sorted) {
    if (i > last + 1) out.push("...");
    out.push(lines[i]);
    last = i;
  }
  return out.length > 180 ? out.slice(0, 180).join("\n") + "\n..." : out.join("\n");
}

function runClaudeJson(claudePath: string, prompt: string, cwd: string): string | null {
  try {
    const result = spawnSync(
      claudePath,
      ["-p", "-", "--output-format", "text"],
      {
        input: prompt,
        encoding: "utf-8",
        timeout: CLAUDE_TIMEOUT_MS,
        cwd,
        shell: false,
      },
    );
    if (result.error) {
      debug(`deep: claude spawn error: ${result.error.message}`);
      return null;
    }
    if (result.status !== 0) {
      debug(`deep: claude exited ${result.status}: ${result.stderr?.slice(0, 200)}`);
      return null;
    }
    return (result.stdout || "").trim();
  } catch (e) {
    debug(`deep: runClaude threw: ${(e as Error).message}`);
    return null;
  }
}

function parseBatchResponse(raw: string): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();

  // Claude sometimes wraps JSON in ```json ... ``` fences. Strip them.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    // Fall back: try to extract a JSON object from the response
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return result;
    try {
      obj = JSON.parse(match[0]);
    } catch {
      return result;
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== "string") continue;
    const sep = key.indexOf("::");
    if (sep === -1) continue;
    const file = key.slice(0, sep);
    const name = key.slice(sep + 2);
    if (!result.has(file)) result.set(file, new Map());
    result.get(file)!.set(name, value.trim());
  }
  return result;
}

async function generateSystemOverview(
  claudePath: string,
  extractions: FileExtraction[],
  annotations: Map<string, Map<string, string>>,
  root: string,
): Promise<string | null> {
  // Build a compact summary: group by top-level directory and list
  // annotated symbols where we have them, plain exports otherwise.
  const byDir = new Map<string, string[]>();
  for (const ext of extractions) {
    const parts = ext.path.split("/");
    const topDir = parts.slice(0, 2).join("/");
    if (!byDir.has(topDir)) byDir.set(topDir, []);

    const fileAnns = annotations.get(ext.path);
    if (fileAnns && fileAnns.size > 0) {
      const descs = [...fileAnns.entries()]
        .slice(0, 4)
        .map(([n, d]) => `${n}: ${d}`)
        .join("; ");
      byDir.get(topDir)!.push(`${ext.path} — ${descs}`);
    } else {
      const exps = ext.symbols
        .filter((s) => s.exported)
        .slice(0, 4)
        .map((s) => s.name)
        .join(", ");
      if (exps) byDir.get(topDir)!.push(`${ext.path}: exports ${exps}`);
    }
  }

  const sections: string[] = [];
  for (const [dir, files] of byDir) {
    sections.push(`${dir}/:\n${files.slice(0, 6).join("\n")}`);
  }

  const prompt = `Write a concise SYSTEM OVERVIEW (5-8 lines) for this codebase describing:
1. What the application does (one sentence)
2. How the main modules connect — data flow, which calls which
3. Key architectural patterns specific to THIS codebase (e.g. "CLI → extraction pipeline → skeleton writer")

Rules: plain text paragraph, no markdown headers, no bullets, no generic advice, no filler phrases like "this codebase". Be specific.

MODULES:
${sections.join("\n\n")}`;

  const raw = runClaudeJson(claudePath, prompt, root);
  if (!raw) return null;

  return raw
    .replace(/^#+\s*/gm, "")
    .replace(/^\*\*/gm, "")
    .trim();
}

function loadCache(root: string): DeepCache {
  const cachePath = join(root, ".briefed", "deep-cache.json");
  if (!existsSync(cachePath)) {
    return { version: CACHE_VERSION, files: {}, overview: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (parsed.version !== CACHE_VERSION) {
      return { version: CACHE_VERSION, files: {}, overview: null };
    }
    return parsed;
  } catch {
    return { version: CACHE_VERSION, files: {}, overview: null };
  }
}

function saveCache(root: string, cache: DeepCache): void {
  const dir = join(root, ".briefed");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "deep-cache.json");
  try {
    writeFileSync(path, JSON.stringify(cache, null, 2));
  } catch (e) {
    debug(`deep: failed to save cache: ${(e as Error).message}`);
  }
}

function findClaudeCli(): string | null {
  const candidates = [
    "claude",
    `${process.env.HOME || ""}/.npm-global/bin/claude`,
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    `${process.env.APPDATA || ""}/npm/claude.cmd`,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate, ["--version"], {
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      if (result.status === 0) return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Exposed for tests. */
export const __test = {
  hashFileForCache,
  parseBatchResponse,
  sliceRelevantLines,
  scoreFile,
};

