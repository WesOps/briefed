import { resolve } from "path";
import { runPolybench } from "../bench/polybench/orchestrator.js";
import { generatePolyReport, writeReport } from "../bench/polybench/report.js";
import type { PolyBenchOptions } from "../bench/polybench/types.js";

interface CliPolybenchOptions {
  arms: string;
  tasks: string;
  n?: number;
  output: string;
  workDir: string;
  maxCost: number;
  delay: number;
  timeout: number;
  maxTurns: number;
  language: string;
  resume?: boolean; // commander sets --no-resume to resume=false
  rerun?: string;
  parallelArms?: boolean;
  dryRun?: boolean;
  evaluatorPath?: string;
}

/**
 * CLI entry point for `briefed polybench`. Parses commander options into
 * a PolyBenchOptions, runs the orchestrator, prints the markdown report to
 * stdout, and writes it to <output>/report.md.
 */
export async function polybenchCommand(opts: CliPolybenchOptions): Promise<void> {
  const options: PolyBenchOptions = {
    arms: opts.arms.split(",").map((a) => a.trim()).filter(Boolean),
    tasksCsv: resolve(opts.tasks),
    language: opts.language,
    n: opts.n,
    outputDir: resolve(opts.output),
    workDir: resolve(opts.workDir),
    maxCostUsd: opts.maxCost,
    delayBetweenTasksMs: opts.delay * 1000,
    parallelArms: Boolean(opts.parallelArms),
    timeoutMs: opts.timeout * 1000,
    maxTurns: opts.maxTurns,
    // commander's --no-resume sets opts.resume === false; default is true.
    resume: opts.resume !== false,
    dryRun: Boolean(opts.dryRun),
    rerun: opts.rerun,
    evaluatorPath: opts.evaluatorPath,
  };

  const reports = await runPolybench(options);

  if (options.dryRun) return;

  const markdown = generatePolyReport(reports);
  console.log("\n" + markdown);
  writeReport(options.outputDir, markdown);
  console.log(`\nReport saved to ${resolve(options.outputDir, "report.md")}`);
}
