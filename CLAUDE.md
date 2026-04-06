
<!-- briefed:start -->
# briefed: typescript, javascript project
Stack: typescript, javascript
Files: 72 source files across 7 directories

## src/extract/ (38 files)
signatures.ts ★15
  interface Symbol — Extracted symbol from a source file. [2 callers]
  type SymbolKind = | "function"
  | "class"
  | "interface"
  | "type"
  | "enu...
  interface ImportRef — Import reference found in a file.
  interface FileExtraction — True for `import type { ... }` — erased at runtime, doesn't create real coupl... [14 callers]
  extractFile(filePath: string, _rootPath: string): FileExtraction — Extract symbols and imports from a source file. [3 callers]
ast.ts ★2: extractWithAst — AST-based extraction for TypeScript/JavaScript files using the TS compiler API.
depgraph.ts ★9
  interface DepGraph [7 callers]
  buildDepGraph(extractions: FileExtraction[], root: string): DepGraph — Build a dependency graph from file extractions. [4 callers]
routes.ts ★6
  interface Route [2 callers]
  extractRoutes(root: string): Route[] — Extract API routes from the codebase. [4 callers]
  formatRoutes(routes: Route[]): string — Format routes for skeleton inclusion. [2 callers]
scanner.ts ★7
  interface DiscoveredFile
  interface ScanResult [2 callers]
  scanFiles(root: string): ScanResult — Discover all parseable source files in a project. [5 callers]
gotchas.ts ★3
  interface Gotcha [2 callers]
  type GotchaCategory = | "important_comment"   // TODO/HACK/NOTE/WARNING/FIXME with...
  extractGotchas(filePath: string): Gotcha[] — Extract gotchas from a source file. [2 callers]
schema.ts ★4
  interface SchemaModel
  interface SchemaField
  interface SchemaRelation
  extractSchemas(root: string): SchemaModel[] — Extract database schema from ORM definition files. [3 callers]
  formatSchemas(models: SchemaModel[]): string — Format schemas for skeleton inclusion.
monorepo.ts ★3
  interface WorkspaceInfo
  interface WorkspacePackage
  detectMonorepo(cwd: string): WorkspaceInfo — Detect if we're in a monorepo and identify packages. [3 callers]
env.ts ★3
  interface EnvVar
  extractEnvVars(root: string): EnvVar[] — Extract environment variables the project expects. [2 callers]
  formatEnvVars(vars: EnvVar[]): string — Format env vars for skeleton inclusion. [2 callers]
scripts.ts ★3
  interface ProjectScripts
  extractScripts(root: string): ProjectScripts — Extract build/test/dev commands from package.json, Makefile, etc. [2 callers]
  formatScripts(scripts: ProjectScripts): string — Format scripts for skeleton inclusion. [2 callers]
security.ts ★2: SecurityWarning, SecurityIssueType, isSensitiveFile — Check if a file should be excluded from context output for security reasons., scanForSecrets — Scan a file for sensitive data patterns., redactSecrets — Redact sensitive values from text before including in context.
complexity.ts ★4
  interface ComplexityScore [3 callers]
  computeComplexity(extraction: FileExtraction, depGraph: DepGraph): ComplexityScore — Compute complexity score for a file. [2 callers]
deps.ts ★3
  interface DepInfo
  interface DepsResult — Package name as imported (e.g. "stripe", "
  extractDeps(root: string, extractions: FileExtraction[]): DepsResult — Extract external dependency context. Surfaces the installed version and [2 callers]
  formatDeps(deps: DepsResult, top: number): string — Format the top dependencies for the skeleton. When Context7 is present, [2 callers]
  __test — Exposed for tests.
cycles.ts ★3
  detectCycles(depGraph: DepGraph): string[][] — Detect import cycles in the dependency graph using iterative DFS. [2 callers]
  formatCycles(cycles: string[][]): string — Format detected cycles as a skeleton section. [2 callers]
staleness.ts ★1: StalenessReport, checkStaleness — Check if the briefed context is stale (source files changed since last index)., formatStaleness — Format staleness report for display.
cross-layer.ts ★3
  interface RouteCall
  interface CrossLayerGraph — HTTP method (GET, POST, etc.)
  extractRouteCalls(root: string, scan: ScanResult, routes: Route[]): CrossLayerGraph — Extract HTTP calls from frontend files and link them to backend routes. [2 callers]
  formatRouteCalls(graph: CrossLayerGraph): string — Format the cross-layer graph for skeleton inclusion.
pipeline.ts ★2
  interface ExtractionResult
  runExtractionPipeline(root: string, scan: ScanResult, stack: StackInfo): ExtractionResult — Run all extraction steps and return the collected results.
churn.ts ★2: FileChurn, extractChurn — Compute commit churn per file over a time window. Files that change a, formatChurn — Format the top hot files for inclusion in the skeleton.
conventions.ts ★2: ProjectConventions, detectConventions — Auto-detect project conventions from code patterns., formatConventions — Format conventions for inclusion in CLAUDE.md or rules.
frontend.ts ★2
  interface PageRoute
  interface ComponentInfo
  interface FrontendInfo
  extractFrontend(root: string): FrontendInfo — Extract frontend-specific context: pages, components, state, styling.
  formatFrontend(info: FrontendInfo): string — Format frontend info for skeleton inclusion.
infra.ts ★2: InfraInfo, InfraService, extractInfra — Extract infrastructure configuration., formatInfra — Format infra info for skeleton inclusion.
usage-examples.ts ★2: UsageExample, findUsageExamples — Find how functions/classes are actually USED in the codebase., formatUsageExamples — Format usage examples for context injection.
error-patterns.ts ★1: ErrorPattern, ErrorPatternType, detectErrorPatterns — Detect the project's error handling patterns.
history.ts ★1: FileHistory, CommitInfo, getFileHistory — Extract recent git history for files., getBatchHistory — Get history for multiple files efficiently.
tests.ts ★1: TestMapping, findTestMappings — Find test files that correspond to source files.
ast.test.ts: 
complexity.test.ts: 
cycles.test.ts: 
depgraph.test.ts: 
deps.test.ts: 
routes.test.ts: GET

## src/utils/ (7 files)
log.ts ★9
  debug(msg: string): void — Lightweight logging utilities. [9 callers]
pagerank.ts ★2: GraphNode — Simple PageRank implementation for dependency graph ranking., computePageRank — Compute PageRank scores for a file dependency graph., computeRefCounts — Get reference count (in-degree) for each node.
detect.ts ★6
  interface StackInfo [2 callers]
  detectStack(root: string): StackInfo — Detect the project's tech stack from config files [3 callers]
  extToLanguage(ext: string): string | null — Map file extension to language name
  PARSEABLE_EXTENSIONS — File extensions we should parse [2 callers]
  SKIP_DIRS — Directories to always skip [2 callers]
tokens.ts ★6
  countTokens(text: string): number — Estimate token count for a string [5 callers]
pagerank.test.ts: 

<!-- briefed skeleton: 36 files, ~1860 tokens -->
Conventions: camelCase for functions and methods, PascalCase for types, classes, and interfaces, uses try/catch for error handling, prefers named exports over default exports
Tests: 19 source files have matching test files
Error handling:
  - Uses Result/Either types for error propagation (not exceptions)
  - Prefers try/catch wrapping over throwing
  - Uses guard clauses (early returns on validation failure)
  - Uses schema validation (Zod/Joi/Yup) for input validation
Usage examples:
  countTokens: const tokens = countTokens(content); (doctor.ts:30)
  countTokens: const skeletonTokens = countTokens(skeleton); (init.ts:71)
  detectMonorepo: const mono = detectMonorepo(root); (init.ts:37)
  detectMonorepo: const mono = detectMonorepo(root); (plan.ts:24)
  detectStack: const stack = detectStack(root); (init.ts:46)
  detectStack: const stack = detectStack(root); (plan.ts:30)
  scanFiles: const scan = scanFiles(root); (init.ts:51)
  scanFiles: const scan = scanFiles(root); (plan.ts:34)
  formatTokens: console.log(`  Skeleton: ${formatTokens(skeletonTokens)} tokens`); (init.ts:72)
  formatTokens: console.log(`    Skeleton (CLAUDE.md):   ~${formatTokens(estAlwaysLoaded)} tokens (always loaded)`); (plan.ts:104)
  buildDepGraph: const graph = buildDepGraph( (cycles.test.ts:25)
  buildDepGraph: const graph = buildDepGraph(extractions, "/project"); (depgraph.test.ts:25)
  extractFile: const extraction = extractFile(file.absolutePath, root); (pipeline.ts:115)
  extractFile: const result = extractFile(file, tmpDir); (signatures.test.ts:25)
  extractSchemas: schemas = extractSchemas(root); (pipeline.ts:258)
  extractSchemas: const schemas = extractSchemas(root); (blast-radius.ts:54)
  extractRoutes: routes = extractRoutes(root); (pipeline.ts:266)
  extractRoutes: const routes = extractRoutes(tmpDir); (routes.test.ts:35)
  loadCachedExtractions: const { depGraph } = loadCachedExtractions(root); (blast-radius.ts:14)
  loadCachedExtractions: const { extractions, depGraph } = loadCachedExtractions(root); (find-usages.ts:26)
Commands:
  build: tsc
  dev: tsc --watch
  test: vitest run
  lint: tsc --noEmit
  start: node dist/cli.js
Required env: config: BRIEFED_DEBUG, USERPROFILE, APPDATA
Hot files (last 90d, touch carefully):
  - src/commands/init.ts (15 commits, 2 authors)
  - src/cli.ts (13 commits, 2 authors)
  - src/deliver/hooks.ts (10 commits, 2 authors)
  - src/extract/routes.ts (7 commits, 2 authors)
  - src/extract/depgraph.ts (7 commits, 2 authors)
  - src/generate/index-file.ts (7 commits, 2 authors)
  - src/generate/skeleton.ts (7 commits, 2 authors)
  - src/extract/pipeline.ts (6 commits, 2 authors)
  - src/extract/signatures.ts (6 commits, 2 authors)
  - src/bench/metrics.ts (6 commits, 2 authors)
External deps:
  - vitest@4.1.2 — 20 imports
  - glob@13.0.6 — 7 imports
  - @modelcontextprotocol/sdk@1.29.0 — 6 imports
  - express@5.2.1 — 2 imports
  - commander@13.1.0 — 1 imports
  - typescript@5.9.3 — 1 imports
  - next-auth — 1 imports
  - dep — 1 imports
  - js-yaml@4.1.1 — 1 imports
  - zod@4.3.6 — 1 imports
<!-- briefed:end -->
