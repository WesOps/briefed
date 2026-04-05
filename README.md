# briefed

**Your AI already knows your codebase before you ask.**

briefed scans your repository once and compiles a focused, token-efficient context snapshot that Claude Code, Cursor, and Copilot load automatically at the start of every session — eliminating the orientation phase where AI tools spend 8–12 seconds reading files they should already know.

```bash
npx briefed init
```

That's it. briefed installs itself and auto-updates on every commit.

---

## The problem

Every AI coding session starts the same way: the model reads 5–10 files, builds a mental model of your codebase, then starts working. This costs ~5,000–10,000 tokens and 8–12 seconds *before a single line of code is written* — on every task.

briefed pre-computes that mental model so the AI starts already oriented.

## What it produces

Three layers, delivered through the right channels:

| Layer | What | Where | When loaded |
|-------|------|--------|-------------|
| Skeleton | File tree, exports, function signatures, dependency graph | `CLAUDE.md` | Every session |
| Gotchas | Constraints, guard clauses, ordering deps, implicit contracts | `.claude/rules/` | When touching matching files |
| Contracts | Per-module behavioral contracts, state machines, side effects | `.briefed/contracts/` | Per-prompt via hook |

**Estimated savings: ~5,000–8,000 tokens per prompt, ~7–11 seconds per task.**

## Installation

```bash
# Run once in any repo
npx briefed init

# Check your setup
npx briefed doctor

# See token usage stats
npx briefed stats
```

## What gets generated

```
your-repo/
├── CLAUDE.md              # skeleton — always loaded by Claude Code
├── AGENTS.md              # cross-tool context (Copilot, OpenAI agents)
├── .cursorrules           # Cursor IDE context
├── .claude/
│   ├── settings.json      # hooks registered here
│   └── rules/
│       └── briefed-*.md   # path-scoped gotchas
└── .briefed/
    ├── contracts/         # module behavioral contracts
    ├── index.json         # module map for hook matching
    ├── test-map.json      # source → test file mappings
    └── history.json       # git churn data
```

## How it stays fresh

briefed installs a git `post-commit` hook that re-indexes your codebase after every commit in the background (~5 seconds, async). No CI required.

```bash
# Manual refresh
npx briefed init

# Check staleness
npx briefed doctor
```

## What gets mapped

briefed extracts context across every domain relevant to your project (only relevant extractors run):

- **Code structure** — function signatures, exports, dependency graph, PageRank-ranked by importance
- **Behavioral descriptions** — Claude-generated one-liners for what each function does (via `--deep`, default)
- **System overview** — how modules connect, data flow, architecture patterns (via `--deep`, default)
- **Schemas** — Prisma, Drizzle, Django, TypeORM models and relations
- **API routes** — Express, Fastify, Next.js, FastAPI, Django, Hono endpoints
- **OpenAPI / GraphQL** — parsed schema files with endpoints and types
- **Auth model** — provider, OAuth strategies, roles, session store, middleware
- **Integrations** — 50+ known services (Stripe, SendGrid, Sentry, Cloudinary, etc.)
- **Background jobs** — BullMQ, Inngest, Celery, node-cron, Trigger.dev workers
- **Events / webhooks** — event contracts, webhook triggers, pub/sub topics
- **Feature flags** — LaunchDarkly, Unleash, GrowthBook, env-based flags
- **Caching** — Redis, Next.js ISR, HTTP headers, LRU, Django cache
- **Migrations** — last 5 schema changes with summaries
- **Deprecations** — @deprecated tags, TODO:remove markers
- **Infrastructure** — Docker Compose, Terraform, Kubernetes, deployment platform
- **Environment** — required env vars grouped by category
- **Frontend** — page routes (with auth guards), state stores
- **Tests** — source → test file mappings
- **Conventions** — naming patterns, error handling style, import patterns
- **Gotchas** — important comments, guard clauses, state machine transitions
- **Git history** — churn data for complex files

## Commands

```bash
briefed init              # scan + deep analysis (default, uses Claude CLI)
briefed init --fast       # static-only, no Claude calls, instant
briefed init --skip-hooks # init without installing hooks
briefed init --skip-rules # init without writing .claude/rules/
briefed stats             # show token usage breakdown
briefed doctor            # validate setup, check staleness
briefed bench             # benchmark with vs without briefed
```

## Works with

- **Claude Code** — hooks inject context automatically
- **Cursor** — `.cursorrules` loaded on every file
- **GitHub Copilot** — `AGENTS.md` provides baseline context
- **Any tool** that reads `CLAUDE.md` or `AGENTS.md`

## Requirements

- Node.js >= 20
- Git (for auto-update hook)

## License

MIT
