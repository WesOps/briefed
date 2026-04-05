<!-- briefed:agents:start -->
# briefed: typescript, javascript project
Stack: typescript, javascript
Files: 71 source files across 7 directories

## src/extract/ (41 files)
signatures.ts ★13
  interface Symbol — Extracted symbol from a source file.
  type SymbolKind = | "function"
  | "class"
  | "interface"
  | "type"
  | "enu...
  interface ImportRef — Import reference found in a file.
  interface FileExtraction — Import reference found in a file.
  extractFile(filePath: string, _rootPath: string): FileExtraction — Extract symbols and imports from a source file.
ast.ts ★2: extractWithAst — AST-based extraction for TypeScript/JavaScript files using the TS compiler API.
depgraph.ts ★8
  interface DepGraph
  buildDepGraph(extractions: FileExtraction[], root: string): DepGraph — Build a dependency graph from file extractions.
gotchas.ts ★3
  interface Gotcha
  type GotchaCategory = | "important_comment"   // TODO/HACK/NOTE/WARNING/FIXME with...
  extractGotchas(filePath: string): Gotcha[] — Extract gotchas from a source file.
routes.ts ★4
  interface Route
  extractRoutes(root: string): Route[] — Extract API routes from the codebase.
  formatRoutes(routes: Route[]): string — Format routes for skeleton inclusion.
schema.ts ★4
  interface SchemaModel
  interface SchemaField
  interface SchemaRelation
  extractSchemas(root: string): SchemaModel[] — Extract database schema from ORM definition files.
  formatSchemas(models: SchemaModel[]): string — Format schemas for skeleton inclusion.
scanner.ts ★4
  interface DiscoveredFile
  interface ScanResult
  scanFiles(root: string): ScanResult — Discover all parseable source files in a project.
complexity.ts ★5
  interface ComplexityScore
  computeComplexity(extraction: FileExtraction, depGraph: DepGraph): ComplexityScore — Compute complexity score for a file.
env.ts ★3
  interface EnvVar
  extractEnvVars(root: string): EnvVar[] — Extract environment variables the project expects.
  formatEnvVars(vars: EnvVar[]): string — Format env vars for skeleton inclusion.
scripts.ts ★3
  interface ProjectScripts
  extractScripts(root: string): ProjectScripts — Extract build/test/dev commands from package.json, Makefile, etc.
  formatScripts(scripts: ProjectScripts): string — Format scripts for skeleton inclusion.
monorepo.ts ★2: WorkspaceInfo, WorkspacePackage, detectMonorepo — Detect if we're in a monorepo and identify packages.
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
  debug(msg: string): void — Lightweight logging utilities.
  warn(msg: string): void
tokens.ts ★5
  countTokens(text: string): number — Estimate token count for a string
  formatTokens(count: number): string — Format token count for display
  formatBytes(bytes: number): string — Format byte count for display
pagerank.ts ★2: GraphNode — Simple PageRank implementation for dependency graph ranking., computePageRank — Compute PageRank scores for a file dependency graph., computeRefCounts — Get reference count (in-degree) for each node.
detect.ts ★5
  interface StackInfo
  detectStack(root: string): StackInfo — Detect the project's tech stack from config files
  extToLanguage(ext: string): string | null — Map file extension to language name
  PARSEABLE_EXTENSIONS — File extensions we should parse
  SKIP_DIRS — Directories to always skip
pagerank.test.ts: 

## src/deliver/ (7 files)
git-hook.ts ★3
  installGitHook(root: string) — Install a git post-commit hook that auto-updates briefed context.
  removeGitHook(root: string) — Remove briefed's git hook.
claudemd.ts ★1: updateClaudeMd — Append or update the briefed skeleton section in CLAUDE.md., saveSkeletonFile — Save the skeleton as a standalone file in .briefed/ for hook re-injection.

<!-- briefed skeleton: 41 files, ~1872 tokens -->
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
  scanFiles: const scan = scanFiles(root); (init.ts:47)
  scanFiles: const result = scanFiles(tmpDir); (scanner.test.ts:21)
  formatTokens: console.log(`  Skeleton: ${formatTokens(skeletonTokens)} tokens`); (init.ts:68)
  formatTokens: console.log(`  L1 Skeleton:     ${formatTokens(tokens)} tokens (${skeleton.length} chars)`); (stats.ts:20)
  buildDepGraph: const graph = buildDepGraph(extractions, "/project"); (depgraph.test.ts:25)
  buildDepGraph: const depGraph = buildDepGraph(extractions, root); (pipeline.ts:136)
  extractFile: const extraction = extractFile(file.absolutePath, root); (pipeline.ts:104)
  extractFile: const result = extractFile(file, tmpDir); (signatures.test.ts:25)
  extractSchemas: schemas = extractSchemas(root); (pipeline.ts:227)
  extractSchemas: const schemas = extractSchemas(root); (blast-radius.ts:67)
  extractRoutes: routes = extractRoutes(root); (pipeline.ts:235)
  extractRoutes: const routes = extractRoutes(root); (blast-radius.ts:61)
  removeGitHook: removeGitHook(root); (cli.ts:61)
  removeGitHook: removeGitHook(tmpDir); (git-hook.test.ts:82)
  detectMonorepo: const mono = detectMonorepo(root); (init.ts:33)
  detectMonorepo: const info = detectMonorepo(tmpDir); (monorepo.test.ts:23)
  detectStack: const stack = detectStack(root); (init.ts:42)
  detectStack: const info = detectStack(tmpDir); (detect.test.ts:115)
Commands:
  build: tsc
  dev: tsc --watch
  test: vitest run
  lint: tsc --noEmit
  start: node dist/cli.js
Required env: config: BRIEFED_DEBUG, APPDATA

Conventions: camelCase for functions and methods, PascalCase for types, classes, and interfaces, uses try/catch for error handling, prefers named exports over default exports
<!-- briefed:agents:end -->
