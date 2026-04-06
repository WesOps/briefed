import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { debug } from "../utils/log.js";
import { extractFile } from "./signatures.js";
import { buildDepGraph } from "./depgraph.js";
import { computeComplexity } from "./complexity.js";
import { extractGotchas } from "./gotchas.js";
import { findTestMappings } from "./tests.js";
import { getBatchHistory } from "./history.js";
import { detectConventions } from "./conventions.js";
import { findUsageExamples } from "./usage-examples.js";
import { detectErrorPatterns } from "./error-patterns.js";
import { extractSchemas } from "./schema.js";
import { extractRoutes } from "./routes.js";
import { extractEnvVars } from "./env.js";
import { extractScripts } from "./scripts.js";
import { extractFrontend } from "./frontend.js";
import { extractInfra } from "./infra.js";
import { extractRouteCalls } from "./cross-layer.js";
import { isSensitiveFile } from "./security.js";
import type { FileExtraction } from "./signatures.js";
import type { DepGraph } from "./depgraph.js";
import type { ComplexityScore } from "./complexity.js";
import type { Gotcha } from "./gotchas.js";
import type { TestMapping } from "./tests.js";
import type { FileHistory } from "./history.js";
import type { ProjectConventions } from "./conventions.js";
import type { UsageExample } from "./usage-examples.js";
import type { ErrorPattern } from "./error-patterns.js";
import type { SchemaModel } from "./schema.js";
import type { Route } from "./routes.js";
import type { EnvVar } from "./env.js";
import type { ProjectScripts } from "./scripts.js";
import type { FrontendInfo } from "./frontend.js";
import type { InfraInfo } from "./infra.js";
import type { CrossLayerGraph } from "./cross-layer.js";
import type { ScanResult } from "./scanner.js";
import type { StackInfo } from "../utils/detect.js";

export interface ExtractionResult {
  extractions: FileExtraction[];
  extractErrors: number;
  depGraph: DepGraph;
  complexityScores: ComplexityScore[];
  gotchas: Gotcha[];
  testMappings: TestMapping[];
  histories: Map<string, FileHistory>;
  conventions: ProjectConventions;
  usageExamples: Map<string, UsageExample[]>;
  errorPatterns: { patterns: ErrorPattern[]; summary: string[] };
  schemas: SchemaModel[];
  routes: Route[];
  envVars: EnvVar[];
  scripts: ProjectScripts;
  frontend: FrontendInfo;
  infra: InfraInfo;
  crossLayer: CrossLayerGraph;
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

      const extraction = extractFile(file.absolutePath, root);
      extraction.path = file.path; // use relative path
      extractions.push(extraction);

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

  // Compute complexity scores
  console.log("  Computing complexity scores...");
  const complexityScores: ComplexityScore[] = [];
  for (const ext of extractions) {
    try {
      const score = computeComplexity(ext, depGraph);
      complexityScores.push(score);
    } catch (e) {
      debug(`complexity scoring failed for ${ext.path}: ${(e as Error).message}`);
    }
  }

  const avgComplexity = complexityScores.length > 0
    ? complexityScores.reduce((s, c) => s + c.score, 0) / complexityScores.length
    : 0;
  console.log(`  Average complexity: ${avgComplexity.toFixed(1)}/10`);

  // Extract gotchas
  console.log("  Extracting gotchas...");
  let gotchas: Gotcha[] = [];
  for (const file of scan.files) {
    try {
      const fileGotchas = extractGotchas(file.absolutePath);
      gotchas = gotchas.concat(fileGotchas);
    } catch (e) {
      debug(`gotcha extraction failed for ${file.path}: ${(e as Error).message}`);
    }
  }
  console.log(`  Found ${gotchas.length} gotchas`);

  // Find test file mappings (+45.97% pass@1 from research)
  console.log("  Mapping test files...");
  const testMappings = findTestMappings(
    scan.files.map((f) => f.path),
    root
  );
  console.log(`  Mapped ${testMappings.length} source→test pairs (${testMappings.reduce((s, t) => s + t.testCount, 0)} test cases)`);

  // Extract git history for complex files
  console.log("  Extracting git history...");
  const fileComplexityPairs = complexityScores.map((c) => ({
    path: c.file,
    complexity: c.score,
  }));
  const histories = getBatchHistory(fileComplexityPairs, root, 3);
  console.log(`  History extracted for ${histories.size} complex files`);

  // Detect project conventions
  console.log("  Detecting conventions...");
  const conventions = detectConventions(extractions, root);
  const convCount = [...Object.values(conventions)].flat().length;
  console.log(`  Detected ${convCount} conventions`);

  // Find usage examples (3x improvement from research)
  console.log("  Finding usage examples...");
  const usageExamples = findUsageExamples(extractions);
  console.log(`  Found examples for ${usageExamples.size} symbols`);

  // Detect error handling patterns (prevents 2x error rate)
  console.log("  Detecting error patterns...");
  const errorPatterns = detectErrorPatterns(scan.files.map((f) => f.absolutePath));
  console.log(`  Detected ${errorPatterns.summary.length} error handling patterns`);

  // Domain-specific extractors — only run what's relevant to this project
  const hasBackend = stack.frameworks.some((f) =>
    ["express", "fastify", "hono", "nestjs", "django", "fastapi", "flask", "gin", "echo", "fiber"].includes(f)
  ) || stack.languages.some((l) => ["go", "rust", "java", "python"].includes(l));

  const hasFrontend = stack.frameworks.some((f) =>
    ["react", "next.js", "vue", "nuxt", "svelte", "astro", "remix", "angular"].includes(f)
  );

  const hasORM = !!stack.dbORM;

  const hasInfra = existsSync(join(root, "docker-compose.yml")) ||
    existsSync(join(root, "docker-compose.yaml")) ||
    existsSync(join(root, "compose.yml")) ||
    existsSync(join(root, "Dockerfile")) ||
    existsSync(join(root, "vercel.json")) ||
    existsSync(join(root, "fly.toml")) ||
    existsSync(join(root, "terraform")) ||
    existsSync(join(root, "k8s"));

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

  // Frontend — only if frontend framework detected
  let frontend: FrontendInfo = {
    framework: null, pages: [], components: [], stateStores: [], styling: null, uiLibrary: null
  };
  if (hasFrontend) {
    console.log("  Extracting frontend...");
    frontend = extractFrontend(root);
    console.log(`  Frontend: ${frontend.framework}, ${frontend.pages.length} pages, ${frontend.components.length} components`);
  }

  // Cross-layer graph — only if BOTH frontend and backend routes exist
  let crossLayer: CrossLayerGraph = { routeCalls: [], routeCallers: new Map() };
  if (hasFrontend && routes.length > 0) {
    console.log("  Mapping cross-layer (frontend → backend)...");
    crossLayer = extractRouteCalls(root, scan, routes);
    if (crossLayer.routeCalls.length > 0) {
      const matched = crossLayer.routeCalls.filter((c) => c.matchedRoute).length;
      console.log(`  Found ${crossLayer.routeCalls.length} HTTP calls (${matched} matched to routes)`);
    }
  }

  // Infra — only if infra files detected
  let infra: InfraInfo = {
    services: [], ports: [], volumes: [], networks: [], providers: [], deployment: null
  };
  if (hasInfra) {
    console.log("  Extracting infrastructure...");
    infra = extractInfra(root);
    console.log(`  Infra: ${infra.services.length} services, deployment: ${infra.deployment || "detected"}`);
  }

  return {
    extractions,
    extractErrors,
    depGraph,
    complexityScores,
    gotchas,
    testMappings,
    histories,
    conventions,
    usageExamples,
    errorPatterns,
    schemas,
    routes,
    envVars,
    scripts,
    frontend,
    infra,
    crossLayer,
  };
}
