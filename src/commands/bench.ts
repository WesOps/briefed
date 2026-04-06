import { resolve, join } from "path";
import { writeFileSync, existsSync } from "fs";
import {
  runBenchmark,
  runSerenaCompare,
  generateReport,
  generateSerenaReport,
} from "../bench/runner.js";

interface BenchOptions {
  repo: string;
  quick?: boolean;
  full?: boolean;
  withOnly?: boolean;
  withoutOnly?: boolean;
  reportOnly?: boolean;
  output?: string;
  timeout?: string;
  resume?: boolean;
  compareDeep?: boolean;
  serenaCompare?: boolean;
}

export async function benchCommand(opts: BenchOptions) {
  const root = resolve(opts.repo);

  if (opts.serenaCompare) {
    console.log("  briefed bench — Serena vs Serena+briefed");
    console.log(`  Repository: ${root}\n`);

    const results = await runSerenaCompare({
      repo: root,
      maxTasks: opts.quick ? 2 : opts.full ? 10 : undefined,
      skipWithout: opts.withOnly || opts.reportOnly,
      skipWith: opts.withoutOnly || opts.reportOnly,
      outputDir: opts.output,
      timeoutMs: opts.timeout ? parseInt(opts.timeout, 10) * 1000 : undefined,
      resume: opts.resume,
    });

    if (results.length === 0) {
      // runSerenaCompare already printed the specific error
      process.exit(1);
    }

    const report = generateSerenaReport(results);
    console.log("\n" + report);

    const outDir = join(root, ".briefed", "bench", "serena");
    if (existsSync(outDir)) {
      writeFileSync(join(outDir, "report.txt"), report);
      console.log(`\n  Report saved to ${join(outDir, "report.txt")}`);
    }
    return;
  }

  console.log("  briefed bench — measuring context efficiency");
  console.log(`  Repository: ${root}\n`);

  const results = await runBenchmark({
    repo: root,
    maxTasks: opts.quick ? 2 : opts.full ? 5 : 3,
    skipWithout: opts.withOnly || opts.reportOnly,
    skipWith: opts.withoutOnly || opts.reportOnly,
    outputDir: opts.output,
    timeoutMs: opts.timeout ? parseInt(opts.timeout, 10) * 1000 : undefined,
    resume: opts.resume,
    compareDeep: opts.compareDeep,
  });

  const report = generateReport(results);
  console.log("\n" + report);

  const outDir = join(root, ".briefed", "bench");
  if (existsSync(outDir)) {
    writeFileSync(join(outDir, "report.txt"), report);
    console.log(`\n  Report saved to ${join(outDir, "report.txt")}`);
  }
}
