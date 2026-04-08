/**
 * Markdown report generator for polybench results. Pure function — takes
 * an array of ArmReport and returns a markdown string. The caller decides
 * whether to print it, write it to disk, or both.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { ArmReport, CellResult } from "./types.js";

/**
 * Build a markdown comparison report from per-arm results.
 *
 * Layout:
 *   1. Summary section: total cost/time per arm, pass rate if evaluator ran
 *   2. Per-task table: rows = tasks, columns = arms, cells = status/cost/time
 *   3. Notes: any errors encountered, resumed cells, etc.
 */
export function generatePolyReport(reports: ArmReport[]): string {
  if (reports.length === 0) {
    return "# polybench report\n\nNo arms ran.\n";
  }

  const lines: string[] = [];
  lines.push("# polybench report");
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push("| Arm | Tasks | Cost | Input tok | Output tok | Time | Pass rate |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of reports) {
    const scored = r.results.filter((c) => !c.error).length;
    const passRate =
      r.passCount === null
        ? "—"
        : `${r.passCount}/${r.passCount + (r.failCount ?? 0)}`;
    const totalInput = r.results.reduce((sum, c) => sum + c.inputTokens, 0);
    const totalOutput = r.results.reduce((sum, c) => sum + c.outputTokens, 0);
    lines.push(
      `| \`${r.arm}\` | ${scored} | $${r.totalCostUsd.toFixed(2)} | ${totalInput.toLocaleString()} | ${totalOutput.toLocaleString()} | ${r.totalElapsedSec.toFixed(0)}s | ${passRate} |`,
    );
  }
  lines.push("");

  // Per-task table
  const allTasks = new Set<string>();
  for (const r of reports) {
    for (const c of r.results) allTasks.add(c.instanceId);
  }
  const sortedTasks = Array.from(allTasks).sort();

  if (sortedTasks.length > 0) {
    lines.push("## Per-task results");
    lines.push("");
    const header = ["Task", ...reports.map((r) => `\`${r.arm}\``)];
    lines.push(`| ${header.join(" | ")} |`);
    lines.push(`| ${header.map(() => "---").join(" | ")} |`);

    for (const task of sortedTasks) {
      const cells: string[] = [`\`${task}\``];
      for (const r of reports) {
        const result = r.results.find((c) => c.instanceId === task);
        cells.push(formatCell(result));
      }
      lines.push(`| ${cells.join(" | ")} |`);
    }
    lines.push("");
  }

  // Notes section — list any errors so the user doesn't have to read the jsonl
  const errors: Array<{ arm: string; instanceId: string; error: string }> = [];
  for (const r of reports) {
    for (const c of r.results) {
      if (c.error) {
        errors.push({ arm: r.arm, instanceId: c.instanceId, error: c.error });
      }
    }
  }
  if (errors.length > 0) {
    lines.push("## Errors");
    lines.push("");
    for (const e of errors) {
      lines.push(`- \`${e.arm}\` / \`${e.instanceId}\`: ${e.error}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatCell(result: CellResult | undefined): string {
  if (!result) return "—";
  if (result.error) return `❌ error`;
  if (result.skipped) return `${result.costUsd > 0 ? `$${result.costUsd.toFixed(2)}` : "✓"} (cached)`;
  return `$${result.costUsd.toFixed(2)} / ${result.elapsedSec.toFixed(0)}s / ${result.numTurns}t`;
}

/** Write a report string to `<outputDir>/report.md`. */
export function writeReport(outputDir: string, content: string): void {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "report.md"), content);
}
