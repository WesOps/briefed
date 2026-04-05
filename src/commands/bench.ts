import { resolve, join } from "path";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { runBenchmark, generateReport } from "../bench/runner.js";

interface BenchOptions {
  repo: string;
  quick?: boolean;
  full?: boolean;
  withOnly?: boolean;
  withoutOnly?: boolean;
  reportOnly?: boolean;
  output?: string;
}

export async function benchCommand(opts: BenchOptions) {
  const root = resolve(opts.repo);
  console.log("  briefed bench — measuring context efficiency");
  console.log(`  Repository: ${root}\n`);

  const results = await runBenchmark({
    repo: root,
    maxTasks: opts.quick ? 2 : opts.full ? 5 : 3,
    skipWithout: opts.withOnly || opts.reportOnly,
    skipWith: opts.withoutOnly || opts.reportOnly,
    outputDir: opts.output,
  });

  const report = generateReport(results);
  console.log("\n" + report);

  const outDir = join(root, ".briefed", "bench");
  if (existsSync(outDir)) {
    writeFileSync(join(outDir, "report.txt"), report);
    console.log(`\n  Report saved to ${join(outDir, "report.txt")}`);
  }
}
