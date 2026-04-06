import { execSync, spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join, resolve } from "path";
import {
  parseResult,
  compareMetrics,
  compareMetrics3,
  compareMetricsSerena,
  generateSummary,
  type TaskMetrics,
} from "./metrics.js";
import { SERENA_COMPARE_TASKS } from "./serena-tasks.js";

export interface BenchTask {
  name: string;
  prompt: string;
}

export interface BenchResult {
  task: BenchTask;
  without: TaskMetrics | null;
  withCctx: TaskMetrics | null;
  withDeep: TaskMetrics | null;
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
  /** Also run a third arm with `briefed init --deep` for LLM-annotated rules. */
  compareDeep?: boolean;
  /**
   * Run the "does briefed add value on top of Serena?" comparison.
   * Assumes Serena is already registered in .claude/settings.json and working.
   * Uses the orientation-biased task set in serena-tasks.ts.
   * Arms: "serena" (briefed stripped, Serena preserved) vs "serena+briefed".
   */
  serenaCompare?: boolean;
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
  if (opts.compareDeep) {
    mkdirSync(join(outputDir, "deep"), { recursive: true });
  }

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
      const result: BenchResult = { task, without: null, withCctx: null, withDeep: null, error: null };
      try {
        const wp = join(outputDir, "without", `${task.name}.json`);
        const cp = join(outputDir, "with", `${task.name}.json`);
        const dp = join(outputDir, "deep", `${task.name}.json`);
        if (existsSync(wp)) result.without = parseResult(wp);
        if (existsSync(cp)) result.withCctx = parseResult(cp);
        if (existsSync(dp)) result.withDeep = parseResult(dp);
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

  // Phase 2.5: Run tasks WITH briefed --deep (LLM-annotated rules)
  if (!opts.skipWith && opts.compareDeep) {
    console.log("\n  Phase 2.5: Running tasks WITH briefed --deep...\n");

    // Re-init with --deep. Clearing briefed artifacts first ensures the
    // new rules files and system overview actually take effect.
    const briefedCli = join(import.meta.dirname, "..", "cli.js");
    console.log("  Running `briefed init --deep` ...");
    try {
      execSync(`node "${briefedCli}" init --repo "${root}" --deep --skip-hooks`, {
        stdio: "inherit",
      });
    } catch (e) {
      console.error(`  deep init failed: ${(e as Error).message.slice(0, 200)}`);
      console.error("  Skipping deep arm.");
    }

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const out = join(outputDir, "deep", `${task.name}.json`);
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
    const result: BenchResult = { task, without: null, withCctx: null, withDeep: null, error: null };
    try {
      const wp = join(outputDir, "without", `${task.name}.json`);
      const cp = join(outputDir, "with", `${task.name}.json`);
      const dp = join(outputDir, "deep", `${task.name}.json`);
      if (existsSync(wp)) result.without = parseResult(wp);
      if (existsSync(cp)) result.withCctx = parseResult(cp);
      if (existsSync(dp)) result.withDeep = parseResult(dp);
    } catch (e) {
      result.error = (e as Error).message;
    }
    results.push(result);
  }

  return results;
}

/**
 * Run the Serena comparison: does briefed add value on top of Serena?
 *
 * Assumes Serena is already registered in `.claude/settings.json` under
 * mcpServers. We never touch the Serena entry — it stays registered across
 * both phases. We only add/remove briefed's artifacts between phases.
 *
 * Phase A (serena-only): strip briefed from CLAUDE.md + settings.json + rules
 * Phase B (serena+briefed): run `briefed init` (hooks enabled) alongside Serena
 *
 * Results saved to .briefed/bench/serena/{serena,serena+briefed}/<task>.json
 */
export async function runSerenaCompare(opts: RunOptions): Promise<BenchResult[]> {
  const root = resolve(opts.repo);
  const tasks = (opts.tasks || SERENA_COMPARE_TASKS).slice(0, opts.maxTasks || SERENA_COMPARE_TASKS.length);
  const outputDir = resolve(opts.outputDir || join(root, ".briefed", "bench", "serena"));
  const timeoutMs = opts.timeoutMs || 600_000;
  const resume = opts.resume !== false;

  mkdirSync(join(outputDir, "serena"), { recursive: true });
  mkdirSync(join(outputDir, "serena+briefed"), { recursive: true });

  const claudePath = findClaude();
  if (!claudePath) {
    console.error("  Error: 'claude' CLI not found. Install with: npm i -g @anthropic-ai/claude-code");
    return [];
  }
  console.log(`  Using: ${claudePath}`);

  // Sanity check: Serena must actually be registered, otherwise the whole
  // comparison is meaningless. We can't just grep .claude/settings.json —
  // Serena might be installed via a Claude Code plugin (plugin-managed
  // config lives in ~/.claude.json or plugin directories), or registered
  // at user scope via `claude mcp add`. The authoritative source is
  // `claude mcp list`, which enumerates every MCP server visible to the
  // CLI regardless of where it's configured.
  if (!isMcpServerRegistered(claudePath, root, "serena")) {
    console.error("  Error: Serena is not registered as an MCP server.");
    console.error("  Verify with: claude mcp list");
    console.error("  Install: see https://github.com/oraios/serena");
    return [];
  }

  // Report-only shortcut
  if (opts.skipWithout && opts.skipWith) {
    console.log("  Report-only mode: loading existing results...\n");
    return loadSerenaResults(tasks, outputDir);
  }

  // Phase A: Serena only (strip briefed artifacts, preserve Serena)
  if (!opts.skipWithout) {
    console.log("\n  Phase A: Serena only (briefed stripped)\n");
    stripBriefedPreservingMcp(root);

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const out = join(outputDir, "serena", `${task.name}.json`);
      if (resume && existsSync(out)) {
        console.log(`  [${i + 1}/${tasks.length}] ${task.name} (cached, skipping)`);
        continue;
      }
      console.log(`  [${i + 1}/${tasks.length}] ${task.name}`);
      try {
        runClaudeTask(claudePath, root, task.prompt, out, timeoutMs);
        const m = parseResult(out);
        console.log(
          `    ${(m.durationMs / 1000).toFixed(1)}s, ${m.numTurns} turns, ${m.totalToolCalls} tool calls, ${formatNumber(m.inputTokens + m.outputTokens)} tokens`,
        );
      } catch (e) {
        console.error(`    Error: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  }

  // Phase B: Serena + briefed (run briefed init, keep Serena intact)
  if (!opts.skipWith) {
    console.log("\n  Phase B: Serena + briefed\n");
    const briefedCli = join(import.meta.dirname, "..", "cli.js");
    console.log("  Running `briefed init` (full, with hooks)...");
    try {
      execSync(`node "${briefedCli}" init --repo "${root}"`, { stdio: "inherit" });
    } catch (e) {
      console.error(`  briefed init failed: ${(e as Error).message.slice(0, 200)}`);
      return [];
    }

    // Sanity: Serena must still be visible (might have been clobbered by
    // briefed init), and briefed must be registered in the repo's
    // .claude/settings.json (that's where installMcpServer() writes it —
    // checking via `claude mcp list` is unreliable because not every Claude
    // Code version surfaces project-scoped servers from settings.json).
    if (!isMcpServerRegistered(claudePath, root, "serena")) {
      console.error("  Error: briefed init clobbered the Serena MCP registration. Aborting.");
      return [];
    }
    const settingsPath = join(root, ".claude", "settings.json");
    let briefedRegistered = false;
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const servers = (parsed.mcpServers || {}) as Record<string, unknown>;
      briefedRegistered = Boolean(servers.briefed);
    } catch { /* leave false */ }
    if (!briefedRegistered) {
      console.error("  Error: briefed init did not write mcpServers.briefed to .claude/settings.json. Aborting.");
      return [];
    }

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const out = join(outputDir, "serena+briefed", `${task.name}.json`);
      if (resume && existsSync(out)) {
        console.log(`  [${i + 1}/${tasks.length}] ${task.name} (cached, skipping)`);
        continue;
      }
      console.log(`  [${i + 1}/${tasks.length}] ${task.name}`);
      try {
        runClaudeTask(claudePath, root, task.prompt, out, timeoutMs);
        const m = parseResult(out);
        console.log(
          `    ${(m.durationMs / 1000).toFixed(1)}s, ${m.numTurns} turns, ${m.totalToolCalls} tool calls, ${formatNumber(m.inputTokens + m.outputTokens)} tokens`,
        );
      } catch (e) {
        console.error(`    Error: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  }

  return loadSerenaResults(tasks, outputDir);
}

function loadSerenaResults(tasks: BenchTask[], outputDir: string): BenchResult[] {
  const results: BenchResult[] = [];
  for (const task of tasks) {
    const result: BenchResult = { task, without: null, withCctx: null, withDeep: null, error: null };
    try {
      const serenaPath = join(outputDir, "serena", `${task.name}.json`);
      const bothPath = join(outputDir, "serena+briefed", `${task.name}.json`);
      if (existsSync(serenaPath)) result.without = parseResult(serenaPath);
      if (existsSync(bothPath)) result.withCctx = parseResult(bothPath);
    } catch (e) {
      result.error = (e as Error).message;
    }
    results.push(result);
  }
  return results;
}

/**
 * Generate a Serena-comparison report. Uses the Serena-specific metric
 * formatter so the per-server MCP breakdown is visible.
 */
export function generateSerenaReport(results: BenchResult[]): string {
  const lines: string[] = [];
  lines.push("  " + "═".repeat(70));
  lines.push("  briefed Benchmark — Does briefed add value on top of Serena?");
  lines.push("  " + "═".repeat(70));
  lines.push("");

  for (const r of results) {
    if (r.without && r.withCctx) {
      lines.push(compareMetricsSerena(r.without, r.withCctx, r.task.name));
      lines.push("");
    } else if (r.error) {
      lines.push(`  Task "${r.task.name}": Error — ${r.error}`);
    } else {
      lines.push(`  Task "${r.task.name}": Missing data (need both arms)`);
    }
  }

  // Aggregate summary across tasks
  let compared = 0;
  let totalCallsSerena = 0;
  let totalCallsBoth = 0;
  let totalTokensSerena = 0;
  let totalTokensBoth = 0;
  let totalTurnsSerena = 0;
  let totalTurnsBoth = 0;
  let totalCostSerena = 0;
  let totalCostBoth = 0;
  const mcpBreakdownSerena: Record<string, number> = {};
  const mcpBreakdownBoth: Record<string, number> = {};

  for (const r of results) {
    if (!r.without || !r.withCctx) continue;
    compared++;
    totalCallsSerena += r.without.totalToolCalls;
    totalCallsBoth += r.withCctx.totalToolCalls;
    totalTokensSerena += r.without.inputTokens;
    totalTokensBoth += r.withCctx.inputTokens;
    totalTurnsSerena += r.without.numTurns;
    totalTurnsBoth += r.withCctx.numTurns;
    totalCostSerena += r.without.totalCostUsd;
    totalCostBoth += r.withCctx.totalCostUsd;
    for (const [k, v] of Object.entries(r.without.mcpCallsByServer)) {
      mcpBreakdownSerena[k] = (mcpBreakdownSerena[k] || 0) + v;
    }
    for (const [k, v] of Object.entries(r.withCctx.mcpCallsByServer)) {
      mcpBreakdownBoth[k] = (mcpBreakdownBoth[k] || 0) + v;
    }
  }

  if (compared === 0) {
    lines.push("  No tasks with both arms to compare.");
    return lines.join("\n");
  }

  lines.push("  " + "═".repeat(70));
  lines.push("  SUMMARY (mean across tasks)");
  lines.push("  " + "═".repeat(70));
  lines.push(`  Tasks compared:       ${compared}`);
  lines.push(
    `  Total tool calls:     ${(totalCallsSerena / compared).toFixed(1)} → ${(totalCallsBoth / compared).toFixed(1)} (${formatPct(totalCallsSerena, totalCallsBoth)})`,
  );
  lines.push(
    `  Turns:                ${(totalTurnsSerena / compared).toFixed(1)} → ${(totalTurnsBoth / compared).toFixed(1)} (${formatPct(totalTurnsSerena, totalTurnsBoth)})`,
  );
  lines.push(
    `  Input tokens:         ${formatNumber(Math.round(totalTokensSerena / compared))} → ${formatNumber(Math.round(totalTokensBoth / compared))} (${formatPct(totalTokensSerena, totalTokensBoth)})`,
  );
  lines.push(
    `  Cost:                 $${totalCostSerena.toFixed(4)} → $${totalCostBoth.toFixed(4)} (${formatPct(totalCostSerena, totalCostBoth)})`,
  );
  lines.push("");
  lines.push("  MCP call breakdown (totals across all tasks):");
  const allServers = new Set([...Object.keys(mcpBreakdownSerena), ...Object.keys(mcpBreakdownBoth)]);
  for (const server of allServers) {
    const s = mcpBreakdownSerena[server] || 0;
    const b = mcpBreakdownBoth[server] || 0;
    lines.push(`    ${server.padEnd(14)} ${s.toString().padStart(6)} → ${b.toString().padStart(6)}`);
  }
  lines.push("  " + "═".repeat(70));
  lines.push("");
  lines.push("  NOTE: These numbers measure efficiency, not answer quality.");
  lines.push("  Manually score each task transcript 1-5 for correctness before");
  lines.push("  drawing conclusions. Low tool count + wrong answer = bad.");

  return lines.join("\n");
}

function formatPct(before: number, after: number): string {
  if (before === 0 && after === 0) return "—";
  if (before === 0) return `+${after}`;
  const pct = Math.round(((after - before) / before) * 100);
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct}%`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

/**
 * Remove all briefed artifacts from a repo while preserving everything else
 * in .claude/settings.json — specifically, the Serena MCP registration and
 * any other user-configured hooks/servers. This is what makes the "serena
 * only" arm of the bench a clean baseline.
 */
function stripBriefedPreservingMcp(root: string) {
  // 1. Strip briefed block from CLAUDE.md
  const claudeMd = join(root, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    const content = readFileSync(claudeMd, "utf-8");
    if (content.includes("<!-- briefed:start -->")) {
      const stripped = content
        .replace(/<!-- briefed:start -->[\s\S]*?<!-- briefed:end -->\n?/, "")
        .trim();
      writeFileSync(claudeMd, stripped + (stripped ? "\n" : ""));
    }
  }

  // 2. Remove briefed rule files
  const rulesDir = join(root, ".claude", "rules");
  if (existsSync(rulesDir)) {
    for (const f of readdirSync(rulesDir).filter((f) => f.startsWith("briefed-"))) {
      try { rmSync(join(rulesDir, f)); } catch { /* ignore */ }
    }
  }

  // 3. Remove briefed MCP + briefed hooks from settings.json, leaving
  //    everything else (Serena, user-defined hooks, other servers) intact.
  const settingsPath = join(root, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    return;
  }

  const mcpServers = parsed.mcpServers as Record<string, unknown> | undefined;
  if (mcpServers && "briefed" in mcpServers) {
    delete mcpServers.briefed;
  }

  const hooks = parsed.hooks as Record<string, Array<{ hooks: Array<{ command?: string }> }>> | undefined;
  if (hooks) {
    for (const eventName of Object.keys(hooks)) {
      hooks[eventName] = hooks[eventName].filter(
        (entry) => !entry.hooks.some((h) => (h.command || "").includes("briefed")),
      );
      if (hooks[eventName].length === 0) {
        delete hooks[eventName];
      }
    }
  }

  writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + "\n");
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

  const summaryData: Array<{ task: string; without: TaskMetrics | null; withCctx: TaskMetrics | null; withDeep: TaskMetrics | null }> = [];

  const anyDeep = results.some((r) => r.withDeep);

  for (const r of results) {
    if (r.without && r.withCctx && r.withDeep) {
      lines.push(compareMetrics3(r.without, r.withCctx, r.withDeep, r.task.name));
      lines.push("");
    } else if (r.without && r.withCctx) {
      lines.push(compareMetrics(r.without, r.withCctx, r.task.name));
      lines.push("");
    } else if (r.error) {
      lines.push(`  Task "${r.task.name}": Error — ${r.error}`);
    } else {
      lines.push(`  Task "${r.task.name}": Missing data (need at least baseline + with runs)`);
    }
    summaryData.push({ task: r.task.name, without: r.without, withCctx: r.withCctx, withDeep: r.withDeep });
  }

  // Suppress unused-warn when the deep arm is empty
  void anyDeep;

  lines.push(generateSummary(summaryData));
  return lines.join("\n");
}

/**
 * Check whether an MCP server is visible to Claude Code, regardless of where
 * it's registered (repo settings.json, user ~/.claude.json, or a plugin).
 * Uses `claude mcp list` as the authoritative source.
 */
function isMcpServerRegistered(claudePath: string, cwd: string, name: string): boolean {
  const isWindows = process.platform === "win32";
  try {
    const r = spawnSync(claudePath, ["mcp", "list"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
      encoding: "utf-8",
      shell: isWindows,
    });
    if (r.status !== 0) return false;
    const haystack = ((r.stdout || "") + (r.stderr || "")).toLowerCase();
    return haystack.includes(name.toLowerCase());
  } catch {
    return false;
  }
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
  // stream-json (NDJSON) is required to capture per-turn assistant messages
  // with their tool_use blocks and per-turn usage; the plain "json" format only
  // emits the final result object, which loses tool calls and reports only the
  // last turn's token usage.
  const result = spawnSync(
    claudePath,
    [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "20",
      "--permission-mode",
      "acceptEdits",
    ],
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
