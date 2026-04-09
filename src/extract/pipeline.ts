import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { debug } from "../utils/log.js";
import { extractFile } from "./signatures.js";
import { buildDepGraph } from "./depgraph.js";
import { computeComplexity } from "./complexity.js";
import { findTestMappings } from "./tests.js";
import { detectConventions } from "./conventions.js";
import { extractSchemas } from "./schema.js";
import { extractRoutes } from "./routes.js";
import { extractEnvVars } from "./env.js";
import { extractScripts } from "./scripts.js";
import { extractDeps } from "./deps.js";
import { isSensitiveFile } from "./security.js";
import type { FileExtraction } from "./signatures.js";
import type { DepGraph } from "./depgraph.js";
import type { ComplexityScore } from "./complexity.js";
import type { TestMapping } from "./tests.js";
import type { ProjectConventions } from "./conventions.js";
import type { SchemaModel } from "./schema.js";
import type { Route } from "./routes.js";
import type { EnvVar } from "./env.js";
import type { ProjectScripts } from "./scripts.js";
import type { DepsResult } from "./deps.js";
import type { ScanResult } from "./scanner.js";
import type { StackInfo } from "../utils/detect.js";

export interface ExtractionResult {
  extractions: FileExtraction[];
  extractErrors: number;
  depGraph: DepGraph;
  complexityScores: ComplexityScore[];
  testMappings: TestMapping[];
  conventions: ProjectConventions;
  schemas: SchemaModel[];
  routes: Route[];
  envVars: EnvVar[];
  scripts: ProjectScripts;
  deps: DepsResult;
}

/**
 * Run all extraction steps and return the collected results.
 * Logs progress to console so users can see what's happening.
 */
export function runExtractionPipeline(
  root: string,
  scan: ScanResult,
  stack: StackInfo
): ExtractionResult {
  // Filter out sensitive files
  const sensitiveCount = scan.files.filter((f) => isSensitiveFile(f.path)).length;
  scan.files = scan.files.filter((f) => !isSensitiveFile(f.path));
  if (sensitiveCount > 0) {
    console.log(`  Excluded ${sensitiveCount} sensitive files (.env, credentials, keys)`);
  }
  console.log(`  Found ${scan.totalFiles} source files`);

  // Load extraction cache (SHA256 content hash → extraction result)
  const cacheDir = join(root, ".briefed");
  const cachePath = join(cacheDir, "extract-cache.json");
  let cache: Record<string, { hash: string; extraction: FileExtraction }> = {};
  try {
    if (existsSync(cachePath)) {
      cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    }
  } catch { cache = {}; }

  // Extract signatures and imports from each file (with caching)
  console.log("  Extracting signatures...");
  const extractions: FileExtraction[] = [];
  // Keep file content for non-cached files so complexity scoring can reuse it
  const fileContentMap = new Map<string, string>();
  let extractErrors = 0;
  let cacheHits = 0;

  for (const file of scan.files) {
    try {
      const content = readFileSync(file.absolutePath, "utf-8");
      const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);

      // Use cached extraction if file content unchanged
      const cached = cache[file.path];
      if (cached && cached.hash === hash) {
        extractions.push(cached.extraction);
        cacheHits++;
        continue;
      }

      const extraction = extractFile(file.absolutePath, root, content);
      extraction.path = file.path; // use relative path
      extractions.push(extraction);
      fileContentMap.set(file.path, content);

      // Store in cache
      cache[file.path] = { hash, extraction };
    } catch (e) {
      extractErrors++;
      debug(`signature extraction failed for ${file.path}: ${(e as Error).message}`);
    }
  }

  // Prune deleted files from cache
  const currentFiles = new Set(scan.files.map((f) => f.path));
  for (const key of Object.keys(cache)) {
    if (!currentFiles.has(key)) delete cache[key];
  }

  // Save cache
  try {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache));
  } catch (e) {
    debug(`failed to write extraction cache: ${(e as Error).message}`);
  }

  const totalSymbols = extractions.reduce((s, e) => s + e.symbols.length, 0);
  const cacheMsg = cacheHits > 0 ? `, ${cacheHits} cached` : "";
  console.log(`  Extracted ${totalSymbols} symbols from ${extractions.length} files${cacheMsg}${extractErrors > 0 ? ` (${extractErrors} errors)` : ""}`);

  // Build dependency graph
  console.log("  Building dependency graph...");
  const depGraph = buildDepGraph(extractions, root);
  const edgeCount = [...depGraph.nodes.values()].reduce((s, n) => s + n.outEdges.length, 0);
  console.log(`  Graph: ${depGraph.nodes.size} nodes, ${edgeCount} edges`);

  // Compute complexity scores (used as a sort key for skeleton generation)
  console.log("  Computing complexity scores...");
  const complexityScores: ComplexityScore[] = [];
  for (const ext of extractions) {
    try {
      const score = computeComplexity(ext, depGraph, root, fileContentMap.get(ext.path));
      complexityScores.push(score);
    } catch (e) {
      debug(`complexity scoring failed for ${ext.path}: ${(e as Error).message}`);
    }
  }

  // Find test file mappings (+45.97% pass@1 from research)
  console.log("  Mapping test files...");
  const testMappings = findTestMappings(
    scan.files.map((f) => f.path),
    root
  );
  console.log(`  Mapped ${testMappings.length} source→test pairs (${testMappings.reduce((s, t) => s + t.testCount, 0)} test cases)`);

  // External dependency context (versions + import frequency, Context7-aware)
  const deps = extractDeps(root, extractions);
  if (deps.packages.length > 0) {
    const c7 = deps.hasContext7 ? " (Context7 detected)" : "";
    console.log(`  Found ${deps.packages.length} external packages${c7}`);
  }

  // Detect project conventions
  console.log("  Detecting conventions...");
  const conventions = detectConventions(extractions, root);
  const convCount = [...Object.values(conventions)].flat().length;
  console.log(`  Detected ${convCount} conventions`);

  // Domain-specific extractors — only run what's relevant to this project
  const hasBackend = stack.frameworks.some((f) =>
    ["express", "fastify", "hono", "nestjs", "django", "fastapi", "flask", "gin", "echo", "fiber"].includes(f)
  ) || stack.languages.some((l) => ["go", "rust", "java", "python"].includes(l));

  const hasORM = !!stack.dbORM;

  // Schemas — only if ORM detected
  let schemas: SchemaModel[] = [];
  if (hasORM) {
    console.log("  Extracting schemas...");
    schemas = extractSchemas(root);
    console.log(`  Found ${schemas.length} models/tables`);
  }

  // Routes — only if backend framework detected
  let routes: Route[] = [];
  if (hasBackend || stack.frameworks.includes("next.js")) {
    console.log("  Extracting routes...");
    routes = extractRoutes(root);
    if (routes.length > 0) console.log(`  Found ${routes.length} API endpoints`);
  }

  // Env vars — always useful
  console.log("  Extracting env vars...");
  const envVars = extractEnvVars(root);
  if (envVars.length > 0) console.log(`  Found ${envVars.length} env vars (${envVars.filter((v) => v.required).length} required)`);

  // Scripts — always useful
  const scripts = extractScripts(root);

  return {
    extractions,
    extractErrors,
    depGraph,
    complexityScores,
    testMappings,
    conventions,
    schemas,
    routes,
    envVars,
    scripts,
    deps,
  };
}

/**
 * Re-save the extraction cache after in-place mutations (e.g. mergeDeepAnnotations).
 * Loads the on-disk cache, patches the extraction for each matching path, and re-saves.
 * Hashes are unchanged — only the extraction payload is updated.
 */
export function updateExtractionCache(root: string, extractions: FileExtraction[]) {
  const cachePath = join(root, ".briefed", "extract-cache.json");
  try {
    const cache: Record<string, { hash: string; extraction: FileExtraction }> =
      JSON.parse(readFileSync(cachePath, "utf-8"));
    for (const ext of extractions) {
      if (cache[ext.path]) cache[ext.path].extraction = ext;
    }
    writeFileSync(cachePath, JSON.stringify(cache));
  } catch (e) {
    debug(`failed to update extraction cache: ${(e as Error).message}`);
  }
}
