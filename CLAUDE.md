<!-- cctx:start -->
# cctx: typescript, javascript project
Stack: typescript, javascript
Files: 16 source files across 5 directories

## src/extract/ (5 files)
complexity.ts: ComplexityScore
depgraph.ts: DepGraph
gotchas.ts: Gotcha, extractGotchas
scanner.ts: DiscoveredFile, ScanResult, scanFiles
signatures.ts: Symbol, ImportRef, FileExtraction, extractFile

## src/utils/ (3 files)
detect.ts: StackInfo, detectStack, extToLanguage, PARSEABLE_EXTENSIONS, SKIP_DIRS
pagerank.ts: GraphNode, computeRefCounts
tokens.ts: countTokens, formatTokens, formatBytes

## src/commands/ (2 files)
init.ts: initCommand
stats.ts: statsCommand

## src/deliver/ (2 files)
claudemd.ts: updateClaudeMd, saveSkeletonFile
hooks.ts: installHooks, generateHookScripts

## src/generate/ (3 files)
index-file.ts: ModuleEntry, ModuleIndex, writeModuleIndex
skeleton.ts: SkeletonOptions

<!-- cctx skeleton: 14 files, ~228 tokens -->
<!-- cctx:end -->

<!-- briefed:start -->
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

<!-- briefed skeleton: 17 files, ~1018 tokens -->
Conventions: camelCase for functions and methods, PascalCase for types, classes, and interfaces, uses try/catch for error handling, prefers named exports over default exports
Tests: 15 source files have matching test files
Error handling:
  - Uses Result/Either types for error propagation (not exceptions)
  - Prefers try/catch wrapping over throwing
  - Uses guard clauses (early returns on validation failure)
  - Uses schema validation (Zod/Joi/Yup) for input validation
Usage examples:
  countTokens: const tokens = countTokens(content); (doctor.ts:30)
  countTokens: const skeletonTokens = countTokens(skeleton); (init.ts:61)
  countTokens: const tokens = countTokens(skeleton); (stats.ts:19)
  scanFiles: const scan = scanFiles(root); (init.ts:48)
  scanFiles: const result = scanFiles(tmpDir); (scanner.test.ts:21)
  scanFiles: const scan = scanFiles(root); (blast-radius.ts:15)
  formatTokens: console.log(`  Skeleton: ${formatTokens(skeletonTokens)} tokens`); (init.ts:62)
  formatTokens: console.log(`  L1 Skeleton:     ${formatTokens(tokens)} tokens (${skeleton.length} chars)`); (stats.ts:20)
  formatTokens: expect(formatTokens(500)).toBe("500"); (tokens.test.ts:38)
  buildDepGraph: const graph = buildDepGraph(extractions, "/project"); (depgraph.test.ts:25)
  buildDepGraph: const depGraph = buildDepGraph(extractions, root); (pipeline.ts:95)
  buildDepGraph: const depGraph = buildDepGraph(extractions, root); (blast-radius.ts:27)
  extractFile: const extraction = extractFile(file.absolutePath, root); (pipeline.ts:81)
  extractFile: const result = extractFile(file, tmpDir); (signatures.test.ts:25)
  extractFile: const ext = extractFile(f.absolutePath, root); (blast-radius.ts:18)
  extractSchemas: schemas = extractSchemas(root); (pipeline.ts:186)
  extractSchemas: const schemas = extractSchemas(root); (blast-radius.ts:67)
  extractSchemas: const schemas = extractSchemas(root); (schema-lookup.ts:8)
  extractRoutes: routes = extractRoutes(root); (pipeline.ts:194)
  extractRoutes: const routes = extractRoutes(root); (blast-radius.ts:61)
Commands:
  build: tsc
  dev: tsc --watch
  test: vitest run
  lint: tsc --noEmit
  start: node dist/cli.js
Required env: config: BRIEFED_DEBUG, APPDATA
<!-- briefed:end -->
