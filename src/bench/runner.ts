import { execSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join, resolve } from "path";
import { parseResult, compareMetrics, generateSummary, type TaskMetrics } from "./metrics.js";

export interface BenchTask {
  name: string;
  prompt: string;
}

export interface BenchResult {
  task: BenchTask;
  without: TaskMetrics | null;
  withCctx: TaskMetrics | null;
  error: string | null;
}

const DEFAULT_TASKS: BenchTask[] = [
  {
    name: "understand-architecture",
    prompt: "Read the source files in this project and explain the overall architecture. What are the main modules, how do they connect, and what is the entry point? List every source file you read.",
  },
  {
    name: "add-verbose-flag",
    prompt: "Read the main CLI entry point and add a --verbose flag that enables debug logging throughout the application. Read the relevant source files first, then make the code changes.",
  },
  {
    name: "find-and-fix-bugs",
    prompt: "Read through the source code and identify any potential bugs, missing error handling, or edge cases. Fix at least 2 issues you find. Read every source file before making changes.",
  },
  {
    name: "add-test-coverage",
    prompt: "Find a module that has no test file. Write a comprehensive test suite for it covering the main exported functions. Read the module first to understand what it does.",
  },
  {
    name: "refactor-module",
    prompt: "Find the largest source file. Refactor it to improve readability: extract helper functions, improve naming, add types where missing. Read the file and its callers before making changes.",
  },
];

export interface RunOptions {
  repo: string;
  tasks?: BenchTask[];
  outputDir?: string;
  skipWithout?: boolean;
  skipWith?: boolean;
  maxTasks?: number;
  timeoutMs?: number;
  resume?: boolean;
}

/**
 * Run the benchmark: execute tasks with and without briefed, compare results.
 */
export async function runBenchmark(opts: RunOptions): Promise<BenchResult[]> {
  const root = resolve(opts.repo);
  const tasks = (opts.tasks || DEFAULT_TASKS).slice(0, opts.maxTasks || 3);
  const outputDir = resolve(opts.outputDir || join(root, ".briefed", "bench"));
  const timeoutMs = opts.timeoutMs || 600_000;
  const resume = opts.resume !== false;

  mkdirSync(join(outputDir, "without"), { recursive: true });
  mkdirSync(join(outputDir, "with"), { recursive: true });

  const claudePath = findClaude();
  if (!claudePath) {
    console.error("  Error: 'claude' CLI not found. Install with: npm i -g @anthropic-ai/claude-code");
    return [];
  }
  console.log(`  Using: ${claudePath}`);

  // Report-only: skip runs, just load existing results
  if (opts.skipWithout && opts.skipWith) {
    console.log("  Report-only mode: loading existing results...\n");
    const results: BenchResult[] = [];
    for (const task of tasks) {
      const result: BenchResult = { task, without: null, withCctx: null, error: null };
      try {
        const wp = join(outputDir, "without", `${task.name}.json`);
        const cp = join(outputDir, "with", `${task.name}.json`);
        if (existsSync(wp)) result.without = parseResult(wp);
        if (existsSync(cp)) result.withCctx = parseResult(cp);
      } catch (e) {
        result.error = (e as Error).message;
      }
      results.push(result);
    }
    return results;
  }

  // Phase 1: Run tasks WITHOUT briefed
  if (!opts.skipWithout) {
    console.log("\n  Phase 1: Running tasks WITHOUT briefed...\n");
    const hadCctx = backupCctxArtifacts(root);

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const out = join(outputDir, "without", `${task.name}.json`);
      if (resume && existsSync(out)) {
        console.log(`  [${i + 1}/${tasks.length}] ${task.name} (cached, skipping)`);
        continue;
      }
      console.log(`  [${i + 1}/${tasks.length}] ${task.name}`);

      try {
        runClaudeTask(claudePath, root, task.prompt, out, timeoutMs);
        const m = parseResult(out);
        console.log(`    ${(m.durationMs / 1000).toFixed(1)}s, ${m.numTurns} turns, ${m.inputTokens + m.outputTokens} tokens`);
      } catch (e) {
        console.error(`    Error: ${(e as Error).message.slice(0, 100)}`);
      }
    }

    restoreCctxArtifacts(root, hadCctx);
  }

  // Phase 2: Run tasks WITH briefed
  if (!opts.skipWith) {
    console.log("\n  Phase 2: Running tasks WITH briefed...\n");

    if (!existsSync(join(root, ".briefed", "skeleton.md"))) {
      console.log("  Initializing briefed...");
      const briefedCli = join(import.meta.dirname, "..", "cli.js");
      execSync(`node "${briefedCli}" init --repo "${root}" --skip-hooks`, { stdio: "inherit" });
    }

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const out = join(outputDir, "with", `${task.name}.json`);
      if (resume && existsSync(out)) {
        console.log(`  [${i + 1}/${tasks.length}] ${task.name} (cached, skipping)`);
        continue;
      }
      console.log(`  [${i + 1}/${tasks.length}] ${task.name}`);

      try {
        runClaudeTask(claudePath, root, task.prompt, out, timeoutMs);
        const m = parseResult(out);
        console.log(`    ${(m.durationMs / 1000).toFixed(1)}s, ${m.numTurns} turns, ${m.inputTokens + m.outputTokens} tokens`);
      } catch (e) {
        console.error(`    Error: ${(e as Error).message.slice(0, 100)}`);
      }
    }
  }

  // Phase 3: Compare
  console.log("\n  Phase 3: Results\n");
  const results: BenchResult[] = [];

  for (const task of tasks) {
    const result: BenchResult = { task, without: null, withCctx: null, error: null };
    try {
      const wp = join(outputDir, "without", `${task.name}.json`);
      const cp = join(outputDir, "with", `${task.name}.json`);
      if (existsSync(wp)) result.without = parseResult(wp);
      if (existsSync(cp)) result.withCctx = parseResult(cp);
    } catch (e) {
      result.error = (e as Error).message;
    }
    results.push(result);
  }

  return results;
}

/**
 * Generate the full report string.
 */
export function generateReport(results: BenchResult[]): string {
  const lines: string[] = [];
  lines.push("  " + "═".repeat(62));
  lines.push("  briefed Benchmark Report");
  lines.push("  " + "═".repeat(62));
  lines.push("");

  const summaryData: Array<{ task: string; without: TaskMetrics | null; withCctx: TaskMetrics | null }> = [];

  for (const r of results) {
    if (r.without && r.withCctx) {
      lines.push(compareMetrics(r.without, r.withCctx, r.task.name));
      lines.push("");
    } else if (r.error) {
      lines.push(`  Task "${r.task.name}": Error — ${r.error}`);
    } else {
      lines.push(`  Task "${r.task.name}": Missing data (need both runs)`);
    }
    summaryData.push({ task: r.task.name, without: r.without, withCctx: r.withCctx });
  }

  lines.push(generateSummary(summaryData));
  return lines.join("\n");
}

function findClaude(): string | null {
  const candidates = [
    "claude",
    "claude.cmd",
    join(process.env.APPDATA || "", "npm", "claude.cmd"),
    join(process.env.APPDATA || "", "npm", "claude"),
  ];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ["--version"], { stdio: "pipe", timeout: 5000, encoding: "utf-8", shell: true });
      if (r.status === 0) return c;
    } catch { /* next */ }
  }
  return null;
}

function runClaudeTask(claudePath: string, cwd: string, prompt: string, outputPath: string, timeoutMs: number) {
  // Important: do NOT use shell:true here. With shell:true, the prompt
  // argument is tokenized by whitespace, so "Read the files..." becomes
  // just "Read". On Windows we need shell:true for .cmd files, so detect.
  const isWindows = process.platform === "win32";
  const result = spawnSync(
    claudePath,
    ["-p", prompt, "--output-format", "json", "--max-turns", "20", "--permission-mode", "acceptEdits"],
    { cwd, stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, encoding: "utf-8", shell: isWindows }
  );
  if (result.error) throw new Error(`CLI failed: ${result.error.message}`);
  if (result.stdout?.trim()) {
    writeFileSync(outputPath, result.stdout);
  } else {
    throw new Error(result.stderr?.slice(0, 200) || "No output");
  }
}

function backupCctxArtifacts(root: string): boolean {
  const claudeMd = join(root, "CLAUDE.md");
  const rulesDir = join(root, ".claude", "rules");
  const settingsPath = join(root, ".claude", "settings.json");
  let had = false;

  if (existsSync(claudeMd)) {
    const content = readFileSync(claudeMd, "utf-8");
    if (content.includes("<!-- briefed:start -->")) {
      writeFileSync(claudeMd + ".bak", content);
      writeFileSync(claudeMd, content.replace(/<!-- briefed:start -->[\s\S]*?<!-- briefed:end -->\n?/, "").trim() || "");
      had = true;
    }
  }

  if (existsSync(rulesDir)) {
    for (const f of readdirSync(rulesDir).filter((f) => f.startsWith("briefed-"))) {
      writeFileSync(join(rulesDir, f + ".bak"), readFileSync(join(rulesDir, f)));
      rmSync(join(rulesDir, f));
      had = true;
    }
  }

  // Also backup settings.json so hooks don't run during "without" phase
  if (existsSync(settingsPath)) {
    const settings = readFileSync(settingsPath, "utf-8");
    if (settings.includes("briefed")) {
      writeFileSync(settingsPath + ".bak", settings);
      try {
        const parsed = JSON.parse(settings);
        // Remove briefed hooks from settings
        for (const key of Object.keys(parsed)) {
          if (key.startsWith("hooks.")) {
            const hooks = parsed[key];
            if (Array.isArray(hooks)) {
              parsed[key] = hooks.filter((h: { command?: string }) =>
                !h.command?.includes("briefed")
              );
            }
          }
        }
        writeFileSync(settingsPath, JSON.stringify(parsed, null, 2));
      } catch { /* leave as-is if parse fails */ }
      had = true;
    }
  }

  return had;
}

function restoreCctxArtifacts(root: string, had: boolean) {
  if (!had) return;
  const claudeMd = join(root, "CLAUDE.md");
  const rulesDir = join(root, ".claude", "rules");
  const settingsPath = join(root, ".claude", "settings.json");

  if (existsSync(claudeMd + ".bak")) {
    writeFileSync(claudeMd, readFileSync(claudeMd + ".bak", "utf-8"));
    rmSync(claudeMd + ".bak");
  }
  if (existsSync(rulesDir)) {
    for (const f of readdirSync(rulesDir).filter((f) => f.endsWith(".bak"))) {
      writeFileSync(join(rulesDir, f.replace(".bak", "")), readFileSync(join(rulesDir, f)));
      rmSync(join(rulesDir, f));
    }
  }
  if (existsSync(settingsPath + ".bak")) {
    writeFileSync(settingsPath, readFileSync(settingsPath + ".bak", "utf-8"));
    rmSync(settingsPath + ".bak");
  }
}
