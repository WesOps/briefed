/**
 * Per-arm predictions file management.
 *
 * The harness writes one JSONL file per arm (`predictions_<arm>.jsonl`) with
 * one row per task. The file IS the state — there is no in-memory cache
 * across tasks — so resume mode just rereads the file and skips existing
 * instance_ids. `CellResult` objects are appended in real time as tasks
 * complete, which keeps the harness crash-safe: if the process dies mid-run,
 * the jsonl still has every completed cell.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type { CellResult } from "./types.js";

/** Absolute path to the predictions jsonl for a given arm. */
export function predictionsPath(outputDir: string, arm: string): string {
  return join(outputDir, `predictions_${arm}.jsonl`);
}

/**
 * Load all existing predictions for an arm into a Map keyed by instanceId.
 * Returns an empty Map if the file doesn't exist yet. Silently skips
 * malformed lines — the harness should not crash on a partially-written jsonl
 * from a prior interrupted run.
 */
export function loadPredictions(jsonlPath: string): Map<string, CellResult> {
  const out = new Map<string, CellResult>();
  if (!existsSync(jsonlPath)) return out;

  const content = readFileSync(jsonlPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as CellResult;
      if (parsed && typeof parsed.instanceId === "string") {
        out.set(parsed.instanceId, parsed);
      }
    } catch {
      // Skip malformed lines — the harness will try again on resume.
    }
  }
  return out;
}

/** Append a single CellResult as a JSONL line. Creates parent dir if needed. */
export function appendPrediction(jsonlPath: string, result: CellResult): void {
  mkdirSync(dirname(jsonlPath), { recursive: true });
  appendFileSync(jsonlPath, JSON.stringify(result) + "\n");
}
