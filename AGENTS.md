<!-- briefed:agents:start -->
# briefed: typescript, javascript project
Stack: typescript, javascript
Files: 111 source files across 10 directories

## src/extract/ (32 files)
signatures.ts ★16
  interface Symbol — Extracted symbol from a source file. [4 callers]
  type SymbolKind = | "function"
  | "class"
  | "interface"
  | "type"
  | "enu...
  interface ImportRef — Import reference found in a file.
  interface FileExtraction — True for `import type { ... }` — erased at runtime, doesn't create real coupl... [15 callers]
  extractFile(filePath: string, _rootPath: string, content?: string): FileExtraction — Extract symbols and imports from a source file. [3 callers]
ast.ts ★2: extractWithAst — AST-based extraction for TypeScript/JavaScript files using the TS compiler API.
depgraph.ts ★8
  interface DepGraph [7 callers]
  buildDepGraph(extractions: FileExtraction[], root: string): DepGraph — Build a dependency graph from file extractions. [3 callers]
routes.ts ★6
  interface Route [2 callers]
  extractRoutes(root: string): Route[] — Extract API routes from the codebase. [4 callers]
  formatRoutes(routes: Route[]): string — Format routes for skeleton inclusion. [2 callers]
scanner.ts ★5
  interface DiscoveredFile
  interface ScanResult
  scanFiles(root: string): ScanResult — Discover all parseable source files in a project. [4 callers]
schema.ts ★5
  interface SchemaModel [2 callers]
  interface SchemaField
  interface SchemaRelation
  extractSchemas(root: string): SchemaModel[] — Extract database schema from ORM definition files. [3 callers]
  formatSchemas(models: SchemaModel[]): string — Format schemas for skeleton inclusion.
env.ts ★5
  interface EnvVar [2 callers]
  extractEnvVars(root: string): EnvVar[] — Extract environment variables the project expects. [3 callers]
  formatEnvVars(vars: EnvVar[]): string — Format env vars for skeleton inclusion. [2 callers]
staleness.ts ★2: StalenessReport, checkStaleness — Check if the briefed context is stale (source files changed since last index)., formatStaleness — Format staleness report for display.
monorepo.ts ★3
  interface WorkspaceInfo
  interface WorkspacePackage
  detectMonorepo(cwd: string): WorkspaceInfo — Detect if we're in a monorepo and identify packages. [3 callers]
tests.ts ★3
  interface TestCandidate
  interface TestMapping [2 callers]
  findTestMappings(sourceFiles: string[], root: string): TestMapping[] — Find test files that correspond to source files.
  extractTestAssertions(content: string, ext: string): Map<string, string[]> — Extract assertion lines from test blocks, mapped by test name.
complexity.ts ★5
  interface ComplexityScore [4 callers]
  computeComplexity(extraction: FileExtraction, depGraph: DepGraph, root, content?: string): ComplexityScore — Compute complexity score for a file. [2 callers]
conventions.ts ★3
  interface ProjectConventions
  detectConventions(extractions: FileExtraction[], _root: string): ProjectConventions — Auto-detect project conventions from code patterns.
  formatConventions(conv: ProjectConventions): string — Format conventions for inclusion in CLAUDE.md or rules. [2 callers]
scripts.ts ★3
  interface ProjectScripts
  extractScripts(root: string): ProjectScripts — Extract build/test/dev commands from package.json, Makefile, etc. [2 callers]
  formatScripts(scripts: ProjectScripts): string — Format scripts for skeleton inclusion. [2 callers]
security.ts ★2: SecurityWarning, SecurityIssueType, isSensitiveFile — Check if a file should be excluded from context output for security reasons., scanForSecrets — Scan a file for sensitive data patterns., redactSecrets — Redact sensitive values from text before including in context.
deps.ts ★3
  interface DepInfo
  interface DepsResult — Package name as imported (e.g. "stripe", "
  extractDeps(root: string, extractions: FileExtraction[]): DepsResult — Extract external dependency context. Surfaces the installed version and [2 callers]
  formatDeps(deps: DepsResult, top: number): string — Format the top dependencies for the skeleton. When Context7 is present, [2 callers]
  __test — Exposed for tests.
deep.ts ★2
  interface DeepResult — Deep analysis: use `claude -p` (the user's Claude Code subscription, $0
pipeline.ts ★2
  interface ExtractionResult
ast.test.ts: 
complexity.test.ts: 
deep.test.ts: 
depgraph.test.ts: 
deps.test.ts: 
routes.test.ts: GET
staleness.test.ts: 

<!-- briefed skeleton: 24 files, ~1205 tokens -->
Conventions: camelCase for functions and methods, PascalCase for types, classes, and interfaces, uses try/catch for error handling, throws custom error classes (not generic Error), predominantly async/await (not callbacks), prefers named exports over default exports, test files are in separate test/ directory, uses .test.{ext} naming convention
Tests: 34 source files have matching test files
Commands:
  build: tsc
  dev: tsc --watch
  test: vitest run
  lint: tsc --noEmit
  start: node dist/cli.js
Required env: config: BRIEFED_DEBUG, USERPROFILE, APPDATA
External deps (Context7 detected — ask Context7 for public docs by version):
  - vitest@4.1.2 — 33 imports
  - @modelcontextprotocol/sdk@1.29.0 — 10 imports
  - glob@13.0.6 — 6 imports
  - simple-git@3.33.0 — 2 imports
  - express@5.2.1 — 2 imports
  - commander@13.1.0 — 1 imports
  - typescript@5.9.3 — 1 imports
  - next-auth — 1 imports
  - dep — 1 imports
  - js-yaml@4.1.1 — 1 imports
  - zod@4.3.6 — 1 imports
<!-- briefed:agents:end -->
