# Quality Bench: Measuring Whether briefed (and `--deep`) Produce Good Analysis

**Date:** 2026-04-07
**Status:** Design approved, ready for implementation planning

## Problem

The existing bench (`runBenchmark`, `runSerenaCompare`) measures **efficiency** — tokens, tool calls, turns, cost — but not **correctness**. Both report generators explicitly note: *"These numbers measure efficiency, not answer quality. Manually score each task transcript 1-5 for correctness before drawing conclusions."* That manual-scoring step never happens, so there is currently no way to answer the actual question: does briefed, and specifically `briefed init --deep`, cause Claude to produce *better answers*?

We need a bench that measures all three: **tokens, speed, correctness** — and specifically isolates the contribution of (a) Serena, (b) briefed, and (c) the `--deep` LLM annotation layer.

## Goals

1. Produce a per-arm table of tokens, duration, and correctness scores for a fixed task set on a fixed codebase.
2. Make the comparison `serena-only` vs `serena + briefed-deep` cheap to re-run.
3. Stay within a tight Claude-usage budget (roughly one session's worth per full bench).
4. Be automated end-to-end — no manual grading step.
5. Be reproducible: same commit of bench target, same tasks, same rubrics ⇒ comparable results across runs.

## Non-Goals

- Measuring the standalone accuracy of briefed's generated annotations (rules files, CLAUDE.md blocks) in isolation. This bench measures *downstream task quality*, not the annotations themselves.
- Replacing the existing efficiency benches. Quality bench is an additional mode (`--quality`), not a rewrite.
- Statistical significance testing. With n=1 per cell and 4 tasks, we are looking for visually obvious deltas, not p-values.
- Measuring briefed against every code-context tool on the market. Scope is Serena vs briefed vs both.

## Arm Matrix

Four arms, forming a 2×2:

```
                 │ no-briefed       briefed-deep
─────────────────┼──────────────────────────────────
no-serena        │   A (control)     B (briefed alone)
serena           │   C (serena base) D (full stack)
```

Each arm answers a specific question:

| Comparison | Question |
|---|---|
| A vs C | Does Serena alone help vs raw Claude Code? |
| C vs D | **Does briefed-deep add value on top of Serena?** (headline) |
| A vs B | Does briefed-deep work without Serena? |
| B vs D | Is Serena still needed if you have briefed-deep? |

**Static briefed is deliberately excluded from the default matrix.** The question being asked is specifically whether the `--deep` LLM-annotation layer produces good analysis. A `--full` flag adds the two static-briefed arms back when the deep-vs-static question is the one being investigated.

## Task Set

Four tasks, adapted from `SERENA_COMPARE_TASKS`, targeted at the chosen bench corpus (epic-stack):

1. **explain-architecture** — "Explain the overall architecture of this project in one paragraph per top-level module."
2. **list-routes** — "List every route this app exposes with its HTTP method and a one-line purpose. Produce a markdown table." *(replaces list-cli-commands; epic-stack is a web app, not a CLI)*
3. **env-var-audit** — "What environment variables does this project read? For each: name, required/optional, and the file(s) where it is consumed."
4. **trace-auth-flow** — "Trace what happens when a user logs in — which route handles it, which server modules run, which tables get touched, in order." *(replaces trace-extraction-pipeline; exercises briefed's cross-file joined metadata)*

Tasks dropped from `SERENA_COMPARE_TASKS`:
- `convention-discovery` — overlaps with explain-architecture
- `add-mcp-tool-plan` — open-ended planning output, hardest to judge reliably

Each task is paired with a **rubric** (an answer key) authored by hand by reading the pinned commit of the bench corpus. Rubric shape:

```ts
interface QualityTask {
  name: string;
  prompt: string;
  rubric: {
    mustContain: string[];      // facts a correct answer must hit
    mustNotHallucinate: string[]; // red flags (e.g. env vars not in .env.example)
  };
}
```

## Bench Corpus

**Primary: `epicweb-dev/epic-stack` pinned to `19eeb4ba358781ea447762e70403f7b78994db10`.**

Chosen on the following axes:
- **Size:** 138 TS/TSX source files (excluding tests). Fits the budget.
- **Structural richness (5/5):** Prisma schema, zod env schema, React Router v7 file routes, clean module layout, server entrypoint.
- **Licensing:** MIT. No friction.
- **Single-repo:** no monorepo wrestling.

**Memorization risk is accepted as a conservative-direction tradeoff.** Epic-stack is a popular template and some of it is plausibly in training data. This memorization *compresses* the gap between arms (all arms benefit equally), so any delta briefed still shows over baseline is a real delta, not an artifact of obscurity.

**Secondary / escape hatch:** `openstatusHQ/openstatus` rooted at `apps/server`, used when memorization appears to dominate (easy to detect: baseline answers look suspiciously good with zero file reads).

**Override:** `--corpus-repo <url> --corpus-ref <sha>` lets users bench against their own project with their own rubrics.

**Fetch:** shallow-clone into `.briefed/bench/quality/corpus/<repo-name>/` on first run, reuse on resume.

## Statistical Posture

- **n=1 per cell**, 4 tasks × 4 arms = 16 task runs.
- Comparison is **paired**: each task sees all 4 arms, so pairwise comparisons block out task-to-task variance.
- Looking for visually obvious deltas (wins on 4/4 tasks, 2× token reduction, etc.), not significance tests.
- If a cell looks anomalous, `--rerun arm=X,task=Y` replays just that cell without touching the rest of the budget.

## Budget Modes

| Mode | Arms | Tasks | Task runs | Judge runs | Approx wall time |
|---|---|---|---|---|---|
| `--quality --quick` | 4 | 2 | 8 | 8 | ~10 min |
| `--quality` (default) | 4 | 4 | 16 | 16 | ~25 min |
| `--quality --full` | 6 (adds 2 static-briefed arms) | 4 | 24 | 24 | ~40 min |

`--full` adds the two `briefed-static` arms back (`no-serena + briefed-static` and `serena + briefed-static`) to answer the deep-vs-static question, but keeps the same 4 judge-friendly tasks. It does **not** bring back the 2 dropped tasks (`convention-discovery`, `add-mcp-tool-plan`) — those are dropped because they are hard to judge reliably, not because they cost too much. Adding more arms is cheap; adding ungrade-able tasks is not.

Judge calls are short (~5–10s each, ~3–5K tokens) — roughly 10% of total budget. `briefed init --deep` setup is SHA256-cached, so re-runs don't re-pay the annotation cost.

## Architecture

### New files

- `src/bench/quality.ts` — orchestrator. Arm matrix enumeration, run loop, resume, rerun.
- `src/bench/judge.ts` — LLM-as-judge. Prompt builder, `claude -p` invoke, strict JSON parse, retry-once-on-bad-JSON.
- `src/bench/quality-tasks.ts` — the 4 tasks + rubrics, keyed by corpus name.
- `src/bench/corpus.ts` — shallow-clone + pinning logic for the bench target repo.

### Modified files

- `src/commands/bench.ts` — add `--quality` branch and these flags: `--rerun arm=X,task=Y` (replay specific cells), `--corpus-repo <url>` / `--corpus-ref <sha>` (override bench target), `--arms <list>` (subset selector, e.g. `--arms C,D` to run only Serena arms; defaults to all four).
- `src/bench/runner.ts` — extract `stripBriefedPreservingMcp`, the install helpers, and `isMcpServerRegistered` into reusable form so `quality.ts` can call them. Keep existing `runBenchmark` / `runSerenaCompare` unchanged.
- `src/bench/metrics.ts` — extend `TaskMetrics` with optional `correctness: { coverage, accuracy, specificity, overall, justification } | null` and `finalAnswer: string` (the transcript's final result field, used as judge input).

### Data flow

```
briefed bench --quality --repo <path>
        │
        ▼
1. Sanity: claude in PATH? For arms C/D, Serena registered
   (via `claude mcp list`, matching existing isMcpServerRegistered)?
        │
        ▼
2. Corpus prep: shallow-clone epic-stack@pinned into
   .briefed/bench/quality/corpus/epic-stack, resume if cached.
        │
        ▼
3. RepoState snapshot: back up .claude/settings.json,
   .claude/rules/, CLAUDE.md, .briefed/ — everything any arm
   will mutate. Install SIGINT/SIGTERM handler that restores.
        │
        ▼
4. For each arm in [A, B, C, D]:
     - Configure corpus repo state per arm:
         A: strip briefed, ensure serena absent
         B: briefed init --deep, ensure serena absent
         C: strip briefed, require serena present
         D: briefed init --deep, require serena present
     - For each task in tasks:
         - If .briefed/bench/quality/<arm>/<task>.json exists and
           not in rerun set → skip
         - Run claude -p, save transcript
        │
        ▼
5. Judge pass (after all task runs complete):
     - Randomized iteration order across (arm, task) pairs
     - For each cell:
         - Load transcript, extract finalAnswer
         - Build judge prompt (Section: Judging below)
         - claude -p, parse strict JSON
         - On bad JSON: one retry with "return only JSON" hint
         - On second failure: mark cell unscored
         - Save .briefed/bench/quality/<arm>/<task>.judge.json
        │
        ▼
6. Report:
     - Per-task table: 4 arms × {duration, tokens, cost, overall, coverage}
     - Summary: paired wins/ties per metric across tasks
     - Headline row: C vs D delta on overall correctness
     - Saved to .briefed/bench/quality/report.txt
        │
        ▼
7. RepoState restore (always, even on error or Ctrl-C).
```

### State management

The 4-arm matrix requires 4 distinct repo states, and critically must never destroy the user's pre-existing Serena registration or briefed install. A single `RepoState` helper handles this:

- On bench start, snapshot to `.briefed/bench/quality/.state-backup/`: `.claude/settings.json`, `.claude/rules/`, `CLAUDE.md`, `.briefed/` (excluding the bench output dir itself).
- Before each arm, apply arm-specific transformations (strip briefed / install briefed / ensure serena on or off).
- On bench exit (success, error, SIGINT, SIGTERM), restore from the snapshot.

For arms A/B (`no-serena`), Serena is temporarily removed from `.claude/settings.json` via the existing settings-rewriting pattern. For arms C/D, Serena must already be present — if not, the bench errors with a clear "install Serena first" message instead of trying to install it.

**Plugin-installed Serena edge case:** the existing runner comments (see `isMcpServerRegistered` in `runner.ts`) already note that Serena can be registered via a Claude Code plugin, outside of `.claude/settings.json`. Plugin-installed Serena **cannot** be temporarily removed by rewriting settings.json. Detection rule: if `claude mcp list` reports Serena but `.claude/settings.json` does not contain a `mcpServers.serena` entry, treat Serena as plugin-installed. In that case the bench refuses to run arms A/B with a clear message: *"Serena is installed via a Claude Code plugin and cannot be temporarily disabled for the no-serena arms. Either (a) uninstall the plugin for this bench, (b) pass `--arms C,D` to run only the serena arms, or (c) install Serena via `.claude/settings.json` instead."* Arms C/D still run normally in this case.

## Judging

### Prompt template

```
You are grading an AI assistant's answer to a question about a codebase.

QUESTION:
{task.prompt}

ANSWER KEY (facts a correct answer must contain):
{task.rubric.mustContain formatted as bullet list}

RED FLAGS (answer must NOT contain any of these):
{task.rubric.mustNotHallucinate formatted as bullet list}

ANSWER GIVEN:
{TaskMetrics.finalAnswer}

Score each dimension 1-5:
- coverage:  fraction of answer-key facts the answer hits
- accuracy:  fraction of claims in the answer that are factually correct
- specificity: cites real file paths / function names / line numbers where relevant
- overall:   single 1-5 verdict weighing the three

Return strict JSON only, no prose:
{"coverage": N, "accuracy": N, "specificity": N, "overall": N, "justification": "one sentence"}
```

### Judge invocation

- Same `claude -p --output-format json` pattern as task runs. Subscription cost, $0 marginal.
- Separate session per judge call.
- Judge is **blinded**: the arm label is never mentioned in the prompt.
- Judge never sees the transcript or tool calls. Only the final answer text. Rationale: users see answers, not transcripts, so that's what "correctness" means.
- Judge call order is randomized across (arm, task) pairs so any time-of-day drift doesn't correlate with arms.

### Output parsing

- Strict `JSON.parse` on the judge's output.
- On parse failure: retry once with `"Your previous response was not valid JSON. Return only the JSON object, no prose."` prepended.
- On second failure: mark cell `{correctness: null, unscored: true, rawJudgeOutput: "..."}`. Continue the bench.
- No third retry.

### Bias acknowledgment

LLM-as-judge has known biases (verbosity preference, self-preference, position bias within lists). These biases are **constant across arms**, which is what matters for a relative comparison. The bench is measuring deltas, not absolute quality.

## Testing Strategy

### Unit tests

- `judge.test.ts` — mock a claude CLI returning known JSON; test parse, retry-on-bad-JSON, unscored-on-double-fail.
- `quality.test.ts` — mock task runs; verify arm matrix enumeration, resume skips cached cells, `--rerun` invalidates specific cells.
- `quality-tasks.test.ts` — rubric shape validation; ensure every task has non-empty `mustContain`.
- `corpus.test.ts` — mocked git clone; verify pinning to the configured SHA.

### Integration test

One smoke test that runs `--quality --quick` against a mocked `claude` binary returning deterministic fake transcripts. Verifies end-to-end flow (corpus prep → RepoState → arm setup → task run → judge → report) with zero real claude calls.

### Manual validation loop (first real run only)

After the first real bench completes, the human spot-checks 3 judge scores by hand. If judgment diverges from the judge (>1 point on `overall`, 2+ cells), tighten the rubric wording and re-score from **cached transcripts** — no re-run of the task runs needed.

## Error Handling

| Failure | Behavior |
|---|---|
| claude CLI not in PATH | Exit 1 with install instructions (existing pattern) |
| Serena not registered (arms C/D) | Exit 1 with "install Serena first", keep A/B runs if they're already complete |
| Corpus clone fails | Exit 1; direct user to `--corpus-repo` override |
| Arm setup fails | Skip that arm, continue with remaining arms, log the failure in the report |
| Task timeout | Existing behavior: partial transcript saved, marked `success: false`. Judge still tries if `finalAnswer` is non-empty. |
| Judge parse fail (twice) | Cell marked `unscored`, still counted for tokens/duration |
| Ctrl-C | SIGINT handler restores RepoState before exit |

## Open Questions

None blocking. Implementation-time decisions:

- Whether to shell out `git clone` or use a library. Shell out is simpler and matches the existing code's shell-out style for `claude` / `briefed init`.
- Exact file path for rubric storage. Inlining into `quality-tasks.ts` is fine for the 4 tasks we have; only matters if the task count grows.

## Out of Scope / Deferred

- **Rubric-generation automation.** Rubrics are written by hand for now. Could later be bootstrapped by running an "oracle" arm (e.g. raw Claude reading every file) and extracting its answer as a rubric, but this adds a self-reference loop that's better avoided until the bench is proven.
- **Multiple bench corpora in a single run.** Design supports one corpus per invocation. Running against both epic-stack and openstatus requires two invocations.
- **Judging tool-call efficiency.** "Did the model make good *choices* about which tools to call?" is a separate evaluation we're not attempting here.
- **Cross-model judging.** Using a different model for judging (to reduce self-preference bias) would require a second model access path; deferred.
