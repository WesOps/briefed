import { resolve } from "path";
import { detectStack } from "../utils/detect.js";
import { scanFiles } from "../extract/scanner.js";
import { extractFile } from "../extract/signatures.js";
import { buildDepGraph } from "../extract/depgraph.js";
import { computeComplexity } from "../extract/complexity.js";
import { extractGotchas } from "../extract/gotchas.js";
import { findTestMappings } from "../extract/tests.js";
import { getBatchHistory, formatHistory } from "../extract/history.js";
import { detectConventions, formatConventions } from "../extract/conventions.js";
import { generateSkeleton } from "../generate/skeleton.js";
import { generateRuleFiles } from "../generate/rules.js";
import { generateModuleIndex, writeModuleIndex, generateSimpleContracts } from "../generate/index-file.js";
import { updateClaudeMd, saveSkeletonFile } from "../deliver/claudemd.js";
import { installHooks, generateHookScripts } from "../deliver/hooks.js";
import { writeCursorRules, writeAgentsMd } from "../deliver/cross-tool.js";
import { installGitHook } from "../deliver/git-hook.js";
import { detectMonorepo } from "../extract/monorepo.js";
import { isSensitiveFile } from "../extract/security.js";
import { findUsageExamples, formatUsageExamples } from "../extract/usage-examples.js";
import { detectErrorPatterns } from "../extract/error-patterns.js";
import { extractSchemas, formatSchemas } from "../extract/schema.js";
import { extractRoutes, formatRoutes } from "../extract/routes.js";
import { extractEnvVars, formatEnvVars } from "../extract/env.js";
import { extractScripts, formatScripts } from "../extract/scripts.js";
import { extractFrontend, formatFrontend } from "../extract/frontend.js";
import { extractInfra, formatInfra } from "../extract/infra.js";
import { extractIntegrations, formatIntegrations } from "../extract/integrations.js";
import { extractApiSchema, formatApiSchema } from "../extract/api-schema.js";
import { extractJobs, formatJobs } from "../extract/jobs.js";
import { extractMigrations, formatMigrations } from "../extract/migrations.js";
import { extractDeprecations, formatDeprecations } from "../extract/deprecations.js";
import { extractFeatureFlags, formatFeatureFlags } from "../extract/feature-flags.js";
import { extractCaching, formatCaching } from "../extract/caching.js";
import { extractAuth, formatAuth } from "../extract/auth.js";
import { generateLearningHookScript } from "../learn/tracker.js";
import { countTokens, formatTokens } from "../utils/tokens.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { FileExtraction } from "../extract/signatures.js";
import type { ComplexityScore } from "../extract/complexity.js";

interface InitOptions {
  repo: string;
  maxTokens: string;
  skipHooks?: boolean;
  skipRules?: boolean;
}

export async function initCommand(opts: InitOptions) {
  const root = resolve(opts.repo);
  const maxTokens = parseInt(opts.maxTokens, 10);

  console.log(`briefed init — scanning ${root}`);
  const startTime = Date.now();

  // Step 0: Detect monorepo
  const mono = detectMonorepo(root);
  if (mono.isMonorepo && mono.currentPackage) {
    console.log(`  Monorepo detected — scoping to package: ${mono.currentPackage.name}`);
  } else if (mono.isMonorepo) {
    console.log(`  Monorepo detected (${mono.packages.length} packages) — indexing from root`);
  }

  // Step 1: Detect stack
  console.log("  Detecting stack...");
  const stack = detectStack(root);
  console.log(`  Stack: ${[...stack.languages, ...stack.frameworks].join(", ")}${stack.dbORM ? ` + ${stack.dbORM}` : ""}`);

  // Step 2: Discover files (with security filtering)
  console.log("  Scanning files...");
  const scan = scanFiles(root);
  // Filter out sensitive files
  const sensitiveCount = scan.files.filter((f) => isSensitiveFile(f.path)).length;
  scan.files = scan.files.filter((f) => !isSensitiveFile(f.path));
  if (sensitiveCount > 0) {
    console.log(`  Excluded ${sensitiveCount} sensitive files (.env, credentials, keys)`);
  }
  console.log(`  Found ${scan.totalFiles} source files`);

  if (scan.totalFiles === 0) {
    console.log("  No source files found. Nothing to do.");
    return;
  }

  // Step 3: Extract signatures and imports from each file
  console.log("  Extracting signatures...");
  const extractions: FileExtraction[] = [];
  let extractErrors = 0;

  for (const file of scan.files) {
    try {
      const extraction = extractFile(file.absolutePath, root);
      extraction.path = file.path; // use relative path
      extractions.push(extraction);
    } catch {
      extractErrors++;
    }
  }

  const totalSymbols = extractions.reduce((s, e) => s + e.symbols.length, 0);
  console.log(`  Extracted ${totalSymbols} symbols from ${extractions.length} files${extractErrors > 0 ? ` (${extractErrors} errors)` : ""}`);

  // Step 4: Build dependency graph
  console.log("  Building dependency graph...");
  const depGraph = buildDepGraph(extractions, root);
  const edgeCount = [...depGraph.nodes.values()].reduce((s, n) => s + n.outEdges.length, 0);
  console.log(`  Graph: ${depGraph.nodes.size} nodes, ${edgeCount} edges`);

  // Step 5: Compute complexity scores
  console.log("  Computing complexity scores...");
  const complexityScores: ComplexityScore[] = [];
  for (const ext of extractions) {
    try {
      const score = computeComplexity(ext, depGraph);
      complexityScores.push(score);
    } catch {
      // Skip files that can't be scored
    }
  }

  const avgComplexity = complexityScores.length > 0
    ? complexityScores.reduce((s, c) => s + c.score, 0) / complexityScores.length
    : 0;
  console.log(`  Average complexity: ${avgComplexity.toFixed(1)}/10`);

  // Step 6: Generate L1 skeleton
  console.log("  Generating skeleton...");
  const skeleton = generateSkeleton(stack, extractions, depGraph, complexityScores, { maxTokens });
  const skeletonTokens = countTokens(skeleton);
  console.log(`  Skeleton: ${formatTokens(skeletonTokens)} tokens`);

  // Step 7: Extract gotchas
  console.log("  Extracting gotchas...");
  let allGotchas: ReturnType<typeof extractGotchas> = [];
  for (const file of scan.files) {
    try {
      const gotchas = extractGotchas(file.absolutePath);
      allGotchas = allGotchas.concat(gotchas);
    } catch {
      // Skip files that can't be analyzed
    }
  }
  console.log(`  Found ${allGotchas.length} gotchas`);

  // Step 7b: Find test file mappings (+45.97% pass@1 from research)
  console.log("  Mapping test files...");
  const testMappings = findTestMappings(
    scan.files.map((f) => f.path),
    root
  );
  console.log(`  Mapped ${testMappings.length} source→test pairs (${testMappings.reduce((s, t) => s + t.testCount, 0)} test cases)`);

  // Step 7c: Extract git history for complex files
  console.log("  Extracting git history...");
  const fileComplexityPairs = complexityScores.map((c) => ({
    path: c.file,
    complexity: c.score,
  }));
  const histories = getBatchHistory(fileComplexityPairs, root, 3);
  console.log(`  History extracted for ${histories.size} complex files`);

  // Step 7d: Detect project conventions
  console.log("  Detecting conventions...");
  const conventions = detectConventions(extractions, root);
  const convText = formatConventions(conventions);
  const convCount = [...Object.values(conventions)].flat().length;
  console.log(`  Detected ${convCount} conventions`);

  // Step 7e: Find usage examples (3x improvement from research)
  console.log("  Finding usage examples...");
  const usageExamples = findUsageExamples(extractions);
  const usageText = formatUsageExamples(usageExamples);
  console.log(`  Found examples for ${usageExamples.size} symbols`);

  // Step 7f: Detect error handling patterns (prevents 2x error rate)
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
  let schemas: ReturnType<typeof extractSchemas> = [];
  if (hasORM) {
    console.log("  Extracting schemas...");
    schemas = extractSchemas(root);
    console.log(`  Found ${schemas.length} models/tables`);
  }

  // Routes — only if backend framework detected
  let routes: ReturnType<typeof extractRoutes> = [];
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
  let frontend: ReturnType<typeof extractFrontend> = {
    framework: null, pages: [], components: [], stateStores: [], styling: null, uiLibrary: null
  };
  if (hasFrontend) {
    console.log("  Extracting frontend...");
    frontend = extractFrontend(root);
    console.log(`  Frontend: ${frontend.framework}, ${frontend.pages.length} pages, ${frontend.components.length} components`);
  }

  // Infra — only if infra files detected
  let infra: ReturnType<typeof extractInfra> = {
    services: [], ports: [], volumes: [], networks: [], providers: [], deployment: null
  };
  if (hasInfra) {
    console.log("  Extracting infrastructure...");
    infra = extractInfra(root);
    console.log(`  Infra: ${infra.services.length} services, deployment: ${infra.deployment || "detected"}`);
  }

  // External integrations — always useful
  console.log("  Detecting integrations...");
  const integrations = extractIntegrations(root);
  if (integrations.length > 0) console.log(`  Found ${integrations.length} integrations (${integrations.map(i => i.name).join(", ")})`);

  // OpenAPI / GraphQL schemas
  console.log("  Checking API schemas...");
  const apiSchemas = extractApiSchema(root);
  if (apiSchemas.length > 0) console.log(`  Found ${apiSchemas.length} API schema files`);

  // Background jobs
  console.log("  Detecting background jobs...");
  const jobs = extractJobs(root);
  if (jobs.length > 0) console.log(`  Found ${jobs.length} background jobs`);

  // Recent migrations — only if ORM detected
  let migrations: ReturnType<typeof extractMigrations> = [];
  if (hasORM) {
    console.log("  Checking recent migrations...");
    migrations = extractMigrations(root);
    if (migrations.length > 0) console.log(`  Found ${migrations.length} recent migrations`);
  }

  // Deprecations
  console.log("  Scanning deprecations...");
  const deprecations = extractDeprecations(root);
  if (deprecations.length > 0) console.log(`  Found ${deprecations.length} deprecated items`);

  // Feature flags
  console.log("  Detecting feature flags...");
  const featureFlags = extractFeatureFlags(root);
  if (featureFlags.length > 0) console.log(`  Found ${featureFlags.length} feature flags`);

  // Caching patterns
  console.log("  Detecting caching patterns...");
  const cachingPatterns = extractCaching(root);
  if (cachingPatterns.length > 0) console.log(`  Found ${cachingPatterns.length} caching patterns`);

  // Auth model
  console.log("  Detecting auth model...");
  const authInfo = extractAuth(root);
  if (authInfo) console.log(`  Auth: ${authInfo.provider} (${authInfo.strategy.join(", ")})`);

  // Step 8: Generate module index + contracts
  console.log("  Generating module index...");
  const moduleIndex = generateModuleIndex(extractions, depGraph, complexityScores, root);
  writeModuleIndex(root, moduleIndex);
  console.log(`  Indexed ${moduleIndex.modules.length} modules`);

  console.log("  Generating contracts...");
  generateSimpleContracts(moduleIndex, extractions, depGraph, root);

  // Step 9: Write outputs
  // Append conventions and test info to skeleton
  let enrichedSkeleton = skeleton;
  if (convText) {
    enrichedSkeleton += "\n" + convText;
  }
  if (testMappings.length > 0) {
    enrichedSkeleton += "\nTests: " + testMappings.length + " source files have matching test files";
  }
  if (errorPatterns.summary.length > 0) {
    enrichedSkeleton += "\nError handling:\n" + errorPatterns.summary.map((s) => `  - ${s}`).join("\n");
  }
  if (usageText) {
    enrichedSkeleton += "\n" + usageText;
  }
  const scriptsText = formatScripts(scripts);
  if (scriptsText) enrichedSkeleton += "\n" + scriptsText;
  const schemasText = formatSchemas(schemas);
  if (schemasText) enrichedSkeleton += "\n" + schemasText;
  const routesText = formatRoutes(routes);
  if (routesText) enrichedSkeleton += "\n" + routesText;
  const envText = formatEnvVars(envVars);
  if (envText) enrichedSkeleton += "\n" + envText;
  const frontendText = formatFrontend(frontend);
  if (frontendText) enrichedSkeleton += "\n" + frontendText;
  const infraText = formatInfra(infra);
  if (infraText) enrichedSkeleton += "\n" + infraText;
  const authText = formatAuth(authInfo);
  if (authText) enrichedSkeleton += "\n" + authText;
  const integrationsText = formatIntegrations(integrations);
  if (integrationsText) enrichedSkeleton += "\n" + integrationsText;
  const apiSchemaText = formatApiSchema(apiSchemas);
  if (apiSchemaText) enrichedSkeleton += "\n" + apiSchemaText;
  const jobsText = formatJobs(jobs);
  if (jobsText) enrichedSkeleton += "\n" + jobsText;
  const migrationsText = formatMigrations(migrations);
  if (migrationsText) enrichedSkeleton += "\n" + migrationsText;
  const deprecationsText = formatDeprecations(deprecations);
  if (deprecationsText) enrichedSkeleton += "\n" + deprecationsText;
  const flagsText = formatFeatureFlags(featureFlags);
  if (flagsText) enrichedSkeleton += "\n" + flagsText;
  const cachingText = formatCaching(cachingPatterns);
  if (cachingText) enrichedSkeleton += "\n" + cachingText;

  // Save test mappings to .briefed/ for hook use
  const briefedDir = join(root, ".briefed");
  if (!existsSync(briefedDir)) mkdirSync(briefedDir, { recursive: true });
  writeFileSync(
    join(briefedDir, "test-map.json"),
    JSON.stringify(
      Object.fromEntries(testMappings.map((t) => [t.sourceFile, { test: t.testFile, count: t.testCount, names: t.testNames.slice(0, 10) }])),
      null,
      2
    )
  );

  // Save histories to .briefed/ for hook use
  if (histories.size > 0) {
    const histObj: Record<string, unknown> = {};
    for (const [file, hist] of histories) {
      histObj[file] = {
        frequency: hist.changeFrequency,
        recent: hist.recentCommits.slice(0, 3).map((c) => c.message),
      };
    }
    writeFileSync(join(briefedDir, "history.json"), JSON.stringify(histObj, null, 2));
  }

  console.log("  Writing skeleton to CLAUDE.md...");
  updateClaudeMd(root, enrichedSkeleton);
  saveSkeletonFile(root, enrichedSkeleton);

  if (!opts.skipRules) {
    console.log("  Writing gotchas to .claude/rules/...");
    const ruleFiles = generateRuleFiles(allGotchas, root);
    const rulesDir = join(root, ".claude", "rules");
    if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });

    for (const [filename, content] of ruleFiles) {
      writeFileSync(join(rulesDir, filename), content);
    }
    console.log(`  Wrote ${ruleFiles.size} rule files`);
  }

  if (!opts.skipHooks) {
    console.log("  Installing hooks...");
    generateHookScripts(root);
    installHooks(root);
    console.log("  Hooks installed in .claude/settings.json");
  }

  // Cross-tool output
  console.log("  Writing cross-tool context...");
  writeCursorRules(root, enrichedSkeleton, convText);
  writeAgentsMd(root, enrichedSkeleton, convText);

  // Git hook for auto-updates
  const hookInstalled = installGitHook(root);
  if (hookInstalled) {
    console.log("  Git hook installed (auto-updates on every commit)");
  }

  // Step 10: Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("");
  console.log(`  Done in ${elapsed}s`);
  console.log("");
  console.log("  Output:");
  console.log(`    CLAUDE.md            — skeleton + conventions (~${formatTokens(countTokens(enrichedSkeleton))} tokens)`);
  console.log(`    .cursorrules         — Cursor IDE context`);
  console.log(`    AGENTS.md            — cross-tool context`);
  console.log(`    .claude/rules/       — gotchas (${allGotchas.length} constraints, path-scoped)`);
  console.log(`    .briefed/contracts/     — module contracts (${moduleIndex.modules.length} modules)`);
  console.log(`    .briefed/test-map.json  — test mappings (${testMappings.length} pairs, ${testMappings.reduce((s, t) => s + t.testCount, 0)} tests)`);
  console.log(`    .briefed/history.json   — git history (${histories.size} files)`);
  if (!opts.skipHooks) {
    console.log(`    .claude/settings.json — adaptive hooks`);
  }
  if (hookInstalled) {
    console.log(`    .git/hooks/post-commit — auto-updates on every commit`);
  }
  // Context budget report
  const skeletonTk = countTokens(enrichedSkeleton);
  const ruleTokens = allGotchas.length > 0 ? countTokens(allGotchas.map((g) => g.text).join("\n")) : 0;
  const totalAlwaysLoaded = skeletonTk;
  const totalPerPrompt = 500; // average contract injection
  const totalPerFile = Math.round(ruleTokens / Math.max(1, allGotchas.length)) * 3; // ~3 gotchas per file

  console.log("");
  console.log("  Context budget:");
  console.log(`    Always loaded:   ~${formatTokens(totalAlwaysLoaded)} tokens (skeleton + conventions)`);
  console.log(`    Per prompt:      ~${formatTokens(totalPerPrompt)} tokens (adaptive module contracts)`);
  console.log(`    Per file:        ~${formatTokens(totalPerFile)} tokens (path-scoped gotchas)`);
  console.log(`    Estimated total: ~${formatTokens(totalAlwaysLoaded + totalPerPrompt + totalPerFile)} tokens/prompt`);
  console.log("");
  console.log(`  Without briefed, Claude spends ~5K-10K tokens reading files for orientation.`);
  console.log(`  Estimated savings: ~${formatTokens(Math.max(0, 7000 - totalAlwaysLoaded - totalPerPrompt))} tokens/prompt`);
  console.log("");
  console.log("  Context auto-updates on every commit. No CI needed.");
  console.log("  Works with: Claude Code, Cursor, Copilot, and any tool that reads AGENTS.md");
}
