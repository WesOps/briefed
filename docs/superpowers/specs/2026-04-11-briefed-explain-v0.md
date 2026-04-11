# briefed explain v0 — narrowest possible diff-risk CLI

**Date:** 2026-04-11
**Status:** Execute tomorrow.
**Supersedes:** `2026-04-10-v2-routes-checkpoint.md` as the primary next action.

## The 2-minute summary

Build a CLI called `briefed explain` that:
- Reads the current `git diff HEAD`
- Re-extracts the changed files live (do NOT trust cached data for them)
- Prints changed files, impacted tests, blast radius via dep graph, schema/env deltas
- No prompt to the user by default — only a compact warning on high-confidence issues
- Labels deterministic outputs separately from heuristic ones

No LLM. No bench. No `claude -p`. This is a tool you run on your own machine before `git push`. The test is whether YOU use it for 2 weeks and it catches real things.

## Shape: repo-local CLI, not a Claude skill

The product is a **standalone CLI binary**. Explicitly NOT a Claude Code skill, plugin, or MCP tool. Reasons:

- It must work without Claude. The pre-push hook runs `briefed explain`, not `claude -p explain`.
- It must run on any diff at any time. A skill requires a Claude session to exist.
- It must be deterministic and citable. A skill wraps fuzzy LLM behavior around it.
- It must survive whatever happens to Claude's plugin/hook surface. A skill dies with the API.

**Integration order (strict):**

1. **Core: `briefed explain` CLI** — this is the product. Everything else is a delivery channel for the product.
2. **Git pre-push hook** — the primary consumption surface for humans. Installs via `briefed explain --install-hook`.
3. **CI step** — GitHub Action that comments on PRs with the report. Drops in later.
4. **Agent wrappers (Claude / Cursor / Aider)** — only if someone asks for them. Thin wrappers that shell out to the CLI and return the output. Optional. NOT the first-class surface.

If at any point tomorrow you find yourself writing code that assumes Claude Code is running — stop. The CLI is the product. The rest is distribution.

## Why this replaces tomorrow's bench checkpoint as the primary action

The bench checkpoint tests "can briefed content help an LLM agent if delivered reliably." That's a valid question but it depends on an uncertain delivery channel (`claude -p` might or might not use CLAUDE.md content), can only be measured via the judge in quality.ts, and doesn't tell us whether a human would pay for the tool.

The CLI test is simpler and more meaningful: **does the output change your own behavior?** If you install a pre-push hook and over two weeks catch two things you'd have shipped without it, you have a product. If you press `y` without reading every time, you don't. That verdict is worth more than any bench number.

The bench checkpoint stays viable as a week-3 validation if needed, but it's not the gate anymore.

## Three hard corrections from tonight's review

These are non-negotiable constraints on the v0 implementation:

### 1. Don't trust the old cache for changed files

If `briefed explain` reads only `.briefed/extract-cache.json`, it will miss the most important cases: newly added routes, new env reads, changed exports, new schema edges. The cache reflects the last `briefed init` — everything the developer just wrote is absent.

**Required behavior:**
- For files NOT in the current diff → cache is fine, use it
- For files IN the current diff → re-extract live via `extractFile()` and patch the cached indexes on the fly before computing the report
- Patches are in-memory only, not written back to the cache file (`briefed init` owns the cache)

**Concretely:** after parsing the diff, build a `liveExtractions: FileExtraction[]` for the changed files, then merge it into the cached data before running routes/env/schema/dep-graph lookups:

```typescript
const diff = parseGitDiff("HEAD");
const changedFiles = diff.files.map(f => f.path);

const cached = loadExtractCache(root);
const liveForChanged = new Map<string, FileExtraction>();
for (const path of changedFiles) {
  const content = readFileSync(join(root, path), "utf-8");
  const extraction = extractFile(path, root, content);
  if (extraction) liveForChanged.set(path, extraction);
}

// merge live over cache before computing report
const merged = mergeExtractions(cached, liveForChanged);
```

### 2. Don't make every push interactive

A `y/N` prompt on every push will get ignored within two days. The default must be:

| Risk level | Behavior |
|---|---|
| Low (no schema/env/route changes, small blast radius, tests exist) | Silent. Print nothing, exit 0. |
| Medium (route/env/schema touched, medium blast radius, some tests) | Print compact warning, exit 0. |
| High (schema nullable change, missing mapped tests, blast radius > threshold, exported symbol removed) | Print full report, exit 0. Do NOT block the push. |

The exit code is always 0 by default. No interactive prompts. No blocking. The tool is advisory — if the developer wants to block on high risk, they wire that in their own pre-push hook. v0 doesn't enforce, it informs.

**Risk classifier is a single function with explicit rules:**

```typescript
function classifyRisk(report: Report): "low" | "medium" | "high" {
  if (report.schemaDeltas.some(d => d.breaking)) return "high";
  if (report.changedFiles.some(f => !report.testMap[f])) return "high";
  if (report.blastRadius.transitive > 20) return "high";
  if (report.routesAffected.length > 0) return "medium";
  if (report.envChanges.length > 0) return "medium";
  if (report.blastRadius.transitive > 5) return "medium";
  return "low";
}
```

No heuristics beyond those explicit rules. No scoring, no fuzzy thresholds. Add cases only when a real push would have benefited from catching it.

### 3. Label deterministic vs heuristic outputs

Trust comes from NOT mixing facts and guesses. The report has two sections:

**DETERMINISTIC** (every line citable to source):
- Changed files — from `git diff`
- Routes affected — from routes extractor + dep graph
- Blast radius — from dep graph BFS
- Schema deltas — from schema extractor diffing old vs new
- Env deltas — from env extractor diffing old vs new
- Tests covering changed files — from test-map

**HEURISTIC / SUGGESTED** (explicitly labeled):
- Suggested commands to run
- "Invariants at risk" (if we ever add this — do not add in v0)
- Risk level classification itself

Output format must visually separate the two sections. Deterministic facts go first, suggestions go last under a `## Suggestions` header. Never interleave.

## What the v0 output looks like

**Low-risk push (silent):**
```
$ briefed explain
$
```

**Medium-risk push (compact warning):**
```
$ briefed explain
2 routes affected by changes in app/utils/auth.server.ts:
  POST /_auth/login
  POST /_auth/signup
Blast radius: 8 direct, 17 transitive
Tests: app/utils/auth.server.test.ts (12 tests)
$
```

**High-risk push (full report):**
```
$ briefed explain

⚠ HIGH RISK PUSH — review before shipping

## Deterministic
Changed files (3):
  M app/routes/_auth+/login.server.ts
  M app/utils/session.server.ts
  M prisma/schema.prisma

Schema deltas (1):
  Session.expiresAt: DateTime → DateTime?  [BREAKING: nullable]
  → 17 existing rows will have NULL — migration required

Env deltas (1):
  SESSION_EXPIRATION_TIME  [NEW — referenced in session.server.ts:42]

Routes affected (4):
  POST /_auth/login       (directly modified)
  POST /_auth/signup      (imports session.server.ts)
  POST /_auth/logout      (imports session.server.ts)
  GET  /settings/profile  (imports requireUser → session.server.ts)

Tests covering changed files:
  app/utils/session.server.test.ts   (12 tests)
  app/routes/_auth+/login.test.ts    (4 tests)
  tests/e2e/auth.spec.ts              (6 tests)

Blast radius (transitive dependents):
  session.server.ts    → 8 direct, 17 transitive
  login.server.ts      → 2 direct,  4 transitive
  prisma/schema.prisma → affects generated types in 23 files

## Suggestions (heuristic)
  npx vitest run app/utils/session.server.test.ts app/routes/_auth+/login.test.ts
  npx playwright test tests/e2e/auth.spec.ts
  npx prisma migrate dev --create-only  # review migration before applying
```

## Build order

All on the branch `feat/explain-v0`. Five steps, ~400 lines of code total.

### Step 1: `src/commands/explain.ts` (new file)

**Action:** Create the `briefed explain` command that parses the current diff, runs the pipeline, prints the report.

**Pseudocode:**

```typescript
export async function explainCommand(opts: { repo: string; range?: string }) {
  const root = resolve(opts.repo);

  // 1. Parse git diff
  const diff = parseGitDiff(root, opts.range ?? "HEAD");
  if (diff.files.length === 0) {
    return; // nothing to report
  }

  // 2. Load cached extractions + re-extract changed files live
  const cached = loadExtractCache(root);
  const live = reExtractChangedFiles(root, diff.files.map(f => f.path));
  const merged = mergeExtractions(cached, live);

  // 3. Build report sections (all deterministic)
  const report = buildReport(root, diff, merged);

  // 4. Classify risk
  const risk = classifyRisk(report);

  // 5. Render based on risk
  if (risk === "low") return;
  if (risk === "medium") printCompact(report);
  if (risk === "high") printFull(report);
}
```

The work is in implementing `parseGitDiff`, `reExtractChangedFiles`, `mergeExtractions`, `buildReport`, `classifyRisk`, `printCompact`, `printFull`. Most of these are ~20-30 lines each because the underlying extractors already exist.

### Step 2: `src/extract/diff.ts` (new file)

**Action:** Implement `parseGitDiff(root, range)` that returns:

```typescript
interface GitDiff {
  files: Array<{
    path: string;
    status: "A" | "M" | "D" | "R";  // added/modified/deleted/renamed
    oldPath?: string;               // for renames
    addedLines: number[];
    removedLines: number[];
  }>;
}
```

Use `spawnSync("git", ["diff", "--unified=0", range])` and parse the unified diff format. Skip deleted files for report purposes (they can't affect anything going forward).

### Step 3: `src/commands/explain.ts` — `reExtractChangedFiles` + `mergeExtractions`

**Action:** For each changed file, read the current content from disk and run `extractFile()`. Build a Map<path, FileExtraction>. Merge into the cached data by overwriting any existing entry for those paths. Re-run `buildDepGraph()` on the merged extractions so the dep graph reflects current state.

This is ~40 lines. The merge is just `Object.assign` over the extractions array; the dep graph rebuild is already a function that exists.

### Step 4: `src/commands/explain.ts` — `buildReport`

**Action:** Compute each section of the report from the merged extractions:

- `changedFiles` — from `diff.files`
- `routesAffected` — for each route in `extractRoutes(merged)`, check if its handler file is in `changedFiles` OR if any transitive importer of its handler file is in `changedFiles`. First case is "directly modified", second is "imports changed file".
- `blastRadius` — for each changed file, BFS over `depGraph.nodes[file].inEdges` to collect direct + transitive dependents.
- `schemaDeltas` — load old schema from cache, run `extractSchemas` on current content, diff the two. For each model, diff fields. Mark `nullable` field changes as breaking.
- `envDeltas` — same pattern. Diff old env vars vs new.
- `testsForChangedFiles` — for each changed file, look up `testMap[file]`. If absent, mark as "no tests mapped" (which triggers high-risk in the classifier).

Each section is 10-30 lines.

### Step 5: `src/commands/explain.ts` — `classifyRisk` + `printCompact` + `printFull`

**Action:** Implement the risk classifier exactly as specified in correction #2. Implement the two renderers that print the markdown output matching the format above. Label the heuristic section explicitly.

Then wire `explainCommand` into `src/cli.ts` as the `explain` subcommand.

## Verification for tomorrow

You do NOT run a bench. You test on your own repo:

1. Make a trivial change: edit a README line. Run `briefed explain`. Expect: silent exit 0. (low risk)
2. Make a medium change: rename a function in `src/extract/routes.ts`. Run `briefed explain`. Expect: compact warning with routes affected + tests. (medium risk)
3. Make a high-risk simulated change: add a nullable field to the Prisma schema somewhere (if briefed has no schema, use a test fixture). Run `briefed explain`. Expect: full report, schema delta flagged as BREAKING.
4. Make a change that breaks a test — rename an exported function that's used in a test file. Run `briefed explain`. Expect: high-risk, "no tests mapped" or similar warning.

If all four cases produce sensible output without hallucinations or crashes, v0 is shippable. Install as pre-push hook, run for 2 weeks on real work, count catches.

## Out of scope for v0

- Caching the merged result
- Running the bench
- Integration with Claude Code
- LLM analysis of any kind
- "Invariants at risk" as a feature (heuristic, high bar to add)
- Per-symbol blast radius (file-level is enough for v0)
- Monorepo-specific handling beyond what scanner.ts already does
- Anything that requires user config

## Success criteria (2-week test)

At the end of 2 weeks of real use:

**Ship it:** You report catching at least 2 real things that would have shipped without the tool. One medium-risk flag you read and acted on. You haven't uninstalled the pre-push hook.

**Kill it:** You uninstalled the hook within 5 days. OR you kept it but every output was noise. OR you can't remember the last time the output changed your behavior.

**Iterate:** Mixed — some signal, some noise. Decide whether the signal:noise is fixable with risk classifier tuning or whether the whole thesis needs a rethink.

## Relationship to the routes bench checkpoint

The old spec at `2026-04-10-v2-routes-checkpoint.md` is NOT deleted. It's frozen as a later validation step: if `briefed explain` proves useful for humans in the 2-week dogfood, the bench checkpoint becomes "does the same output help agents too?" That's when the three-arm A/B/C test actually matters. Until then, the human test is faster, cheaper, and more meaningful.

## First command tomorrow

```bash
git checkout -b feat/explain-v0
```

Then step 1. Don't touch anything else. Don't refactor the existing code. Don't build a framework. Just make `briefed explain` work well enough to run on your next real commit.
