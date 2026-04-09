/**
 * Per-cell pass/fail evaluation using the SWE-PolyBench evaluator harness.
 *
 * `evaluateCell` runs `python run_evaluation.py` against a single instance
 * and returns true=PASS, false=FAIL, null=eval error. It:
 *   1. Uses the venv adjacent to the harness dir (../venv/bin/python).
 *   2. Filters the dataset CSV to a single row using pandas so --skip-existing
 *      can't accidentally mark un-evaluated tasks as "done" with empty patches.
 *   3. Writes per-instance result JSON to `resultDir/<instanceId>_result.json`.
 *   4. Is fully async (spawn not spawnSync) so multiple evaluations can run in
 *      parallel without blocking the Node.js event loop.
 *
 * `collectPassFail` reads all result files from a result dir and returns
 * { passCount, failCount } — used to populate ArmReport at end of run.
 */

import { spawn } from "child_process";
import { readFileSync, existsSync, unlinkSync, mkdirSync, readdirSync } from "fs";
import { join, resolve } from "path";

/**
 * Evaluate a single polybench cell. Async — does NOT block the event loop.
 * Returns true=PASS, false=FAIL, null=evaluation error / result unavailable.
 */
export function evaluateCell(
  harnessPath: string,
  datasetCsv: string,
  predictionsJsonl: string,
  instanceId: string,
  resultDir: string,
): Promise<boolean | null> {
  return new Promise((res) => {
    mkdirSync(resultDir, { recursive: true });

    const resultFile = join(resultDir, `${instanceId}_result.json`);
    if (existsSync(resultFile)) {
      res(parseResolvedFromFile(resultFile));
      return;
    }

    const pythonPath = resolvePython(harnessPath);
    const tempCsv = join(resultDir, `_tmp_${instanceId}.csv`);
    // Normalized predictions: evaluator requires snake_case instance_id/model_patch
    const tempPredictions = join(resultDir, `_tmp_preds_${instanceId}.jsonl`);

    // Use pandas (available in the harness venv) to:
    //   1. Extract a single dataset row so the evaluator doesn't see empty-patch
    //      entries for every other task (which would pre-fill result files with FAILs).
    //   2. Normalize our camelCase predictions (instanceId/modelPatch) to the
    //      snake_case columns the evaluator asserts (instance_id/model_patch).
    const filterScript = [
      "import pandas as pd",
      `df = pd.read_csv(${JSON.stringify(datasetCsv)})`,
      `row = df[df['instance_id'] == ${JSON.stringify(instanceId)}]`,
      `row.to_csv(${JSON.stringify(tempCsv)}, index=False)`,
      `preds = pd.read_json(${JSON.stringify(predictionsJsonl)}, lines=True)`,
      `preds = preds.rename(columns={'instanceId': 'instance_id', 'modelPatch': 'model_patch'})`,
      `preds[['instance_id','model_patch']].to_json(${JSON.stringify(tempPredictions)}, orient='records', lines=True)`,
    ].join("; ");

    const filterProc = spawn(pythonPath, ["-c", filterScript], {
      cwd: harnessPath,
      stdio: ["ignore", "pipe", "pipe"],
    });

    filterProc.on("close", (filterCode) => {
      if (filterCode !== 0 || !existsSync(tempCsv)) {
        res(null);
        return;
      }

      const scriptPath = join(harnessPath, "src", "poly_bench_evaluation", "run_evaluation.py");
      const evalProc = spawn(
        pythonPath,
        [
          scriptPath,
          "--dataset-path", tempCsv,
          "--predictions-path", tempPredictions,
          "--result-path", resultDir,
          "--num-threads", "1",
          "--skip-existing",
        ],
        {
          cwd: harnessPath,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const cleanup = () => {
        try { unlinkSync(tempCsv); } catch { /* ignore */ }
        try { unlinkSync(tempPredictions); } catch { /* ignore */ }
      };

      evalProc.on("close", () => {
        cleanup();
        res(existsSync(resultFile) ? parseResolvedFromFile(resultFile) : null);
      });

      evalProc.on("error", () => {
        cleanup();
        res(null);
      });
    });

    filterProc.on("error", () => res(null));
  });
}

/**
 * Scan a result dir written by `evaluateCell` and count pass/fail.
 * Returns null counts if the dir doesn't exist or has no result files.
 */
export function collectPassFail(resultDir: string): { passCount: number; failCount: number } | null {
  if (!existsSync(resultDir)) return null;
  let passCount = 0;
  let failCount = 0;
  let found = false;
  for (const name of readdirSync(resultDir)) {
    if (!name.endsWith("_result.json")) continue;
    found = true;
    const resolved = parseResolvedFromFile(join(resultDir, name));
    if (resolved === true) passCount++;
    else if (resolved === false) failCount++;
  }
  return found ? { passCount, failCount } : null;
}

function parseResolvedFromFile(resultFile: string): boolean | null {
  try {
    const data = JSON.parse(readFileSync(resultFile, "utf-8")) as Record<string, unknown>;
    if (typeof data.resolved === "boolean") return data.resolved;
    return null;
  } catch {
    return null;
  }
}

function resolvePython(harnessPath: string): string {
  // Conventional layout: harness/ and venv/ are siblings under the same parent.
  const venvPython = resolve(join(harnessPath, "..", "venv", "bin", "python"));
  if (existsSync(venvPython)) return venvPython;
  return "python3";
}
