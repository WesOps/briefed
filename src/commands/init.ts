import { resolve, join } from "path";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { detectStack } from "../utils/detect.js";
import { scanFiles } from "../extract/scanner.js";
import { detectMonorepo } from "../extract/monorepo.js";
import { runExtractionPipeline } from "../extract/pipeline.js";
import { generateSkeleton } from "../generate/skeleton.js";
import { generateModuleIndex, writeModuleIndex, generateSimpleContracts } from "../generate/index-file.js";
import { formatConventions } from "../extract/conventions.js";
import { formatSchemas } from "../extract/schema.js";
import { formatRoutes } from "../extract/routes.js";
import { formatEnvVars } from "../extract/env.js";
import { formatScripts } from "../extract/scripts.js";
import { formatDeps } from "../extract/deps.js";
import { runDeepAnalysis, buildDeepRules } from "../extract/deep.js";
import { writeOutputs } from "../deliver/output.js";
import { countTokens, formatTokens } from "../utils/tokens.js";

interface InitOptions {
  repo: string;
  maxTokens: string;
  skipHooks?: boolean;
  skipRules?: boolean;
  deep?: boolean;
}

export async function initCommand(opts: InitOptions) {
  const root = resolve(opts.repo);

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

  // Step 2: Discover files
  console.log("  Scanning files...");
  const scan = scanFiles(root);

  if (scan.totalFiles === 0) {
    console.log("  No source files found. Nothing to do.");
    return;
  }

  // Step 3: Run all extraction steps
  const result = runExtractionPipeline(root, scan, stack);

  // Step 3.5: Optional LLM-powered behavioral descriptions via `claude -p`.
  // Delivered as path-scoped rules (not merged into the always-loaded
  // skeleton) so unrelated prompts pay zero extra tokens.
  let deepSystemOverview: string | null = null;
  let deepRules: Map<string, string> = new Map();
  if (opts.deep) {
    console.log("  Running deep analysis (LLM-powered behavioral descriptions)...");
    const deepResult = await runDeepAnalysis(result.extractions, result.depGraph, root);
    if (deepResult.ran && deepResult.annotations.size > 0) {
      deepSystemOverview = deepResult.systemOverview;
      deepRules = buildDeepRules(result.extractions, deepResult.annotations);
    }
  }

  // Step 4: Generate skeleton and enrich it
  // Auto-scale token budget: small projects get 800, large ones up to 3000
  // Auto budget: 800 base + 15 tokens per file, capped at 4000
  // ~20 files → 1100, ~70 files → 1850, ~200 files → 3800
  const maxTokens = opts.maxTokens === "auto"
    ? Math.min(4000, Math.max(800, Math.round(800 + scan.totalFiles * 15)))
    : parseInt(opts.maxTokens, 10);

  console.log("  Generating skeleton...");
  const skeleton = generateSkeleton(stack, result.extractions, result.depGraph, result.complexityScores, { maxTokens });
  const skeletonTokens = countTokens(skeleton);
  console.log(`  Skeleton: ${formatTokens(skeletonTokens)} tokens`);

  // Step 5: Generate module index + contracts
  console.log("  Generating module index...");
  const moduleIndex = generateModuleIndex(result.extractions, result.depGraph, result.complexityScores, root);
  writeModuleIndex(root, moduleIndex);
  console.log(`  Indexed ${moduleIndex.modules.length} modules`);

  console.log("  Generating contracts...");
  generateSimpleContracts(moduleIndex, result.extractions, result.depGraph, root);

  // Step 6: Enrich skeleton with extracted context
  const convText = formatConventions(result.conventions);
  let enrichedSkeleton = skeleton;
  if (convText) {
    enrichedSkeleton += "\n" + convText;
  }
  if (result.testMappings.length > 0) {
    enrichedSkeleton += "\nTests: " + result.testMappings.length + " source files have matching test files";
  }
  const scriptsText = formatScripts(result.scripts);
  if (scriptsText) enrichedSkeleton += "\n" + scriptsText;
  const schemasText = formatSchemas(result.schemas);
  if (schemasText) enrichedSkeleton += "\n" + schemasText;
  const routesText = formatRoutes(result.routes);
  if (routesText) enrichedSkeleton += "\n" + routesText;
  const envText = formatEnvVars(result.envVars);
  if (envText) enrichedSkeleton += "\n" + envText;
  const depsText = formatDeps(result.deps);
  if (depsText) enrichedSkeleton += "\n" + depsText;

  // System overview from deep analysis goes at the top of the skeleton
  // (small, high-signal, worth always-loading).
  if (deepSystemOverview) {
    enrichedSkeleton =
      `## System overview\n\n${deepSystemOverview}\n\n${enrichedSkeleton}`;
  }

  // Step 7: Write all outputs
  const outputSummary = writeOutputs(root, result, enrichedSkeleton, convText, {
    skipHooks: opts.skipHooks,
  });

  // Write deep rules into .claude/rules/. Path-scoped frontmatter makes them
  // load only when Claude touches files in that dir.
  if (deepRules.size > 0 && !opts.skipRules) {
    const rulesDir = join(root, ".claude", "rules");
    if (!existsSync(rulesDir)) mkdirSync(rulesDir, { recursive: true });
    for (const [filename, content] of deepRules) {
      writeFileSync(join(rulesDir, filename), content);
    }
    console.log(`  Wrote ${deepRules.size} deep rule files to .claude/rules/`);
  }

  // Step 8: Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("");
  console.log(`  Done in ${elapsed}s`);
  console.log("");
  console.log("  Output:");
  console.log(`    CLAUDE.md            — skeleton + conventions (~${formatTokens(countTokens(enrichedSkeleton))} tokens)`);
  console.log(`    .cursorrules         — Cursor IDE context`);
  console.log(`    AGENTS.md            — cross-tool context`);
  console.log(`    .github/copilot-instructions.md — GitHub Copilot context`);
  console.log(`    codex.md             — OpenAI Codex CLI context`);
  console.log(`    .briefed/contracts/     — module contracts (${moduleIndex.modules.length} modules)`);
  console.log(`    .briefed/test-map.json  — test mappings (${result.testMappings.length} pairs, ${result.testMappings.reduce((s, t) => s + t.testCount, 0)} tests)`);
  if (!opts.skipHooks) {
    console.log(`    .claude/settings.json — adaptive hooks`);
  }
  if (outputSummary.gitHookInstalled) {
    console.log(`    .git/hooks/post-commit — auto-updates on every commit`);
  }
  // Context budget report
  const skeletonTk = countTokens(enrichedSkeleton);
  const totalAlwaysLoaded = skeletonTk;
  const totalPerPrompt = 500; // average contract injection

  console.log("");
  console.log("  Context budget:");
  console.log(`    Always loaded:   ~${formatTokens(totalAlwaysLoaded)} tokens (skeleton + conventions)`);
  console.log(`    Per prompt:      ~${formatTokens(totalPerPrompt)} tokens (adaptive module contracts)`);
  console.log(`    Estimated total: ~${formatTokens(totalAlwaysLoaded + totalPerPrompt)} tokens/prompt`);
  console.log("");
  console.log(`  Without briefed, Claude spends ~5K-10K tokens reading files for orientation.`);
  console.log(`  Estimated savings: ~${formatTokens(Math.max(0, 7000 - totalAlwaysLoaded - totalPerPrompt))} tokens/prompt`);
  console.log("");
  console.log("  Context auto-updates on every commit. No CI needed.");
  console.log("  Works with: Claude Code, Cursor, Copilot, and any tool that reads AGENTS.md");
}
