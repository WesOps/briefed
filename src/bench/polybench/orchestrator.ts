/**
 * The polybench orchestrator. One big async function, intentionally not
 * split into smaller pieces — the state-transition sequencing across arms
 * and tasks is the whole point, and inlining it keeps the flow auditable.
 * Mirrors the shape of `src/bench/quality.ts:runQualityBench`.
 *
 * Lifecycle per (arm, task) cell:
 *   1. Load existing predictions for the arm; skip cells already present
 *      (unless --rerun targets them).
 *   2. cloneTask() — fresh clone + checkout.
 *   3. adapter.setup() — run the context tool's init step.
 *   4. commitBaseState() — commit everything so `git diff HEAD` is clean.
 *   5. runClaudeOnTask() — invoke claude -p with the polybench prompt.
 *   6. CostTracker.add() + checkCap() — enforce the global cost ceiling.
 *   7. captureAndFilterDiff() — capture source-only diff.
 *   8. appendPrediction() — durable state.
 *   9. rmSync the clone dir (in finally, always).
 *  10. All tasks within an arm run in parallel (Promise.allSettled).
 *
 * If CostCapExceededError fires, we break out of ALL arm loops and still
 * emit a partial report.
 */

import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve, join } from "path";
import { findClaude } from "../shared.js";
import { cloneTask, commitBaseState } from "./clone.js";
import { runClaudeOnTask } from "./invoke.js";
import { captureAndFilterDiff } from "./diff.js";
import {
  loadPredictions,
  appendPrediction,
  predictionsPath,
} from "./predictions.js";
import { CostTracker, CostCapExceededError } from "./cost-tracker.js";
import { loadTasks } from "./tasks.js";
import { ADAPTERS } from "./adapters/registry.js";
import { evaluateCell, collectPassFail } from "./eval.js";
import type {
  PolyBenchOptions,
  ArmReport,
  CellResult,
  PolyTask,
  PolyAdapter,
} from "./types.js";


/** Parse a --rerun spec into a Set of "arm:instanceId" keys. */
function parseRerunSpec(spec: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!spec) return out;
  // Accept comma or whitespace separators between pairs.
  const pairs = spec.split(/\s*,\s*(?=arm=)/);
  for (const pair of pairs) {
    const armMatch = pair.match(/arm=([^,\s]+)/);
    const taskMatch = pair.match(/task=([^,\s]+)/);
    if (armMatch && taskMatch) {
      out.add(`${armMatch[1]}:${taskMatch[1]}`);
    }
  }
  return out;
}

/** Rough cost estimate for --dry-run output. Calibrated from the manual bench. */
const ESTIMATED_COST_PER_TASK_USD = 1.5;

/**
 * Main entry point. Returns an ArmReport per arm. On dry-run, prints the
 * plan + estimated cost and returns an empty array without running anything.
 */
export async function runPolybench(opts: PolyBenchOptions): Promise<ArmReport[]> {
  // Validate arms
  if (opts.arms.length === 0) {
    throw new Error("polybench: at least one --arm is required");
  }
  const unknownArms = opts.arms.filter((a) => !ADAPTERS.has(a));
  if (unknownArms.length > 0) {
    throw new Error(
      `polybench: unknown arms: ${unknownArms.join(", ")}. Known: ${Array.from(
        ADAPTERS.keys(),
      ).join(", ")}`,
    );
  }

  // Load tasks
  const tasks = loadTasks(opts.tasksCsv, opts.language ?? "TypeScript", opts.n);
  if (tasks.length === 0) {
    throw new Error(
      `polybench: no tasks matched language="${opts.language ?? "TypeScript"}" in ${opts.tasksCsv}`,
    );
  }

  // Dry-run: print the plan and bail out
  if (opts.dryRun) {
    const totalCells = opts.arms.length * tasks.length;
    const estimated = (totalCells * ESTIMATED_COST_PER_TASK_USD).toFixed(2);
    console.log("polybench dry-run plan");
    console.log("");
    console.log(`  arms:      ${opts.arms.join(", ")}`);
    console.log(`  tasks:     ${tasks.length}`);
    console.log(`  cells:     ${totalCells} (${opts.arms.length} arms × ${tasks.length} tasks)`);
    console.log(`  est cost:  ~$${estimated} (very rough; calibrated from bench history)`);
    console.log(`  cost cap:  $${opts.maxCostUsd.toFixed(2)}`);
    console.log(`  output:    ${resolve(opts.outputDir)}`);
    console.log(`  work dir:  ${resolve(opts.workDir)}`);
    console.log("");
    console.log("  tasks:");
    for (const t of tasks) {
      console.log(`    - ${t.instanceId} (${t.repo})`);
    }
    console.log("");
    console.log("Re-run without --dry-run to actually execute.");
    return [];
  }

  // Ensure output + work dirs exist
  mkdirSync(resolve(opts.outputDir), { recursive: true });
  mkdirSync(resolve(opts.workDir), { recursive: true });

  // Resolve claude path
  const claudePath = findClaude();
  if (!claudePath) {
    throw new Error(
      "polybench: 'claude' CLI not found on PATH. Install with `npm i -g @anthropic-ai/claude-code`.",
    );
  }

  // Resolve briefed CLI path (used by the briefed adapter)
  const briefedCliPath = resolve(import.meta.dirname, "..", "..", "cli.js");

  // Cost tracker — seeded from any already-completed cells so resume honors the cap
  const tracker = new CostTracker();
  for (const arm of opts.arms) {
    const existing = loadPredictions(predictionsPath(opts.outputDir, arm));
    for (const cell of existing.values()) {
      tracker.add(cell.costUsd);
    }
  }
  if (tracker.total > 0) {
    console.log(`  resumed — $${tracker.total.toFixed(4)} already spent on cached cells`);
  }

  const rerunSet = parseRerunSpec(opts.rerun);
  if (rerunSet.size > 0) {
    console.log(`  rerun set: ${Array.from(rerunSet).join(", ")}`);
  }

  // Register SIGINT so partial predictions survive
  process.once("SIGINT", () => {
    console.error("\npolybench: aborted by user. Partial results preserved on disk.");
    process.exit(130);
  });

  // The loop — arms run in parallel (--parallel-arms), tasks within each arm
  // also run in parallel. Each arm gets its own subdirectory under workDir so
  // clones don't collide when two arms work on the same instanceId at once.
  const runArm = async (arm: string): Promise<ArmReport> => {
    const adapter = ADAPTERS.get(arm)!; // validated above
    const jsonlPath = predictionsPath(opts.outputDir, arm);
    const existingCells = loadPredictions(jsonlPath);
    const results: CellResult[] = [];
    // Arm-scoped work dir prevents cross-arm clone collisions
    const armOpts = { ...opts, workDir: join(opts.workDir, arm) };

    console.log(`\n  Arm: ${arm}`);

    // Per-arm setup (e.g. toggle Claude Code plugins for isolation). If this
    // throws, skip the arm entirely — running it with the wrong plugin state
    // would produce a misleadingly-labeled result.
    if (adapter.beforeArm) {
      try {
        await adapter.beforeArm();
      } catch (e) {
        console.log(`    beforeArm failed: ${(e as Error).message.slice(0, 200)}`);
        console.log(`    skipping arm ${arm}`);
        return {
          arm,
          results: [],
          totalCostUsd: 0,
          totalElapsedSec: 0,
          passCount: null,
          failCount: null,
        };
      }
    }

    // Eval result dir for this arm — written by evaluateCell, read by collectPassFail
    const evalResultDir = join(resolve(opts.outputDir), "eval", arm);

    try {
    // Run all tasks for this arm in parallel — each gets an isolated clone dir
    // under armOpts.workDir (which is already arm-scoped). Cost cap becomes a
    // soft cap: tasks already in flight finish regardless, but the tracker will
    // throw once the cap is hit so newly started arms (in --parallel-arms mode)
    // will abort before starting their task loop.
    const evalPromises: Promise<void>[] = [];
    const settled = await Promise.allSettled(tasks.map(async (task, i) => {
      const cellKey = `${arm}:${task.instanceId}`;

      // Resume check
      if (opts.resume && existingCells.has(task.instanceId) && !rerunSet.has(cellKey)) {
        const cached = existingCells.get(task.instanceId)!;
        cached.skipped = true;
        console.log(`    [${i + 1}/${tasks.length}] ${task.instanceId} (cached)`);
        return cached;
      }

      console.log(`    [${i + 1}/${tasks.length}] ${task.instanceId}`);
      let repoPath: string | null = null;
      const cell: CellResult = {
        instanceId: task.instanceId,
        arm,
        modelPatch: "",
        elapsedSec: 0,
        costUsd: 0,
        numTurns: "unknown",
        inputTokens: 0,
        outputTokens: 0,
        error: null,
        skipped: false,
      };

      try {
        repoPath = await runOneCell(task, adapter, briefedCliPath, claudePath, armOpts, cell);
        tracker.add(cell.costUsd);
        tracker.checkCap(opts.maxCostUsd);
      } catch (e) {
        cell.error = (e as Error).message.slice(0, 500);
        console.log(`      error: ${cell.error.slice(0, 120)}`);
      } finally {
        if (repoPath && existsSync(repoPath)) {
          rmSync(repoPath, { recursive: true, force: true });
        }
      }

      appendPrediction(jsonlPath, cell);

      // Fire off evaluation in the background — does not block the next task.
      // Each instance writes to its own result file so parallel evals are safe.
      if (opts.evaluatorPath) {
        const evalP = evaluateCell(
          opts.evaluatorPath,
          opts.tasksCsv,
          jsonlPath,
          task.instanceId,
          evalResultDir,
        ).then((resolved) => {
          const label = resolved === true ? "PASS" : resolved === false ? "FAIL" : "EVAL_ERR";
          console.log(`      [eval] ${task.instanceId}: ${label}`);
        }).catch((e: Error) => {
          console.log(`      [eval] error for ${task.instanceId}: ${e.message?.slice(0, 80)}`);
        });
        evalPromises.push(evalP);
      }

      return cell;
    }));

    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
      } else {
        console.log(`    task error: ${String(outcome.reason).slice(0, 120)}`);
      }
    }

    // Wait for all in-flight evaluations before computing pass/fail counts
    if (evalPromises.length > 0) {
      console.log(`    waiting for ${evalPromises.length} evaluation(s) to finish...`);
      await Promise.allSettled(evalPromises);
    }
    } finally {
      // Per-arm teardown MUST run even on error / cost-cap exit so the next
      // arm (and the user's post-bench environment) has clean plugin state.
      // Teardown failures are logged but not re-thrown — they can't undo
      // successful results and re-throwing would mask the original error.
      if (adapter.afterArm) {
        try {
          await adapter.afterArm();
        } catch (e) {
          console.log(`    afterArm failed (non-fatal): ${(e as Error).message.slice(0, 200)}`);
        }
      }
    }

    const passFail = opts.evaluatorPath ? collectPassFail(evalResultDir) : null;
    const report: ArmReport = {
      arm,
      results,
      totalCostUsd: results.reduce((sum, c) => sum + c.costUsd, 0),
      totalElapsedSec: results.reduce((sum, c) => sum + c.elapsedSec, 0),
      passCount: passFail?.passCount ?? null,
      failCount: passFail?.failCount ?? null,
    };
    return report;
  };

  const allReports: ArmReport[] = [];
  try {
    if (opts.parallelArms) {
      const promises = opts.arms.map((arm) => runArm(arm));
      const settled = await Promise.all(promises);
      allReports.push(...settled);
    } else {
      for (const arm of opts.arms) {
        const r = await runArm(arm);
        allReports.push(r);
      }
    }
  } catch (e) {
    if (e instanceof CostCapExceededError) {
      console.error(`\n${e.message}`);
      console.error("Stopping polybench. Partial results saved to disk.");
    } else {
      throw e;
    }
  }

  return allReports;
}

/**
 * Run one cell end-to-end. Mutates `cell` in place with the outcome.
 * Returns the repoPath so the caller can wipe it in a finally block.
 */
async function runOneCell(
  task: PolyTask,
  adapter: PolyAdapter,
  briefedCliPath: string,
  claudePath: string,
  opts: PolyBenchOptions,
  cell: CellResult,
): Promise<string> {
  // 1. Fresh clone
  const repoPath = await cloneTask(task, opts.workDir);

  // 2. Adapter setup (writes tool artifacts)
  // Deep cache: persisted per-instanceId under outputDir/deep-caches/ so
  // re-runs on the same commit pay zero annotation cost.
  const deepCachePath = join(
    resolve(opts.outputDir),
    "deep-caches",
    `${task.instanceId}.json`,
  );
  await adapter.setup(repoPath, {
    briefedCliPath,
    timeoutMs: opts.setupTimeoutMs ?? opts.timeoutMs,
    deepCachePath,
  });

  // 3. Commit the post-setup state as the base
  await commitBaseState(repoPath);

  // 4. Invoke claude -p
  const runResult = runClaudeOnTask(claudePath, repoPath, task, {
    timeoutMs: opts.timeoutMs,
    maxTurns: opts.maxTurns,
  });

  cell.elapsedSec = runResult.elapsedSec;
  cell.costUsd = runResult.costUsd;
  cell.numTurns = runResult.numTurns;
  cell.inputTokens = runResult.inputTokens;
  cell.outputTokens = runResult.outputTokens;

  // 5. Capture filtered diff (source-only)
  cell.modelPatch = captureAndFilterDiff(repoPath);

  console.log(
    `      ${runResult.elapsedSec.toFixed(1)}s, ${runResult.numTurns} turns, $${runResult.costUsd.toFixed(4)}`,
  );

  // 6. Optional adapter cleanup
  if (adapter.cleanup) {
    try {
      await adapter.cleanup(repoPath);
    } catch {
      // non-fatal
    }
  }

  return repoPath;
}
