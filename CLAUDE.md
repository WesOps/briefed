
<!-- briefed:start -->
# briefed: typescript, javascript project
Stack: typescript, javascript
Files: 74 source files across 7 directories

## src/extract/ (41 files)
signatures.ts ★13
  interface Symbol — Extracted symbol from a source file. [3 callers]
  type SymbolKind = | "function"
  | "class"
  | "interface"
  | "type"
  | "enu...
  interface ImportRef — Import reference found in a file.
  interface FileExtraction — Import reference found in a file. [12 callers]
  extractFile(filePath: string, _rootPath: string): FileExtraction — Extract symbols and imports from a source file. [3 callers]
ast.ts ★2: extractWithAst — AST-based extraction for TypeScript/JavaScript files using the TS compiler API.
depgraph.ts ★8
  interface DepGraph [7 callers]
  buildDepGraph(extractions: FileExtraction[], root: string): DepGraph — Build a dependency graph from file extractions. [3 callers]
gotchas.ts ★3
  interface Gotcha [2 callers]
  type GotchaCategory = | "important_comment"   // TODO/HACK/NOTE/WARNING/FIXME with...
  extractGotchas(filePath: string): Gotcha[] — Extract gotchas from a source file. [2 callers]
scanner.ts ★5
  interface DiscoveredFile
  interface ScanResult
  scanFiles(root: string): ScanResult — Discover all parseable source files in a project. [4 callers]
routes.ts ★4
  interface Route
  extractRoutes(root: string): Route[] — Extract API routes from the codebase. [3 callers]
  formatRoutes(routes: Route[]): string — Format routes for skeleton inclusion.
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
complexity.ts ★5
  interface ComplexityScore [4 callers]
  computeComplexity(extraction: FileExtraction, depGraph: DepGraph): ComplexityScore — Compute complexity score for a file. [2 callers]
env.ts ★3
  interface EnvVar
  extractEnvVars(root: string): EnvVar[] — Extract environment variables the project expects. [2 callers]
  formatEnvVars(vars: EnvVar[]): string — Format env vars for skeleton inclusion. [2 callers]
scripts.ts ★3
  interface ProjectScripts
  extractScripts(root: string): ProjectScripts — Extract build/test/dev commands from package.json, Makefile, etc. [2 callers]
  formatScripts(scripts: ProjectScripts): string — Format scripts for skeleton inclusion. [2 callers]
security.ts ★2: SecurityWarning, SecurityIssueType, isSensitiveFile — Check if a file should be excluded from context output for security reasons., scanForSecrets — Scan a file for sensitive data patterns., redactSecrets — Redact sensitive values from text before including in context.
staleness.ts ★1: StalenessReport, checkStaleness — Check if the briefed context is stale (source files changed since last index)., formatStaleness — Format staleness report for display.
pipeline.ts ★2
  interface ExtractionResult
  runExtractionPipeline(root: string, scan: ScanResult, stack: StackInfo): ExtractionResult — Run all extraction steps and return the collected results.
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
history.ts ★1: FileHistory, CommitInfo, getFileHistory — Extract recent git history for files., getBatchHistory — Get history for multiple files efficiently., formatHistory — Format file history for context injection.
tests.ts ★1: TestMapping, findTestMappings — Find test files that correspond to source files., formatTestContext — Format test mappings for inclusion in the skeleton or contracts.
api-schema.ts: ApiSchemaInfo, ApiSchemaEndpoint, extractApiSchema — Extract OpenAPI/Swagger and GraphQL schema information., formatApiSchema
ast.test.ts: 
auth.ts: AuthInfo, extractAuth, formatAuth
caching.ts: CachePattern, extractCaching, formatCaching
complexity.test.ts: 
deep.ts: deepAnnotate — Deep analysis: use Claude to generate one-line behavioral descriptions, mergeAnnotations — Merge deep annotations into extractions (mutates in place)., generateDeepRules — Generate .claude/rules/ files with behavioral descriptions per directory., generateSystemOverview — Generate a high-level system overview — how modules connect and data flows.
depgraph.test.ts: 
deprecations.ts: Deprecation, extractDeprecations, formatDeprecations
events.ts: EventContract, extractEvents — Extract event/webhook/message contracts., formatEvents
feature-flags.ts: FeatureFlag, extractFeatureFlags, formatFeatureFlags
integrations.ts: Integration, extractIntegrations, formatIntegrations
jobs.ts: BackgroundJob, extractJobs, formatJobs
migrations.ts: Migration, extractMigrations, formatMigrations

## src/utils/ (7 files)
log.ts ★9
  debug(msg: string): void — Lightweight logging utilities. [9 callers]
  warn(msg: string): void
tokens.ts ★6
  countTokens(text: string): number — Estimate token count for a string [5 callers]
  formatTokens(count: number): string — Format token count for display [4 callers]
  formatBytes(bytes: number): string — Format byte count for display
detect.ts ★6
  interface StackInfo [2 callers]
  detectStack(root: string): StackInfo — Detect the project's tech stack from config files [3 callers]
  extToLanguage(ext: string): string | null — Map file extension to language name
  PARSEABLE_EXTENSIONS — File extensions we should parse [2 callers]
  SKIP_DIRS — Directories to always skip [2 callers]
pagerank.ts ★2: GraphNode — Simple PageRank implementation for dependency graph ranking., computePageRank — Compute PageRank scores for a file dependency graph., computeRefCounts — Get reference count (in-degree) for each node.
pagerank.test.ts: 

## src/mcp/ (7 files)
cached-loader.ts ★2: loadCachedExtractions — Load extractions from the SHA256 cache if available, otherwise extract live.

<!-- briefed skeleton: 40 files, ~1896 tokens -->
Conventions: camelCase for functions and methods, PascalCase for types, classes, and interfaces, uses try/catch for error handling, prefers named exports over default exports
Tests: 15 source files have matching test files
Error handling:
  - Uses Result/Either types for error propagation (not exceptions)
  - Prefers try/catch wrapping over throwing
  - Uses guard clauses (early returns on validation failure)
  - Uses schema validation (Zod/Joi/Yup) for input validation
Usage examples:
  countTokens: const tokens = countTokens(content); (doctor.ts:30)
  countTokens: const skeletonTokens = countTokens(skeleton); (init.ts:67)
  detectMonorepo: const mono = detectMonorepo(root); (init.ts:33)
  detectMonorepo: const mono = detectMonorepo(root); (plan.ts:24)
  detectStack: const stack = detectStack(root); (init.ts:42)
  detectStack: const stack = detectStack(root); (plan.ts:30)
  scanFiles: const scan = scanFiles(root); (init.ts:47)
  scanFiles: const scan = scanFiles(root); (plan.ts:34)
  formatTokens: console.log(`  Skeleton: ${formatTokens(skeletonTokens)} tokens`); (init.ts:68)
  formatTokens: console.log(`    Skeleton (CLAUDE.md):   ~${formatTokens(estAlwaysLoaded)} tokens (always loaded)`); (plan.ts:104)
  buildDepGraph: const graph = buildDepGraph(extractions, "/project"); (depgraph.test.ts:25)
  buildDepGraph: const depGraph = buildDepGraph(extractions, root); (pipeline.ts:136)
  extractFile: const extraction = extractFile(file.absolutePath, root); (pipeline.ts:104)
  extractFile: const result = extractFile(file, tmpDir); (signatures.test.ts:25)
  extractSchemas: schemas = extractSchemas(root); (pipeline.ts:227)
  extractSchemas: const schemas = extractSchemas(root); (blast-radius.ts:52)
  extractRoutes: routes = extractRoutes(root); (pipeline.ts:235)
  extractRoutes: const routes = extractRoutes(root); (blast-radius.ts:46)
  removeGitHook: removeGitHook(root); (cli.ts:68)
  removeGitHook: removeGitHook(tmpDir); (git-hook.test.ts:82)
Commands:
  build: tsc
  dev: tsc --watch
  test: vitest run
  lint: tsc --noEmit
  start: node dist/cli.js
Required env: config: BRIEFED_DEBUG, APPDATA
<!-- briefed:end -->
