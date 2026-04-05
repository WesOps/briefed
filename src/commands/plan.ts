import { resolve, join } from "path";
import { existsSync } from "fs";
import { detectStack } from "../utils/detect.js";
import { scanFiles } from "../extract/scanner.js";
import { detectMonorepo } from "../extract/monorepo.js";
import { formatTokens } from "../utils/tokens.js";

interface PlanOptions {
  repo: string;
}

/**
 * Dry-run: scan the project and show what briefed will produce,
 * estimated token costs, and which features apply — without writing anything.
 */
export function planCommand(opts: PlanOptions) {
  const root = resolve(opts.repo);
  const startTime = Date.now();

  console.log(`briefed plan — previewing ${root}`);
  console.log("");

  // Detect monorepo
  const mono = detectMonorepo(root);
  if (mono.isMonorepo) {
    console.log(`  Monorepo: yes (${mono.packages.length} packages)`);
  }

  // Detect stack
  const stack = detectStack(root);
  console.log(`  Stack: ${[...stack.languages, ...stack.frameworks].join(", ")}${stack.dbORM ? ` + ${stack.dbORM}` : ""}`);

  // Scan files (fast — just directory walk, no extraction)
  const scan = scanFiles(root);
  console.log(`  Source files: ${scan.totalFiles}`);
  console.log(`  Total size: ${(scan.totalBytes / 1024).toFixed(0)} KB`);
  console.log("");

  if (scan.totalFiles === 0) {
    console.log("  No source files found. Nothing to index.");
    return;
  }

  // File breakdown by extension
  const byExt = [...scan.filesByExtension.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  console.log("  Files by type:");
  for (const [ext, count] of byExt) {
    console.log(`    ${ext}: ${count}`);
  }
  console.log("");

  // Feature detection
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
    existsSync(join(root, "fly.toml"));

  const tsJsFiles = (scan.filesByExtension.get(".ts") || 0) +
    (scan.filesByExtension.get(".tsx") || 0) +
    (scan.filesByExtension.get(".js") || 0) +
    (scan.filesByExtension.get(".jsx") || 0);

  console.log("  Features that will activate:");
  console.log(`    Symbol extraction (${scan.totalFiles} files)`);
  console.log(`    Dependency graph + PageRank`);
  console.log(`    Complexity scoring`);
  console.log(`    Convention detection`);
  console.log(`    Usage examples`);
  console.log(`    Error pattern detection`);
  console.log(`    Test file mapping`);
  console.log(`    Git history analysis`);
  if (tsJsFiles > 0) console.log(`    AST extraction (${tsJsFiles} TS/JS files)`);
  if (tsJsFiles > 0) console.log(`    Function-level call graph`);
  if (hasBackend) console.log(`    API route extraction`);
  if (hasORM) console.log(`    Database schema extraction (${stack.dbORM})`);
  if (hasFrontend) console.log(`    Frontend context (pages, components, state)`);
  if (hasInfra) console.log(`    Infrastructure detection`);
  console.log(`    Gotcha extraction (TODOs, guards, side effects)`);
  console.log("");

  // Token budget estimate
  const skeletonBudget = Math.min(4000, Math.max(800, Math.round(800 + scan.totalFiles * 15)));
  const estConventions = 150;
  const estExtras = (hasBackend ? 200 : 0) + (hasORM ? 200 : 0) + (hasFrontend ? 200 : 0) + (hasInfra ? 100 : 0);
  const estAlwaysLoaded = skeletonBudget + estConventions + estExtras;
  const estPerPrompt = 500;
  const estPerFile = 50;

  console.log("  Estimated token usage:");
  console.log(`    Skeleton (CLAUDE.md):   ~${formatTokens(estAlwaysLoaded)} tokens (always loaded)`);
  console.log(`    Per prompt (contracts): ~${formatTokens(estPerPrompt)} tokens (adaptive injection)`);
  console.log(`    Per file edit (rules):  ~${formatTokens(estPerFile)} tokens (path-scoped gotchas)`);
  console.log(`    ─────────────────────────────────────`);
  console.log(`    Estimated per prompt:   ~${formatTokens(estAlwaysLoaded + estPerPrompt + estPerFile)} tokens`);
  console.log("");
  console.log(`    Without briefed, Claude typically spends ~5K-10K tokens`);
  console.log(`    reading files for orientation on each task.`);
  console.log("");

  // Output files that will be created
  console.log("  Files that will be created/updated:");
  console.log(`    CLAUDE.md              — skeleton + conventions`);
  console.log(`    .cursorrules           — Cursor IDE context`);
  console.log(`    AGENTS.md              — cross-tool context`);
  console.log(`    .github/copilot-instructions.md`);
  console.log(`    codex.md               — OpenAI Codex CLI`);
  console.log(`    .claude/settings.json  — adaptive hooks + MCP server`);
  console.log(`    .claude/rules/         — path-scoped gotchas`);
  console.log(`    .briefed/              — index, contracts, hooks, cache`);
  console.log(`    .git/hooks/post-commit — auto-update on commit`);
  console.log("");

  // MCP tools
  console.log("  MCP tools (on-demand queries):");
  console.log(`    briefed_blast_radius   — impact analysis for file changes`);
  console.log(`    briefed_symbol         — look up any function/class/type`);
  if (hasORM) console.log(`    briefed_schema         — database model lookup`);
  if (hasBackend) console.log(`    briefed_routes         — API endpoint lookup`);
  console.log("");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Scanned in ${elapsed}s. Run \`briefed init\` to generate.`);
}
