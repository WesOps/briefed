/**
 * Invoke `claude -p` against a SWE-PolyBench task and return the usage
 * summary (cost, turns, elapsed time). The prompt template forbids touching
 * test files and pushes the model toward complete, minimal fixes — same text
 * we validated in the manual bench runs.
 *
 * We parse the JSON envelope from claude's stdout (`--output-format json`)
 * to extract `total_cost_usd` and `num_turns`. On any parse failure, cost
 * defaults to 0 and turns to "unknown" so the orchestrator can still record
 * the row and continue.
 */

import { spawnSync } from "child_process";
import type { PolyTask } from "./types.js";

export interface ClaudeRunResult {
  elapsedSec: number;
  costUsd: number;
  numTurns: number | "unknown";
  stdout: string;
  exitCode: number | null;
}

export interface RunClaudeOpts {
  timeoutMs: number;
  maxTurns: number;
}

/**
 * The polybench prompt template. Keep in sync with `run_one.py` in the
 * scrappy runner. `{problem_statement}` is the single substitution token.
 *
 * Design choices:
 *   - Explicit "DO NOT modify test files" — SWE-PolyBench applies its own
 *     test_patch; any test-file edit collides with the evaluator and rejects
 *     the whole patch.
 *   - Explicit "address the COMPLETE issue" — we lost tailwindcss-550 on the
 *     manual bench because the model made a partial fix. Telling it to
 *     address the full issue helps but is not sufficient — deeper context
 *     is still needed for that failure mode.
 *   - Identical across all arms so any variance is attributable to the
 *     context each adapter provides, not the prompt.
 */
export const POLYBENCH_PROMPT_TEMPLATE = `You are fixing a real GitHub issue in this repository. Read the issue, navigate the codebase, and edit the source files to make the fix.

### Issue
{problem_statement}

### CRITICAL CONSTRAINTS
- DO NOT modify ANY test files. Tests live under directories like \`tests/\`, \`test/\`, \`__tests__/\`, \`spec/\`, or files ending in \`.test.*\`, \`.spec.*\`. The grader applies its own test patch separately, so any test-file changes you make will COLLIDE and cause the entire patch to be rejected.
- DO NOT modify test fixtures or snapshot files (anything under \`fixtures/\`, \`__fixtures__/\`, \`__snapshots__/\`, or files ending in \`.snap\`). These get updated by the grader's test patch and your edits will collide.
- ONLY change source files (under \`src/\`, \`lib/\`, \`app/\`, or similar source dirs).
- Make the MINIMAL change required to fix the issue. Don't refactor, don't add comments, don't reformat unrelated code.
- Address the COMPLETE issue. If the issue mentions multiple things to fix, fix all of them — partial fixes will fail the test suite.
- Edit files directly with the Edit tool. Do not write a separate patch file.
- When done, finish with a one-line summary of what source files you changed.
`;

/** Build the actual prompt by substituting the task's issue text. */
export function buildPrompt(task: PolyTask): string {
  return POLYBENCH_PROMPT_TEMPLATE.replace("{problem_statement}", task.problemStatement);
}

/**
 * Run `claude -p` with the polybench prompt in `repoPath`. Returns the usage
 * summary parsed from the JSON envelope. On any unexpected condition
 * (bad exit, unparseable stdout), returns usable defaults and the caller
 * decides whether to record as error.
 *
 * Uses the same spawnSync pattern as `shared.ts:runClaudeTask` — no shell
 * except on Windows for .cmd compatibility, array args only, honest timeouts.
 */
export function runClaudeOnTask(
  claudePath: string,
  repoPath: string,
  task: PolyTask,
  opts: RunClaudeOpts,
): ClaudeRunResult {
  const prompt = buildPrompt(task);
  const isWindows = process.platform === "win32";

  const startedAt = Date.now();
  const result = spawnSync(
    claudePath,
    [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--max-turns",
      String(opts.maxTurns),
      "--permission-mode",
      "bypassPermissions",
    ],
    {
      cwd: repoPath,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: opts.timeoutMs,
      encoding: "utf-8",
      shell: isWindows,
    },
  );
  const elapsedSec = (Date.now() - startedAt) / 1000;

  const stdout = result.stdout || "";
  let costUsd = 0;
  let numTurns: number | "unknown" = "unknown";

  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const cost = parsed.total_cost_usd;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      costUsd = cost;
    }
    const turns = parsed.num_turns;
    if (typeof turns === "number" && Number.isFinite(turns)) {
      numTurns = turns;
    }
  } catch {
    // claude -p output wasn't a clean JSON envelope — leave defaults.
  }

  return {
    elapsedSec,
    costUsd,
    numTurns,
    stdout,
    exitCode: result.status,
  };
}
