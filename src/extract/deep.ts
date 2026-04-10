import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, basename } from "path";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { debug } from "../utils/log.js";
import { computePersonalizedPageRank } from "../utils/pagerank.js";
import type { FileExtraction, Symbol } from "./signatures.js";
import type { DepGraph } from "./depgraph.js";
import type { ComplexityScore } from "./complexity.js";
import type { TestMapping } from "./tests.js";

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
  /** file path → (symbol name → danger zone description) */
  dangerZones: Map<string, Map<string, string>>;
  /** Optional system overview paragraph for the top of CLAUDE.md. */
  systemOverview: string | null;
  /**
   * directory path → one-sentence boundary description.
   * e.g. "Handles runtime execution of compiled output. For compilation
   * bugs, look in src/compiler/ instead."
   */
  directoryBoundaries: Map<string, string>;
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
  /** symbolName → danger zone description */
  dangerZones?: Record<string, string>;
}

interface DeepCache {
  version: 1;
  files: Record<string, DeepCacheEntry>;
  overview: { hash: string; text: string } | null;
  boundaries: { hash: string; dirs: Record<string, string> } | null;
}

const CACHE_VERSION = 1;
const BATCH_SIZE = 8; // files per claude call

interface GitSignals {
  /** Number of commits touching this file in the last 12 months. */
  commits: number;
  /** Number of distinct authors with < 5% of this file's commits (diffuse ownership). */
  minorAuthors: number;
}

/**
 * Pull per-file git signals for blended scoring.
 * One `git log` pass over the last 12 months. Gracefully returns empty map
 * if the directory isn't a git repo or git isn't available.
 */
function getGitSignals(root: string): Map<string, GitSignals> {
  const result = new Map<string, GitSignals>();
  try {
    const since = new Date();
    since.setMonth(since.getMonth() - 12);
    const sinceStr = since.toISOString().split("T")[0];

    const out = spawnSync(
      "git",
      ["log", "--name-only", `--format=COMMIT:%ae`, `--since=${sinceStr}`, "--diff-filter=ACMR"],
      { cwd: root, encoding: "utf-8", timeout: 10_000, shell: false },
    );
    if (out.status !== 0 || !out.stdout) return result;

    // Build file → list of author emails from commits
    const fileAuthors = new Map<string, string[]>();
    let currentAuthor = "";
    for (const line of out.stdout.split("\n")) {
      if (line.startsWith("COMMIT:")) {
        currentAuthor = line.slice(7).trim();
      } else if (line.trim() && currentAuthor) {
        const rel = line.trim();
        if (!fileAuthors.has(rel)) fileAuthors.set(rel, []);
        fileAuthors.get(rel)!.push(currentAuthor);
      }
    }

    for (const [file, authors] of fileAuthors) {
      const total = authors.length;
      const authorCounts = new Map<string, number>();
      for (const a of authors) authorCounts.set(a, (authorCounts.get(a) || 0) + 1);
      const threshold = total * 0.05;
      const minorAuthors = [...authorCounts.values()].filter((c) => c < threshold).length;
      result.set(file, { commits: total, minorAuthors });
    }
  } catch {
    // not a git repo or git unavailable — skip silently
  }
  return result;
}

/** Dynamic annotation cap: 15% of total source files, floored at 60, capped at 200. */
function maxFilesToAnnotate(totalFiles: number): number {
  return Math.min(Math.max(60, Math.ceil(totalFiles * 0.15)), 200);
}
const CLAUDE_TIMEOUT_MS = 120_000;

export async function runDeepAnalysis(
  extractions: FileExtraction[],
  depGraph: DepGraph,
  root: string,
  complexityScores: ComplexityScore[] = [],
  testMappings: TestMapping[] = [],
): Promise<DeepResult> {
  const empty: DeepResult = {
    annotations: new Map(),
    dangerZones: new Map(),
    systemOverview: null,
    directoryBoundaries: new Map(),
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
  const allDangerZones = new Map<string, Map<string, string>>();
  let freshAnnotations = 0;
  let cachedAnnotations = 0;

  // Build lookup maps for blended scoring
  const complexityMap = new Map(complexityScores.map((c) => [c.file, c]));
  const testedFiles = new Set(testMappings.map((t) => t.sourceFile));
  const gitSignals = getGitSignals(root);

  // Personalized PageRank seeded from entrypoints (routes, CLI, schema, public API roots).
  // This concentrates rank on files reachable from what users actually invoke,
  // rather than the globally most-imported files (which are often utilities).
  const entrypointSeeds = buildEntrypointSeeds(extractions, depGraph);
  const personalizedRank = computePersonalizedPageRank(
    depGraph.nodes,
    entrypointSeeds,
  );

  // Pick the files worth annotating: must have at least one undocumented
  // exported function/method/class, ranked by blended importance score.
  const candidates = extractions
    .filter((e) =>
      e.symbols.some(
        (s) =>
          s.exported &&
          !s.description &&
          ["function", "method", "class", "component"].includes(s.kind),
      ),
    )
    .sort((a, b) =>
      scoreFile(b, depGraph, complexityMap, gitSignals, testedFiles, personalizedRank) -
      scoreFile(a, depGraph, complexityMap, gitSignals, testedFiles, personalizedRank)
    )
    .slice(0, maxFilesToAnnotate(extractions.length));

  // Build score map for tier-aware prompting. Candidates are sorted
  // descending so rank position directly encodes importance.
  const scoreMap = new Map<string, number>();
  for (const ext of candidates) {
    scoreMap.set(ext.path, scoreFile(ext, depGraph, complexityMap, gitSignals, testedFiles, personalizedRank));
  }
  // Thresholds: top 20% = critical, bottom 20% = peripheral, rest = normal.
  const sortedScores = [...scoreMap.values()].sort((a, b) => b - a);
  const criticalCutoff = sortedScores[Math.floor(sortedScores.length * 0.2)] ?? 0;
  const peripheralCutoff = sortedScores[Math.floor(sortedScores.length * 0.8)] ?? 0;

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
      if (cached.dangerZones) {
        const dangerMap = new Map<string, string>();
        for (const [name, danger] of Object.entries(cached.dangerZones)) {
          dangerMap.set(name, danger);
        }
        allDangerZones.set(ext.path, dangerMap);
      }
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
    const prompt = buildBatchPrompt(batch, root, scoreMap, criticalCutoff, peripheralCutoff, depGraph, testMappings);
    if (!prompt) continue;

    // Use Sonnet for batches that contain critical-tier files (top 20% by score)
    // — those are the complex, high-fanin files where bugs actually live and where
    // a precise 22-word description is meaningfully better than a vague one.
    // Peripheral and normal files use Haiku; annotations are cached so cost is one-time.
    const hasCritical = criticalCutoff !== undefined &&
      batch.some(ext => (scoreMap?.get(ext.path) ?? 0) >= criticalCutoff);
    const annotationModel = hasCritical ? "sonnet" : "haiku";

    const raw = runClaudeJson(claudePath, prompt, root, annotationModel);
    if (!raw) continue;

    const { descriptions: parsed, dangerZones: batchDangers } = parseBatchResponse(raw);
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

      // Merge danger zones
      const fileDangers = batchDangers.get(ext.path);
      if (fileDangers && fileDangers.size > 0) {
        const existingDangers = allDangerZones.get(ext.path) || new Map();
        for (const [name, danger] of fileDangers) {
          existingDangers.set(name, danger);
        }
        allDangerZones.set(ext.path, existingDangers);
        if (cache.files[ext.path]) {
          cache.files[ext.path].dangerZones = Object.fromEntries(existingDangers);
        }
      }

      // Update cache entry
      const content = safeRead(join(root, ext.path));
      if (content) {
        cache.files[ext.path] = {
          hash: hashFileForCache(content, ext.symbols),
          annotations: Object.fromEntries(existing),
          ...(allDangerZones.has(ext.path) && {
            dangerZones: Object.fromEntries(allDangerZones.get(ext.path)!),
          }),
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

  // Directory boundary descriptions — one haiku call, cached by dir list hash
  const boundariesHash = hashString(
    [...annotations.keys()].sort().join("\n"),
  );
  let directoryBoundaries = new Map<string, string>();
  if (cache.boundaries && cache.boundaries.hash === boundariesHash) {
    directoryBoundaries = new Map(Object.entries(cache.boundaries.dirs));
  } else {
    directoryBoundaries = await generateDirectoryBoundaries(claudePath, annotations, root);
    if (directoryBoundaries.size > 0) {
      cache.boundaries = {
        hash: boundariesHash,
        dirs: Object.fromEntries(directoryBoundaries),
      };
    }
  }

  saveCache(root, cache);

  console.log(
    `  [deep] ${freshAnnotations} fresh + ${cachedAnnotations} cached annotations`,
  );

  return {
    annotations,
    dangerZones: allDangerZones,
    systemOverview,
    directoryBoundaries,
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
  directoryBoundaries: Map<string, string> = new Map(),
  testMappings: TestMapping[] = [],
  depGraph?: DepGraph,
  dangerZones: Map<string, Map<string, string>> = new Map(),
): Map<string, string> {
  const rules = new Map<string, string>();

  // Map source file path → test names
  const testNamesByFile = new Map<string, string[]>();
  for (const tm of testMappings) {
    if (tm.testNames.length > 0) {
      testNamesByFile.set(tm.sourceFile, tm.testNames.slice(0, 5));
    }
  }

  // Map source file path → test assertions (test name → assertion strings)
  const testAssertionsByFile = new Map<string, Map<string, string[]>>();
  for (const tm of testMappings) {
    if (tm.assertions && tm.assertions.size > 0) {
      testAssertionsByFile.set(tm.sourceFile, tm.assertions);
    }
  }

  // Map "file#symbolName" → list of caller file paths (top 3)
  const callersBySymbol = new Map<string, string[]>();
  if (depGraph) {
    for (const [key, callers] of depGraph.symbolRefs) {
      callersBySymbol.set(key, callers.slice(0, 3));
    }
  }

  // Group annotated files by directory
  type FileEntry = {
    file: string;
    symbols: Array<{
      name: string;
      sig: string;
      desc: string;
      danger?: string;
      calls?: string[];
      throws?: string[];
      callers?: string[];
    }>;
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
        // Callers: look up "filepath#symbolName" in depGraph.symbolRefs
        const callerKey = `${ext.path}#${sym.name}`;
        const callers = callersBySymbol.get(callerKey);
        const danger = dangerZones.get(ext.path)?.get(sym.name);
        syms.push({
          name: sym.name,
          sig: sym.signature,
          desc,
          danger,
          calls: sym.calls?.slice(0, 5),
          throws: sym.throws?.slice(0, 5),
          callers: callers?.map(c => c.split("/").pop() || c),
        });
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
    const boundary = directoryBoundaries.get(dir);
    if (boundary) {
      lines.push(`> ${boundary}`);
      lines.push("");
    }
    for (const entry of files) {
      const fname = entry.file.split("/").pop() || entry.file;
      lines.push(`## ${fname}`);
      for (const sym of entry.symbols) {
        lines.push(`- **${sym.name}**: ${sym.desc}`);
        if (sym.calls && sym.calls.length > 0) {
          lines.push(`  - calls: ${sym.calls.join(", ")}`);
        }
        if (sym.throws && sym.throws.length > 0) {
          lines.push(`  - throws: ${sym.throws.join(", ")}`);
        }
        if (sym.callers && sym.callers.length > 0) {
          lines.push(`  - called by: ${sym.callers.join(", ")}`);
        }
        if (sym.danger) {
          lines.push(`  - \u26A0 DANGER: ${sym.danger}`);
        }
      }
      const testNames = testNamesByFile.get(entry.file);
      if (testNames && testNames.length > 0) {
        lines.push(`- Tests: ${testNames.map(n => `"${n}"`).join(", ")}`);
        const fileAssertions = testAssertionsByFile.get(entry.file);
        if (fileAssertions) {
          const assertionSummary: string[] = [];
          for (const tName of testNames.slice(0, 3)) {
            const asserts = fileAssertions.get(tName);
            if (asserts && asserts.length > 0) {
              assertionSummary.push(...asserts.slice(0, 2));
            }
          }
          if (assertionSummary.length > 0) {
            lines.push(`  - expects: ${assertionSummary.join("; ")}`);
          }
        }
      }
      lines.push("");
    }

    rules.set(fileName, lines.join("\n"));
  }

  // Global architectural index — always loaded, lists every annotated directory
  // with its boundary description. Helps the model route issues to the right place
  // before it even opens a file.
  if (directoryBoundaries.size >= 2) {
    const indexLines: string[] = [];
    indexLines.push("# Codebase architecture — directory boundaries");
    indexLines.push("");
    indexLines.push("Use this map to route bug fixes and features to the correct directory.");
    indexLines.push("When an issue description mentions a concept, find the directory responsible for it here.");
    indexLines.push("");
    for (const [dir, desc] of [...directoryBoundaries.entries()].sort()) {
      indexLines.push(`## ${dir}/`);
      indexLines.push(desc);
      indexLines.push("");
    }
    rules.set("briefed-deep-arch-index.md", indexLines.join("\n"));
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

/**
 * Blended importance score for file selection.
 *
 * Signals (research-backed, ordered by evidence strength):
 *   1. Git churn (Nagappan & Ball 2005: 89% defect-density accuracy)
 *   2. Minor contributors / diffuse ownership (Bird et al. 2011: strongest ownership metric)
 *   3. PageRank — architectural centrality
 *   4. Efferent coupling / fan-out — bug propagation surface
 *   5. Cyclomatic complexity
 *   6. Has tests — leaf implementation bonus (tested files are meaningful)
 *
 * Each signal is normalized to ~0-1 before weighting so no single
 * scale dominates.
 */
function scoreFile(
  ext: FileExtraction,
  depGraph: DepGraph,
  complexityMap: Map<string, ComplexityScore>,
  gitSignals: Map<string, GitSignals>,
  testedFiles: Set<string>,
  personalizedRank?: Map<string, number>,
): number {
  // Use personalized PageRank when available (entrypoint-seeded), fall back to global
  const pageRank = (personalizedRank ?? depGraph.pageRank).get(ext.path) || 0;
  const fanOut = depGraph.nodes.get(ext.path)?.outEdges.length || 0;
  const complexity = complexityMap.get(ext.path)?.score || 0;
  const git = gitSignals.get(ext.path);
  const hasTests = testedFiles.has(ext.path) ? 1 : 0;

  // Normalize to ~0-1 with soft caps
  const pageRankNorm = Math.min(pageRank * 500, 1);       // typical range 0.0002–0.005
  const churnNorm = Math.min((git?.commits || 0) / 30, 1); // cap at 30 commits/year
  const minorNorm = Math.min((git?.minorAuthors || 0) / 5, 1);
  const fanOutNorm = Math.min(fanOut / 15, 1);
  const complexNorm = Math.min(complexity / 10, 1);

  return (
    pageRankNorm * 4.0 +   // highest weight: structural centrality via personalized PageRank
    churnNorm * 1.0 +      // recent activity (was 3.0 — demoted; churn over-weights volatile example files in stable libs)
    minorNorm * 2.0 +      // diffuse ownership: strong predictor of defect density
    fanOutNorm * 1.0 +     // efferent coupling: bug surface
    complexNorm * 0.8 +    // cyclomatic complexity
    hasTests * 0.5         // leaf implementation bonus
  );
}

/**
 * Build entrypoint seed weights for personalized PageRank.
 * Seeds: route handlers, CLI entrypoints, schema files, public API roots, and
 * files with zero inEdges (nothing imports them — invoked externally).
 * Shifts PageRank mass toward user-facing code instead of utility leaves.
 */
function buildEntrypointSeeds(
  extractions: FileExtraction[],
  depGraph: DepGraph,
): Map<string, number> {
  const seeds = new Map<string, number>();

  const ENTRYPOINT_RE = /(?:^|\/)(index|main|app|cli|server|routes?|router|entry|start|mod|lib)\.[jt]sx?$/i;
  const ROUTE_RE = /(?:route|controller|handler|endpoint)/i;
  const SCHEMA_RE = /(?:schema|model|migration|prisma)/i;
  // Library barrel: re-exports many symbols, zero or few imports itself
  const isBarrel = (ext: FileExtraction) =>
    ext.symbols.filter((s) => s.exported).length >= 5 &&
    (depGraph.nodes.get(ext.path)?.outEdges.length ?? 0) <= 2;

  for (const ext of extractions) {
    const p = ext.path;
    const node = depGraph.nodes.get(p);
    let weight = 0;

    // Zero in-edges: externally invoked, not imported by anyone
    if (node && node.inEdges.length === 0 && node.outEdges.length > 0) weight += 2;

    // Named entrypoint or bin/ file
    if (ENTRYPOINT_RE.test(p) || p.includes("/bin/")) weight += 3;

    // Route/controller/handler
    if (ROUTE_RE.test(basename(p))) weight += 2;

    // Schema/model files
    if (SCHEMA_RE.test(basename(p))) weight += 2;

    // Library barrel: re-exports many symbols with few own imports
    if (isBarrel(ext)) weight += 3;

    // Exported symbols with many cross-file callers (public API)
    const maxCallers = Math.max(
      0,
      ...ext.symbols
        .filter((s) => s.exported)
        .map((s) => (depGraph.symbolRefs?.get(`${p}#${s.name}`)?.length ?? 0)),
    );
    if (maxCallers >= 3) weight += 1;
    if (maxCallers >= 10) weight += 1;

    if (weight > 0) seeds.set(p, weight);
  }

  return seeds;
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

function getCallerContext(
  symbolName: string,
  filePath: string,
  depGraph: DepGraph,
  root: string,
): string[] {
  const key = `${filePath}#${symbolName}`;
  const importers = depGraph.symbolRefs?.get(key);
  if (!importers || importers.length === 0) return [];

  const contexts: string[] = [];
  for (const importerPath of importers.slice(0, 3)) {
    const content = safeRead(join(root, importerPath));
    if (!content) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && contexts.length < 3; i++) {
      if (lines[i].includes(symbolName) && !lines[i].match(/^import\s/)) {
        const before = i > 0 ? lines[i - 1].trim() : "";
        const call = lines[i].trim();
        const after = i < lines.length - 1 ? lines[i + 1].trim() : "";
        const fname = importerPath.split("/").pop() || importerPath;
        contexts.push(`  ${fname}:${i + 1}: ${before ? before + " → " : ""}${call}${after ? " → " + after : ""}`);
        break;
      }
    }
  }
  return contexts;
}

function buildBatchPrompt(
  batch: FileExtraction[],
  root: string,
  scoreMap?: Map<string, number>,
  criticalCutoff?: number,
  peripheralCutoff?: number,
  depGraph?: DepGraph,
  testMappings?: TestMapping[],
): string | null {
  const sections: string[] = [];

  const testAssertionsByFile = new Map<string, Map<string, string[]>>();
  if (testMappings) {
    for (const tm of testMappings) {
      if (tm.assertions && tm.assertions.size > 0) {
        testAssertionsByFile.set(tm.sourceFile, tm.assertions);
      }
    }
  }

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

    // Compute depth tier for this file based on its blended importance score.
    // Critical files get richer prompts; peripheral files stay terse.
    const score = scoreMap?.get(ext.path) ?? 0;
    let depthHint: string;
    if (criticalCutoff !== undefined && score >= criticalCutoff) {
      depthHint = "[DEPTH:thorough — up to 22 words: behavior + failure modes + required state]";
    } else if (peripheralCutoff !== undefined && score < peripheralCutoff) {
      depthHint = "[DEPTH:brief — up to 7 words: terse one-liner only]";
    } else {
      depthHint = "[DEPTH:normal — up to 13 words: what it does]";
    }

    let extraContext = "";
    if (criticalCutoff !== undefined && score >= criticalCutoff && depGraph) {
      const callerLines: string[] = [];
      for (const s of needsDesc) {
        const ctx = getCallerContext(s.name, ext.path, depGraph, root);
        if (ctx.length > 0) {
          callerLines.push(`CALLERS of ${s.name}:`);
          callerLines.push(...ctx);
        }
      }
      const testAssertions = testAssertionsByFile.get(ext.path);
      if (testAssertions && testAssertions.size > 0) {
        callerLines.push("");
        for (const [testName, assertions] of [...testAssertions.entries()].slice(0, 5)) {
          callerLines.push(`TEST "${testName}":`);
          for (const a of assertions.slice(0, 3)) {
            callerLines.push(`  ${a}`);
          }
        }
      }
      if (callerLines.length > 0) {
        extraContext = "\n" + callerLines.join("\n");
      }
    }

    sections.push(
      `FILE: ${ext.path} ${depthHint}\nSYMBOLS: ${needsDesc.map((s) => s.name).join(", ")}\nCODE:\n${relevant}${extraContext}`,
    );
  }

  if (sections.length === 0) return null;

  return `Analyze these source files. For each listed symbol, write ONE behavioral description matching its file's DEPTH hint.

DEPTH:thorough — up to 22 words. Include: what it does, side effects (DB writes/events/mutations), failure modes, required state.
  If CALLERS and TEST sections are provided, also produce a "danger" field (max 30 words): what callers depend on, what invariants tests check, what breaks if this function's behavior changes.
  Good: {"description": "creates draft invoice, validates project active, emits InvoiceCreated, throws if quota exceeded", "danger": "billing handler depends on InvoiceCreated event shape; test asserts non-null id"}
DEPTH:normal — up to 13 words. Include: what it does and key behaviors.
  Good: "hashes password with bcrypt 12 rounds, throws on empty input"
DEPTH:brief — up to 7 words. Terse one-liner only.
  Good: "formats currency with locale rounding"
Bad (any tier): "handles invoice logic" / "main service function" (too vague)

For DEPTH:thorough with CALLERS/TEST context, respond with an object {"description": "...", "danger": "..."}. For all other tiers, respond with a plain string.

Respond with a JSON object mapping "filepath::symbolName" to the description (string or object). No prose, no markdown, just the JSON object on a single line or pretty-printed. Example:

{"src/foo.ts::createInvoice": {"description": "creates draft invoice, validates project active, emits InvoiceCreated", "danger": "billing handler depends on event shape"}, "src/util.ts::hash": "hashes with bcrypt 12 rounds"}

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

/**
 * Run a one-shot claude -p call. The `model` argument selects the underlying
 * Claude model — passed straight through to `claude -p --model <name>`.
 *
 * Why this matters: deep was originally written assuming the user's CLI was
 * configured for Sonnet (subscription), where model choice is metered against
 * their plan. For users on API billing, model choice is real money: Opus is
 * roughly 5x Sonnet and 15x Haiku. Batch annotations are pattern-matching
 * with rigid JSON output — Haiku handles them fine. The system overview is
 * the one place that benefits from a smarter model, and it's a single call.
 */
function runClaudeJson(
  claudePath: string,
  prompt: string,
  cwd: string,
  model: "haiku" | "sonnet" | "opus" = "haiku",
): string | null {
  try {
    const result = spawnSync(
      claudePath,
      ["-p", "-", "--output-format", "text", "--model", model],
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

interface BatchParseResult {
  descriptions: Map<string, Map<string, string>>;
  dangerZones: Map<string, Map<string, string>>;
}

function parseBatchResponse(raw: string): BatchParseResult {
  const descriptions = new Map<string, Map<string, string>>();
  const dangerZones = new Map<string, Map<string, string>>();

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
    if (!match) return { descriptions, dangerZones };
    try {
      obj = JSON.parse(match[0]);
    } catch {
      return { descriptions, dangerZones };
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    let desc: string;
    let danger: string | undefined;

    if (typeof value === "string") {
      desc = value.trim();
    } else if (typeof value === "object" && value !== null && "description" in value) {
      desc = String((value as Record<string, unknown>).description).trim();
      const d = (value as Record<string, unknown>).danger;
      if (typeof d === "string" && d.trim()) {
        danger = d.trim();
      }
    } else {
      continue;
    }

    const sep = key.indexOf("::");
    if (sep === -1) continue;
    const file = key.slice(0, sep);
    const name = key.slice(sep + 2);

    if (!descriptions.has(file)) descriptions.set(file, new Map());
    descriptions.get(file)!.set(name, desc);

    if (danger !== undefined) {
      if (!dangerZones.has(file)) dangerZones.set(file, new Map());
      dangerZones.get(file)!.set(name, danger);
    }
  }
  return { descriptions, dangerZones };
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

  // System overview is a single call and benefits from real architectural
  // reasoning across multiple files — use Sonnet, not the Haiku default.
  const raw = runClaudeJson(claudePath, prompt, root, "sonnet");
  if (!raw) return null;

  return raw
    .replace(/^#+\s*/gm, "")
    .replace(/^\*\*/gm, "")
    .trim();
}

async function generateDirectoryBoundaries(
  claudePath: string,
  annotations: Map<string, Map<string, string>>,
  root: string,
): Promise<Map<string, string>> {
  // Group annotated symbols by directory
  const byDir = new Map<string, string[]>();
  for (const [filePath, fileAnns] of annotations) {
    const dir = dirname(filePath);
    if (!byDir.has(dir)) byDir.set(dir, []);
    for (const [name, desc] of fileAnns) {
      byDir.get(dir)!.push(`${name}: ${desc}`);
    }
  }

  // Only generate boundaries when there are multiple directories to compare
  if (byDir.size < 2) return new Map();

  const sections: string[] = [];
  for (const [dir, symbols] of byDir) {
    const top = symbols.slice(0, 4).join("; ");
    sections.push(`${dir}/: ${top}`);
  }

  const prompt = `Given these codebase directories and their key behaviors, for EACH directory write ONE sentence describing what it is responsible for and what it does. Focus on what an agent would find here when working on a bug or feature.

Keep descriptions positive and specific — avoid "NOT responsible for X" phrasing, which can mislead agents away from the right directory. Instead, describe what IS here.

Respond ONLY with a JSON object mapping directory path to its description sentence. Example:
{"src/runtime": "Executes compiled output in the browser — component lifecycle, event dispatch, and DOM reconciliation.", "src/compiler": "Transforms source files into executable JS — parsing, type-checking, and code emission."}

DIRECTORIES:
${sections.join("\n")}`;

  const raw = runClaudeJson(claudePath, prompt, root, "haiku");
  if (!raw) return new Map();

  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  try {
    const obj = JSON.parse(cleaned) as Record<string, unknown>;
    const result = new Map<string, string>();
    for (const [dir, desc] of Object.entries(obj)) {
      if (typeof desc === "string") result.set(dir, desc);
    }
    return result;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return new Map();
    try {
      const obj = JSON.parse(match[0]) as Record<string, unknown>;
      const result = new Map<string, string>();
      for (const [dir, desc] of Object.entries(obj)) {
        if (typeof desc === "string") result.set(dir, desc);
      }
      return result;
    } catch {
      return new Map();
    }
  }
}

function loadCache(root: string): DeepCache {
  const cachePath = join(root, ".briefed", "deep-cache.json");
  if (!existsSync(cachePath)) {
    return { version: CACHE_VERSION, files: {}, overview: null, boundaries: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (parsed.version !== CACHE_VERSION) {
      return { version: CACHE_VERSION, files: {}, overview: null, boundaries: null };
    }
    return parsed;
  } catch {
    return { version: CACHE_VERSION, files: {}, overview: null, boundaries: null };
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
  getGitSignals,
};

