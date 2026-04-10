# Danger-zone annotations + test assertion extraction

**Date:** 2026-04-09
**Status:** Design approved, pending implementation plan

## Problem

briefed helps with file navigation (skeleton, MCP tools) but SWE-PolyBench data shows navigation isn't the bottleneck on most tasks. On 7 of 10 tasks, both baseline and briefed find the right file at roughly the same speed. The model fails at step 4: choosing the right fix once it's looking at the right code.

Evidence from v1.5/v1.6 bench runs (10 tasks, baseline vs briefed-only):

| Failure mode | Example | What happened |
|---|---|---|
| Same file, wrong fix | vscode-106767 | Both found `suggestModel.ts`. Baseline made a nuanced multi-word check; briefed deleted the retrigger block. Both failed, but briefed's fix was blunter and took more turns (25 vs 16). |
| Same file, incomplete fix | three.js-24461 | Both found `Color.js`. Baseline fixed only HSL parsing (4t). Briefed also fixed RGB parsing (10t) and resolved. Extra turns were productive but unguided. |
| Navigation win | vscode-135805 | Adaptive skeleton (200 files) let briefed find `multicursor.ts` in 23t. Baseline hit 41-turn cap with empty patch. Only 1 of 10 tasks was navigation-limited. |

**Root cause:** The deep analysis currently asks "what does this function do?" It should ask "what will break if you change this function wrong?" The model sees functions in isolation. It doesn't see how callers use the return value, what tests actually assert, or what invariants must be preserved.

## Prerequisite: plugin republish

Before any of this matters, 4 of 9 MCP tools are invisible because the plugin hasn't been republished since they were added to `server.ts`. Missing tools: `briefed_context`, `briefed_issue_candidates`, `briefed_env_audit`, `briefed_test_map`. Fix: republish `briefed@briefed`.

## Design

Two workstreams that feed into each other.

### Workstream A: Danger-zone annotations

Extend the deep analysis prompt for critical-tier files (top 20% by blended importance score). Currently, the prompt sends ~25 lines of code and asks for a behavioral description. Change: also send caller context and test assertions, and ask for a `danger` field.

#### Prompt changes (`buildBatchPrompt` in `src/extract/deep.ts`)

For critical-tier files, append two new sections per symbol after the CODE block:

```
CALLERS of retrigger:
  editor.ts:145:  model.retrigger({ auto: true, shy: false })
  snippet.ts:89:  if (model.retrigger(ctx)) return

TEST_ASSERTIONS for retrigger:
  expect(model.state).toBe(State.Idle)
  expect(items).toContainEqual({ label: 'begin document' })
```

Caller context comes from `depGraph.symbolRefs` — look up `filepath#symbolName`, read 3 lines around each call site (1 before, the call, 1 after), take top 3 callers. ~50-100 tokens per symbol.

Test assertions come from workstream B's `extractTestAssertions`. ~30-80 tokens per symbol.

New prompt instruction for critical tier:

```
For CRITICAL files, you also receive CALLERS and TEST_ASSERTIONS.
In addition to "description", produce a "danger" field (max 30 words):
what callers depend on, what invariants tests check, what breaks if
this function's behavior changes.

Example:
{"src/suggest.ts::retrigger": {
  "description": "retriggers completion when user starts a new word, skips when multi-word items span the boundary",
  "danger": "3 callers assume retrigger fires for incomplete providers; test asserts multi-word completions preserved across word boundaries"
}}
```

Normal-tier and peripheral-tier files are unchanged — they still produce description-only annotations.

#### Response parsing (`parseBatchResponse` in `src/extract/deep.ts`)

Currently expects `Record<string, string>`. Change to accept both:
- `string` value → description only (backwards compatible)
- `{ description: string, danger?: string }` → description + optional danger

#### Cache format (`DeepCacheEntry` in `src/extract/deep.ts`)

```typescript
interface DeepCacheEntry {
  hash: string;
  annotations: Record<string, string>;        // existing: symbolName → description
  dangerZones?: Record<string, string>;        // NEW: symbolName → danger text
}
```

Old caches still load — `dangerZones` is optional. Cache invalidation is the same (content + symbol name hash). No migration needed.

Critical-tier files with caller/test changes will naturally re-annotate because the prompt hash changes (new sections in the batch prompt trigger cache misses for those files).

#### Rules output (`buildDeepRules` in `src/extract/deep.ts`)

Add `danger` field to the `FileEntry.symbols` type. In the rules output, emit a `⚠ DANGER:` line for symbols that have one:

```markdown
## suggestModel.ts
- **retrigger**: Retriggers completion when user starts new word
  - calls: trigger, cancel
  - called by: editor.ts, snippet.ts
  - ⚠ DANGER: callers assume retrigger fires for incomplete providers; test asserts multi-word completions preserved
- Tests: "retrigger on new word", "preserves multi-word completions"
  - expects: model.items toContainEqual 'begin document'; model.state not Cancelled
```

Only critical-tier symbols get danger zones. ~20-40 tokens per annotated symbol, ~100-200 tokens total per directory rule file.

### Workstream B: Test assertion extraction

New function in `src/extract/tests.ts`:

```typescript
export function extractTestAssertions(
  content: string,
  ext: string,
): Map<string, string[]>
```

Maps test name → assertion lines. Implementation:

1. Walk lines inside each `it()`/`test()` block (track brace depth for JS/TS, indent depth for Python)
2. Extract lines matching `expect(`, `assert(`, `assert.`, `assertEquals`, `assertThat`
3. Truncate each to 120 chars
4. Cap at 5 assertions per test

No AST needed — same regex approach as existing `extractTestNames`. Language support mirrors what `extractTestNames` already handles (JS/TS, Python, Go, Rust).

#### Storage

Extend `TestMapping`:

```typescript
export interface TestMapping {
  sourceFile: string;
  testFile: string;
  testNames: string[];
  testCount: number;
  confidence: number;
  candidates: TestCandidate[];
  assertions?: Map<string, string[]>;  // NEW: testName → assertion lines
}
```

Persisted in `.briefed/test-map.json` alongside existing data. `assertions` is optional — old test maps still load.

#### Where assertions surface

1. **Deep analysis prompt** (workstream A) — fed as `TEST_ASSERTIONS` for critical-tier files
2. **Path-scoped rules** — `buildDeepRules` adds `expects:` line under test names
3. **`briefed_test_map` MCP tool** — returns assertions alongside test names
4. **UserPromptSubmit hook** — the test injection block (complexity >= 7) includes assertion lines

### Integration flow

```
briefed init --deep
  │
  ├─ extractTestAssertions()        ← workstream B: static extraction
  │   └─ stored in TestMapping.assertions + test-map.json
  │
  ├─ buildBatchPrompt()             ← workstream A: feeds caller + test context
  │   ├─ CALLERS from depGraph.symbolRefs
  │   └─ TEST_ASSERTIONS from TestMapping.assertions
  │
  ├─ parseBatchResponse()           ← handles { description, danger } responses
  │   └─ stored in DeepCacheEntry.dangerZones
  │
  └─ buildDeepRules()               ← emits ⚠ DANGER: + expects: in rules
      └─ .claude/rules/briefed-deep-*.md
```

At task time (interactive or bench):
- Model opens a file → Claude Code auto-loads matching `.claude/rules/briefed-deep-*.md` → sees danger zones and test assertions inline
- Model calls `briefed_test_map("suggestModel.ts")` → gets test names + assertion lines
- UserPromptSubmit hook (complexity >= 7) → injects test assertions for matched modules

## Files to modify

| File | Change |
|---|---|
| `src/extract/tests.ts` | Add `extractTestAssertions()`, extend `TestMapping` interface |
| `src/extract/deep.ts` | Modify `buildBatchPrompt` (caller + test context for critical tier), `parseBatchResponse` (handle `{description, danger}`), `DeepCacheEntry` (add `dangerZones`), `buildDeepRules` (emit ⚠ DANGER and expects lines) |
| `src/extract/pipeline.ts` | Call `extractTestAssertions` during extraction, store in `TestMapping.assertions` |
| `src/commands/init.ts` | Thread `testMappings` (now with assertions) through to `runDeepAnalysis` (already passed, just richer data) |
| `src/mcp/test-map.ts` | Include assertions in MCP tool output |
| `src/deliver/hooks.ts` | Update UserPromptSubmit hook to include assertion lines |

## What this does NOT do

- Does not change the skeleton format or token budget
- Does not add new MCP tools (just enriches existing ones)
- Does not change the polybench prompt template or adapter
- Does not require any new LLM calls — reuses existing deep analysis budget (same number of files, slightly richer prompt for critical tier only)
- Does not change normal-tier or peripheral-tier annotations

## Verification

```bash
# Build + test
npm run lint && npm run test && npm run build

# Smoke test on epic-stack
node dist/cli.js init --deep --repo /tmp/epic-stack
# Expect: deep rules contain ⚠ DANGER lines for critical-tier symbols
# Expect: test-map.json contains assertions field
cat /tmp/epic-stack/.claude/rules/briefed-deep-*.md | grep "DANGER"

# Republish plugin, then verify MCP tools
claude plugin publish  # or whatever the publish command is
claude -p "List briefed tools" --max-turns 1  # should show 9 tools

# Run polybench to measure impact
node dist/cli.js polybench --csv /tmp/swe-polybench-work/polybench_v1_5_quality.csv --arms baseline,briefed-only
# Compare: do danger-zone-enriched runs produce better fixes on vscode-106767?
```

## Success criteria

1. Critical-tier symbols in deep rules have `⚠ DANGER:` lines that describe caller dependencies and test invariants
2. `briefed_test_map` returns assertion lines, not just test names
3. On vscode-106767 specifically: the model sees "multi-word completions depend on retrigger behavior" in the deep rule and produces a more nuanced fix than deleting the block
4. No regression on tasks briefed already wins (vscode-135805, mui-13828)
5. Total token overhead of danger zones < 500 tokens per directory rule file
