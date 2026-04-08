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
 *  10. sleep(delayBetweenTasksMs) before the next task in this arm.
 *
 * If CostCapExceededError fires, we break out of ALL arm loops and still
 * emit a partial report.
 */

import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
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
import type {
  PolyBenchOptions,
  ArmReport,
  CellResult,
  PolyTask,
  PolyAdapter,
} from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

  // The loop — sequential by default, can be parallelized across arms
  const runArm = async (arm: string): Promise<ArmReport> => {
    const adapter = ADAPTERS.get(arm)!; // validated above
    const jsonlPath = predictionsPath(opts.outputDir, arm);
    const existingCells = loadPredictions(jsonlPath);
    const results: CellResult[] = [];

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

    try {
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const cellKey = `${arm}:${task.instanceId}`;

      // Resume check
      if (opts.resume && existingCells.has(task.instanceId) && !rerunSet.has(cellKey)) {
        const cached = existingCells.get(task.instanceId)!;
        cached.skipped = true;
        results.push(cached);
        console.log(`    [${i + 1}/${tasks.length}] ${task.instanceId} (cached)`);
        continue;
      }

      console.log(`    [${i + 1}/${tasks.length}] ${task.instanceId}`);
      let repoPath: string | null = null;
      const cellStart: CellResult = {
        instanceId: task.instanceId,
        arm,
        modelPatch: "",
        elapsedSec: 0,
        costUsd: 0,
        numTurns: "unknown",
        error: null,
        skipped: false,
      };

      try {
        repoPath = await runOneCell(task, adapter, briefedCliPath, claudePath, opts, cellStart);
        tracker.add(cellStart.costUsd);
        tracker.checkCap(opts.maxCostUsd);
      } catch (e) {
        if (e instanceof CostCapExceededError) {
          // Record what we have and break out of the task loop
          if (cellStart.costUsd > 0 || cellStart.elapsedSec > 0) {
            appendPrediction(jsonlPath, cellStart);
            results.push(cellStart);
          }
          if (repoPath && existsSync(repoPath)) {
            rmSync(repoPath, { recursive: true, force: true });
          }
          throw e;
        }
        cellStart.error = (e as Error).message.slice(0, 500);
        console.log(`      error: ${cellStart.error.slice(0, 120)}`);
      } finally {
        if (repoPath && existsSync(repoPath)) {
          rmSync(repoPath, { recursive: true, force: true });
        }
      }

      appendPrediction(jsonlPath, cellStart);
      results.push(cellStart);

      if (i < tasks.length - 1) {
        await sleep(opts.delayBetweenTasksMs);
      }
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

    const report: ArmReport = {
      arm,
      results,
      totalCostUsd: results.reduce((sum, c) => sum + c.costUsd, 0),
      totalElapsedSec: results.reduce((sum, c) => sum + c.elapsedSec, 0),
      passCount: null,
      failCount: null,
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
  await adapter.setup(repoPath, {
    briefedCliPath,
    timeoutMs: opts.timeoutMs,
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
