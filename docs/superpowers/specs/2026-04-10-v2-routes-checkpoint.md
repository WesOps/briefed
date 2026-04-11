# briefed v2 — routes-only checkpoint build order

**Date:** 2026-04-10
**Status:** Spec frozen. Code tomorrow.

## Thesis

briefed v2 is a **precomputed answer engine for a small set of recurring question classes**, not a context engine. The unit of value is a deleted search step, not "better context."

Today's run proved the old thesis is wrong: v1.4.0 with danger zones took 41 turns on a task baseline did in 6. The model was given "better context" and did MORE work, not less.

## Four stacked failure modes (the honest diagnosis)

Today's iteration cycle failed because four independent failures were conflated as one "delivery problem":

| Mode | Evidence | Status in v2 checkpoint |
|---|---|---|
| **1. MCP non-use** | Zero `mcp__briefed_*` calls in any 2026-04-10 transcript. `metrics.ts:108` would have counted them. Model does not voluntarily use briefed tools. | **Isolated out.** Neither arm B nor C depends on MCP. |
| **2. Hook non-exercise in bench** | Zero UserPromptSubmit events in 208 transcript lines on v1.4c despite `hooks.ts:68` installing the hook unconditionally. Strong but not proof-of-all-sessions. | **Isolated out.** Hooks stay installed for real Claude Code sessions but bench measurement treats them as invisible. |
| **3. Content selection missing relevant surfaces** | `suggestModel.ts:retrigger` was never in the v1.4c danger zone set despite being the exact symbol needing the warning. PageRank + churn + complexity heuristic ranked it out of critical tier. Even perfect delivery would have injected irrelevant content. | **Eliminated by construction.** Appliances are structured-data dumps — routes are either all present or extraction is broken. No "did we pick the right file" question. |
| **4. Wasteful navigation** | 37% of v1.4c turns were redundant reads of the same file at different offsets + 5x duplicate `git show` of the same commit. Claude Code exploration pattern, not a briefed problem. | **Short-circuited only if the artifact is answer-shaped.** If the appliance is knowledge-shaped (a graph, a list requiring synthesis, prose describing the routes instead of the route table itself), the model will still wander because it must transform the content before responding. Mode 4 is as much a content-shape failure as a Claude failure. The routes appliance MUST look like the final output the task rubric asks for: a markdown table with Route / Method / Purpose / File columns — not a YAML blob or a prose summary. |

**Why this makes the three-arm checkpoint the correct test:**

- **Arm B tests modes 3 + 4 together.** Correct content via a reliable channel (CLAUDE.md at session start) that dodges the exploration phase entirely.
- **Arm C tests whether mode 2 applies to CLAUDE.md delivery too.** If CLAUDE.md is unreliable in bench, prepending beats inlining. If inlining is enough, C won't beat B.
- **Modes 1 and 2 are isolated out of both arms.** Neither test depends on MCP or UserPromptSubmit firing. If v2 works, great. If it doesn't, we haven't wasted effort fixing delivery channels that might not have been the bottleneck.

The key insight: **you cannot diagnose mode 3 until you neutralize modes 1 and 2.** Every v1.x iteration was accidentally testing "does the hook fire?" and "does the model call MCP?" simultaneously with "does content help?" Those failed first, so we never got a clean read on content. The checkpoint uses the one delivery channel we know works specifically to isolate the content question.

## What this checkpoint proves

A three-arm experiment on a single task (`list-routes`) answers two questions in one run:

- **Does the answer-appliance content actually delete search steps?** (B vs A)
- **Does context positioned in the task prompt outperform context positioned in CLAUDE.md?** (C vs B)

Arms:

- **A: baseline** — no briefed at all
- **B: static CLAUDE.md only** — routes appliance inlined in CLAUDE.md, no hooks, no MCP, no dynamic anything
- **C: static + adapter prepend** — same as B plus the polybench adapter prepends the exact same routes content directly to the task prompt before invoking `claude -p`

**What C is NOT testing.** C is not a hooks test. Both B and C bypass hooks and MCP entirely — they differ only in *where* the same content appears. B relies on session-start context (CLAUDE.md is confirmed present in quality bench via `src/bench/quality.ts:351`). C puts the content inside the task prompt itself. So C measures salience/positioning, not delivery: "does prompt-adjacent context outperform session-start context when both reach the model reliably?"

## Hard preflight gate (before any `claude -p` invocation)

Before the bench is allowed to spend a single dollar on a claude call, the generated routes artifact MUST pass a byte-level check against the task rubric in `src/bench/quality-tasks.ts:56`. This is a non-negotiable abort — no warnings, no soft failures.

**Required check:**

```typescript
// In src/bench/quality.ts, before the arm execution loop starts:
const routesArtifact = readFileSync(join(corpusRoot, ".briefed/artifacts/routes.md"), "utf-8");
const listRoutesTask = QUALITY_TASKS.find(t => t.name === "list-routes")!;

// Every mustContain term from quality-tasks.ts:56 must appear verbatim in the artifact.
const missing = listRoutesTask.rubric.mustContain.filter(term => !routesArtifact.includes(term));
if (missing.length > 0) {
  throw new Error(
    `Preflight FAILED: routes artifact is missing required terms: ${missing.join(", ")}. ` +
    `The bench would waste money on arms that cannot possibly pass. Fix extraction first.`
  );
}

// No mustNotHallucinate term from quality-tasks.ts:66 may appear.
const hallucinated = listRoutesTask.rubric.mustNotHallucinate.filter(term => routesArtifact.includes(term));
if (hallucinated.length > 0) {
  throw new Error(
    `Preflight FAILED: routes artifact contains forbidden terms: ${hallucinated.join(", ")}. ` +
    `Extraction is inventing routes. Fix extraction first.`
  );
}
```

The mustContain terms as of today's pinned SHA (`19eeb4ba358781ea447762e70403f7b78994db10`):
`_auth`, `login`, `users/$username`, `settings/profile`, `resources/healthcheck`, `admin`, `_marketing`

The mustNotHallucinate terms:
`/api/v1/`, `pages/api/`

**Why this gate matters today more than anywhere else:** all three v1.x iterations on vscode-106767 spent $1.00–$2.50 per run on benches that could not possibly have passed because the critical danger zone content didn't exist in the cache. The preflight would have caught that in 50 milliseconds, before the first `claude -p` call. For v2 we refuse to make that mistake again.

Additionally, the preflight doubles as a correctness floor: if the routes artifact passes, we already know the upper-bound of the rubric is achievable — the rest is just whether the model reads it.

## Go/no-go after this checkpoint

**Gate 1: correctness.** Arm B must pass the `list-routes` rubric at equal or higher quality than Arm A. If the appliance causes the model to produce a worse answer, the whole thesis is falsified. Kill.

**Gate 2: tool calls.** Arm B must use materially fewer tool calls than Arm A on `list-routes`. Target: ≤2 Read/Grep/Bash calls (the model reads CLAUDE.md for free, notices the routes table, answers). Baseline today averages 6-12 exploratory calls per orientation task.

**Gate 3: input tokens.** Arm B must use ≥30% fewer input tokens than Arm A.

If B passes all three → proceed to appliances #2 (architecture) and #3 (env-audit). Continue the three-arm pattern.

If B passes correctness but not tool calls / tokens → the appliance is answer-shaped enough but too long. Tighten the format.

If B fails correctness → stop. Do not build more appliances. The appliance content is misleading the model. This is the "confidently wrong" failure mode. briefed's hypothesis is dead for this product shape.

If C beats B on tool calls → guaranteed delivery matters. This is a diagnostic: it means the CLAUDE.md path alone isn't reliable enough, and we need to prepend for bench measurements (with the caveat that it doesn't prove hook delivery in real sessions).

## Constraints

- **Don't touch hooks.** UserPromptSubmit stays as-is. If you find yourself editing `hooks.ts`, stop.
- **Don't touch danger zones.** Leave `deep.ts` and `danger-index.json` alone. They're dead weight for this checkpoint but not harmful.
- **Don't touch architecture / env / auth appliances.** Routes only.
- **Don't broaden the artifact beyond what the route rubric actually needs.** If a column doesn't help the rubric pass, it's noise.
- **Branch, don't reset.** All work on `feat/v2-routes-checkpoint` from current main. v1 state stays in place until the checkpoint verdict is in.

## Build order

### Step 1 — `src/extract/routes.ts`

**Action:** Add a new formatter `formatRoutesAsAnswerTable(routes: Route[]): string`. Keep the existing `formatRoutes` for backward compatibility with the skeleton.

**Output shape:** Markdown table exactly like the rubric expects. Columns: `Route`, `Method`, `Purpose`, `File`. Group by top-level path segment (so `_auth`, `users`, `admin` cluster visually). Sort stably by path.

**Example output for epic-stack routes (approximate):**

```markdown
| Route | Method | Purpose | File |
|---|---|---|---|
| `/_auth/login` | POST | Email/password login with 2FA support | app/routes/_auth+/login.tsx |
| `/_auth/signup` | POST | Email verification + password creation | app/routes/_auth+/signup.tsx |
| `/_auth/logout` | POST | Destroy session, clear cookie | app/routes/_auth+/logout.tsx |
| `/resources/healthcheck` | GET | Liveness/readiness probe | app/routes/resources+/healthcheck.tsx |
| `/users/$username` | GET | Public profile view | app/routes/users+/$username_+/index.tsx |
| `/users/$username/notes` | GET | User's notes index | app/routes/users+/$username_+/notes.tsx |
| `/settings/profile` | GET | Profile settings page | app/routes/settings+/profile.tsx |
| `/admin/cache` | GET | Cache admin view (requires admin role) | app/routes/admin+/cache.tsx |
| `/_marketing` | GET | Marketing landing pages | app/routes/_marketing+/... |
```

**Rules:**
- The `Purpose` column is derived from the handler function's JSDoc comment ONLY. If there's no JSDoc, leave the column blank. Do NOT infer purpose from file name, path, or symbol name. Empty > wrong.
- The `Method` column for Remix routes uses Remix conventions: `GET` for `loader`, `POST`/`PUT`/`DELETE`/`PATCH` for `action`. If both exist, list as `GET, POST`. Next.js routes follow their own conventions. Express is explicit.
- The `File` column is a relative path, no absolute paths.
- Cap at 60 routes. If the repo has more, group the overflow into a `...N more routes` line at the bottom. Token budget: ~1500.

**Dependencies:** None — `Route` interface already exists in `routes.ts`.

**File:** `src/extract/routes.ts` — add new function, do not modify existing `formatRoutes`.

---

### Step 2 — `src/extract/routes.test.ts`

**Action:** Lock the formatter output BEFORE wiring delivery. If the table shape drifts between checkpoint iterations, the bench becomes noisy and you can't tell if a result is due to content change or shape change.

**Tests to add:**

1. **Table header is exact.** Assert the output starts with `| Route | Method | Purpose | File |`.
2. **Every rubric term from `list-routes` appears.** The test imports `QUALITY_TASKS` from `quality-tasks.ts`, finds the `list-routes` task, iterates `mustContain`, and asserts each term is present in the formatter output when given the epic-stack routes. This is the **preflight rubric gate** — if this test fails, the route extraction is broken and no bench run will save it.
3. **No hallucination terms appear.** Assert `mustNotHallucinate` terms are absent.
4. **Sort is stable.** Given the same input twice, the output is byte-for-byte identical.
5. **Cap enforcement.** Given 100 routes, the output has at most 60 rows plus the overflow line, and total length is under 2000 tokens (rough proxy: 8000 chars).
6. **Empty purpose column is blank, not inferred.** Given a route with no JSDoc on the handler, the `Purpose` cell is empty (`| |`), not guessed.

**This is the hardest test to write because we need the actual epic-stack routes.** The test should:
- Use a cached snapshot of epic-stack route data (commit fixture to `test/fixtures/epic-stack-routes.json`)
- Or: skip in CI but run locally against `/tmp/epic-stack` clone

Start with the cached snapshot approach. Generate the fixture once by running `extractRoutes('/tmp/epic-stack')`, serialize, check in.

**File:** `src/extract/routes.test.ts` — add tests. `test/fixtures/epic-stack-routes.json` — new fixture file.

---

### Step 3 — `src/commands/init.ts`

**Action:** Wire generation of the routes appliance as a first-class artifact written to `.briefed/artifacts/routes.md`. Skip anything else this round.

**What to do:**
- After `extractRoutes()` is called (already exists), call `formatRoutesAsAnswerTable(routes)` and write to `.briefed/artifacts/routes.md`.
- Don't write the old path-scoped rules, don't generate danger zones, don't touch the skeleton's route inclusion. Leave existing behavior alone. Just ADD the artifact.
- Print a line: `Routes artifact: N routes, ~X tokens`.

**What NOT to do:**
- Don't touch the `--deep` branch.
- Don't touch `writeDangerIndex`.
- Don't modify `generateSkeleton` or the existing `formatRoutes` inclusion.
- Don't make this conditional on a flag — it's the new default for v2.

**File:** `src/commands/init.ts` — add one call + one file write + one console log. ~10 lines.

---

### Step 4 — `src/deliver/claudemd.ts`

**Action:** Inline the routes appliance into the briefed CLAUDE.md block for arm B delivery.

**What to do:**
- Modify `generateBreadcrumb()` to accept an optional `routesAppliance: string | null` parameter.
- When present, append the routes appliance inline inside the `<!-- briefed:start -->` / `<!-- briefed:end -->` markers, under a `## Routes` header.
- Update the caller (`src/deliver/output.ts`) to read `.briefed/artifacts/routes.md` and pass it in.
- If the file doesn't exist (old init, or extraction failed), pass `null` and breadcrumb renders unchanged.

**Format inside CLAUDE.md:**

```markdown
<!-- briefed:start -->
# Project context

briefed-generated context for this repo. Read on demand:
- `.briefed/skeleton.md` — file tree, symbols, dep graph
- `.briefed/artifacts/` — precomputed answers for common questions

## Routes

<routes appliance content here — the full markdown table>

<!-- briefed:end -->
```

**Token budget check:** If the combined breadcrumb + routes exceeds 4000 tokens, truncate the routes table (drop lowest-priority routes first, never drop any rubric term). Log a warning.

**File:** `src/deliver/claudemd.ts` — one parameter, one conditional append. `src/deliver/output.ts` — one file read, one parameter pass.

---

### Step 5 — `src/bench/quality.ts` (part 1 of 2)

**Action:** Add the A/B/C experiment matrix and a hard preflight gate.

**Arms to define:**

```typescript
// Arm A: baseline, no briefed
{ label: "A", serena: false, briefed: false, hooks: false, prependRoutes: false }
// Arm B: static CLAUDE.md with routes appliance inlined, no hooks
{ label: "B", serena: false, briefed: true, hooks: false, prependRoutes: false }
// Arm C: same as B plus adapter prepends matched routes to task prompt
{ label: "C", serena: false, briefed: true, hooks: false, prependRoutes: true }
```

This does NOT delete the existing arms. Add these three as a new matrix selectable via a flag (`--v2-checkpoint` or similar) so the existing bench runs aren't disturbed.

**Preflight gate (runs before ANY claude invocation):**

Implement exactly the check defined in the "Hard preflight gate" section above. Both the `mustContain` and `mustNotHallucinate` lists. Both must pass or the bench aborts before the first claude call. Do not soften it into a warning — a broken extraction must crash the run loudly, not produce confusing bench numbers.

**File:** `src/bench/quality.ts` — add matrix config, add preflight function. ~40 lines.

---

### Step 6 — `src/bench/quality.ts` (part 2 of 2)

**Action:** Arm C prepends the routes appliance content to the task prompt right before `runClaudeTask`.

**Keep it local.** Don't generalize `src/bench/shared.ts` yet — the whole point of this checkpoint is to prove the concept before abstracting.

**What to do:**
- In the arm C branch, read `.briefed/artifacts/routes.md` from the corpus dir.
- Prepend it to the task's `prompt` field with a clear marker:
  ```
  # Pre-loaded context

  <routes appliance content>

  ---

  # Task

  <original task prompt>
  ```
- Pass the modified prompt to `runClaudeTask`.
- Arm B does NOT prepend — it relies entirely on CLAUDE.md delivery.

**Do not** add a generic "prepend any appliance" system. Routes only. Hardcoded path. One `readFileSync`, one string concatenation. If C wins, we generalize. If it doesn't, we don't.

**File:** `src/bench/quality.ts` — ~20 lines in the arm execution loop.

---

## Order of operations

1. **Step 1 first** (routes formatter). Can't test or measure anything without it.
2. **Step 2 immediately after** (lock the shape with tests). Preflight gate hangs off this data.
3. **Run the test suite locally.** All 311 existing tests must still pass. New routes tests must pass with the epic-stack fixture.
4. **Step 3** (init wiring). Smoke test: run `briefed init --repo /tmp/epic-stack` and verify `.briefed/artifacts/routes.md` exists and contains the rubric terms.
5. **Step 4** (CLAUDE.md inlining). Smoke test: verify CLAUDE.md now has the `## Routes` section with the table.
6. **Step 5** (preflight gate). Run the preflight manually against `/tmp/epic-stack` — if the gate passes, the bench run will be measuring something real.
7. **Step 6** (arm C prepend). Do this LAST so arms A and B can run even if C is broken.
8. **Commit after each step.** If step 5 breaks step 4's tests, the bisect is trivial.
9. **Run the three-arm bench on `list-routes` ONLY.** Not the full quality task set. One task. ~5 minutes of claude time per arm, total ~15 minutes plus init overhead.
10. **Read the verdict:** gates 1/2/3 above.

## Estimated scope

- ~60 lines of new code in `routes.ts`
- ~120 lines of tests + ~5KB fixture
- ~10 lines in `init.ts`
- ~15 lines in `claudemd.ts` + 5 in `output.ts`
- ~60 lines in `quality.ts`

Total: ~270 lines of production code + tests. No deletions in this checkpoint.

## What happens after the verdict

**If B wins gate 1 + 2 + 3:** Proceed to build appliance #2 (architecture). Same three-arm pattern on `explain-architecture`. Then appliance #3 (env-audit) on `env-var-audit`. Three clean wins = briefed v2 ships, v1 surfaces get deleted in a follow-up cleanup PR.

**If C beats B but neither beats A on gate 2:** We know delivery matters but content doesn't. Investigate why CLAUDE.md isn't being read reliably. Might mean the routes section needs to be higher up or the breadcrumb needs a stronger "read this first" directive.

**If B passes gate 1 but fails gates 2/3:** Content is correct but too verbose. Trim format, retest.

**If B fails gate 1:** The routes appliance is misleading the model. Stop. Do not build more appliances. briefed's answer-shaped thesis is falsified for this question class. Consider whether other task classes might work (env-audit is the most structured data we have, might still).

**If all three arms fail correctness:** The task rubric is too strict or the model's baseline is too weak. Not a briefed problem. Investigate rubric or bench config.

## Phase 3 target — what the routes checkpoint is actually for

The routes checkpoint is not the product. It is the minimum falsifiable test of the answer-appliance delivery channel. The actual market moat — the thing that differentiates briefed from Aider repo maps, Cursor indexing, Cody semantic search, and Sourcegraph code graph — is a **repo-specific change map**, not a repo-specific knowledge base.

A change map, given a bug/feature description, produces deterministically:

1. **Likely edit targets** — BM25-matched files ranked by issue-term overlap with symbol names, docs, and nearby identifiers. Top 3-5, with scores.
2. **Invariants each edit target maintains** — from static analysis: return type contracts, null/throw signaling conventions, required state. No LLM speculation.
3. **Tests that cover each target** — from test-map. Names + assertion extraction.
4. **Blast radius** — from dep graph BFS. Direct + transitive importers.

No LLM at any step. Everything already computable from existing extractors.

**Why this is the moat:**

- Orientation tools (Aider, Cursor, Cody) tell the agent "here's the codebase." They do not tell it "here's where to edit for THIS bug, here's what to preserve, here's what to verify."
- Review tools (CodeRabbit, Graphite) run *after* the patch. A change map runs *before* exploration.
- Augment is the closest competitor — it claims task-path mapping across layers — so that is the actual competitive shape, not Cursor or Aider.
- A deterministic change map requires a robust extraction pipeline as substrate. briefed has spent weeks building that substrate. That's the sunk cost that becomes a moat: nobody else can skip the pipeline work.

**Why we can't start here:**

A change map is speculative by nature — it predicts which files matter for a bug. The v1.x danger zones were a proto-change-map and they failed because the selection heuristic (PageRank + churn + complexity) was wrong for bug-prediction. Pivoting directly to change maps now skips the validation of the simpler answer-appliance thesis and repeats the same mistake.

**The phased path:**

- **Phase 1 (tomorrow): Routes checkpoint.** One deterministic appliance, one task, one verdict. Proves or falsifies "any precomputed answer appliance can delete search steps."
- **Phase 2: Architecture + env-audit appliances.** Two more deterministic question classes. Proves the pattern generalizes. End of phase 2: functional but commoditized.
- **Phase 3: Change map.** Built from the same substrate (routes, schema, dep graph, tests, signatures) but answers a harder question. Only attempted if phases 1 and 2 pass their checkpoints.

Phase 3 is explicitly NOT this checkpoint's scope. It is documented here so future iterations don't re-derive the moat thesis from scratch and so "ship appliances and call it done" is not the product endpoint.

## Explicit non-goals

- Not touching auth-flow in this checkpoint. Codex is right — auth is where deterministic stitching turns into speculation. Prove the concept on routes first.
- Not deleting the v1 surface yet. It stays functional until after the verdict. This is a branch, not a reset.
- Not fixing the hook delivery. Not this checkpoint.
- Not adding architecture or env-audit appliances. Not this checkpoint.
- Not touching MCP tools. Not this checkpoint.
- Not touching SWE-PolyBench. The checkpoint is quality bench only, because quality bench has a pinned corpus we control.

## The product contract, restated

> briefed must answer the first two questions Claude would otherwise search for.
>
> If it cannot do that, everything else is decoration.

Routes is question #1. Architecture is question #2. This checkpoint proves question #1.
