# briefed

**Compile your codebase into focused, token-efficient context for AI coding tools.**

briefed scans your repository and produces a layered context snapshot that Claude Code, Cursor, Copilot, and any tool reading `AGENTS.md` load automatically — so the AI starts oriented instead of grepping around.

## Headline (v1.0.0, n=4 paired bench)

On a 4-task paired comparison against [epicweb-dev/epic-stack](https://github.com/epicweb-dev/epic-stack) at a pinned commit:

| Configuration | Wall time (mean) | Correctness | $/task | Input tokens |
|---|---|---|---|---|
| Serena alone | 100s | 5/5 | $0.43 | 874K |
| **Serena + briefed (with hooks)** | **64s** | **5/5** | **$0.38** | **312K** |

**−36% wall time, equal correctness, ~11% cheaper per prompt.** That ~36 seconds saved on every prompt is the win you'll feel — over a 50-prompt day, that's ~30 minutes back.

The input-token count drops 64% (874K → 312K), but most of the reduction is in *cache-read* tokens which are billed at ~10% of regular input rate, so the dollar savings are more modest (~11%). Output tokens are essentially unchanged across configurations because correctness is identical — the model writes roughly the same answer at the same length.

**Hooks do most of the work.** The static CLAUDE.md skeleton alone is only ~18% faster than Serena; the adaptive per-prompt context injection pushes the wall-time win to 36%. The plugin install path enables hooks by default — that's the recommended setup. Run `briefed bench --quality --full --arms C,D,G` to reproduce.

## Install — pick your path

**Claude Code users (recommended):** install as a Claude Code plugin so the MCP server actually loads and the hooks register globally.

```bash
claude plugin marketplace add WesOps/briefed
claude plugin install briefed
```

**Cursor / Copilot / Codex / other tools:** install via npm and run the CLI per-project. You get the static skeleton + cross-tool output but not the MCP server (which currently only loads via the Claude Code plugin path).

```bash
npm install -g briefed
briefed init
```

That's it. briefed installs a git post-commit hook and re-indexes after every commit.

---

## What it produces

| Layer | What | Where | When loaded |
|-------|------|--------|-------------|
| Skeleton | File tree, exports, signatures, dep graph (PageRank-ranked), routes, schemas, conventions | `CLAUDE.md` / `AGENTS.md` / `.cursorrules` | Every session |
| Gotchas | Path-scoped constraints, guard clauses, important comments | `.claude/rules/` | When touching matching files |
| Contracts | Per-module behavioral contracts | `.briefed/contracts/` | Per-prompt via hook |
| MCP tools | On-demand queries (blast radius, find usages, symbol lookup) | `briefed mcp` server | When the agent asks |

## Installation

```bash
# Run once in any repo
npx briefed init

# Preview without writing files
npx briefed plan

# Validate setup
npx briefed doctor

# Token usage breakdown
npx briefed stats
```

## What gets extracted

Static analysis only — no LLM calls during `init`. Extractors run only when relevant files are present.

**Code structure**
- Function/class/type signatures via TypeScript AST (with regex fallback for other languages)
- Dependency graph with PageRank-ranked file importance
- Import cycle detection (runtime imports only — type-only imports are correctly ignored)
- Symbol-level cross-references and call-site lookup

**APIs & data**
- HTTP routes — Express, Fastify, Hono, Next.js, FastAPI, Flask, Django
  - Per-route auth detection (`requireAuth`, `getServerSession`, `Depends(get_current_user)`, role middleware, `@login_required`, etc.)
  - Per-route request body schema detection (Zod, `validateBody`, `Schema.parse`)
- Database schemas — Prisma, Drizzle, TypeORM, Django models, fields, relations
- Cross-layer graph linking frontend `fetch` calls to backend route handlers

**Project context**
- External deps with installed versions and import counts (Context7-aware: detects Context7 MCP and signals the agent to ask for version-pinned public docs; flags private packages where Context7 has no coverage)
- Environment variables (required vs optional, grouped by category)
- Build/test/dev scripts from `package.json`, `Makefile`, etc.
- Monorepo workspace detection
- Infrastructure files (Docker Compose, etc.)

**Quality signals**
- Complexity scoring per file
- Gotchas: `TODO`/`HACK`/`FIXME`/`WARNING` comments, guard clauses
- Error handling pattern detection
- Project conventions (camelCase vs snake_case, error style, named vs default exports)
- Usage examples — how each exported symbol is actually called elsewhere in the repo
- Test mappings (source → test file)
- Git churn (hot files in last 90 days)
- Recent file history for high-complexity files
- Frontend page routes and components
- Secret redaction (skips and redacts files matching sensitive patterns)
- Staleness detection (compares against last index)

## MCP tools

Run `briefed mcp` to start an MCP server that exposes on-demand queries to your AI agent:

| Tool | What it does |
|------|--------------|
| `briefed_blast_radius` | BFS over the dep graph to show every file/route/model affected by changing a given file |
| `briefed_symbol` | Look up a function/class/type by name — signature, importers, dependencies, test coverage, importance rank |
| `briefed_find_usages` | Find every call site of a symbol with file, line, and surrounding context. Scoped to actual importers, much faster than grep |
| `briefed_routes` | Filter API routes by HTTP method or path pattern |
| `briefed_schema` | Look up database models with fields, types, and relations |

Add to `.mcp.json` or `.claude/settings.json`:
```json
{
  "mcpServers": {
    "briefed": { "command": "briefed", "args": ["mcp"] }
  }
}
```

## What gets generated

```
your-repo/
├── CLAUDE.md                        # skeleton — Claude Code
├── AGENTS.md                        # cross-tool context (Codex, Copilot, generic)
├── .cursorrules                     # Cursor IDE
├── codex.md                         # OpenAI Codex CLI
├── .github/copilot-instructions.md  # GitHub Copilot
├── .claude/
│   ├── settings.json                # adaptive hooks
│   └── rules/
│       └── briefed-*.md             # path-scoped gotchas
└── .briefed/
    ├── contracts/                   # module behavioral contracts
    ├── index.json                   # module map for hook matching
    ├── test-map.json                # source → test file mappings
    └── history.json                 # git history for complex files
```

## How it stays fresh

briefed installs a git `post-commit` hook that re-indexes in the background after every commit. No CI required.

```bash
# Manual refresh
briefed init

# Check staleness / setup health
briefed doctor

# Remove the git hook
briefed unhook
```

## Commands

```bash
briefed init              # scan + generate context (writes files)
briefed plan              # preview without writing
briefed stats             # token usage breakdown
briefed doctor            # validate setup, check staleness
briefed mcp               # start MCP server for on-demand queries
briefed bench             # benchmark briefed vs baseline Claude Code
briefed unhook            # remove git post-commit hook
```

### Bench

`briefed bench` runs Claude Code on a fixed set of tasks twice — once with briefed, once without — and reports duration, token usage, turn count, file reads, and edit/read ratio for each task.

```bash
briefed bench --quick     # 2 tasks (~10–20 min)
briefed bench             # 3 tasks (default)
briefed bench --full      # 5 tasks (~40–90 min)
```

Resumable — if a run dies mid-bench, re-running picks up where it left off. Uses your Claude Code subscription, not the API.

## Works with

- **Claude Code** — `CLAUDE.md` + adaptive hooks + MCP server
- **Cursor** — `.cursorrules`
- **GitHub Copilot** — `.github/copilot-instructions.md`
- **OpenAI Codex CLI** — `codex.md`
- **Anything else** that reads `AGENTS.md`

## Requirements

- Node.js >= 20
- Git (for the auto-update hook)

## License

MIT
