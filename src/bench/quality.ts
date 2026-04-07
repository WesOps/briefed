import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import {
  findClaude,
  isMcpServerRegistered,
  runClaudeTask,
  stripBriefedPreservingMcp,
} from "./shared.js";
import { snapshotRepoState, restoreRepoState, type RepoStateSnapshot } from "./repo-state.js";
import { DEFAULT_CORPUS, ensureCorpus, type CorpusSpec } from "./corpus.js";
import { QUALITY_TASKS, type QualityTask } from "./quality-tasks.js";
import { judgeTranscript } from "./judge.js";
import { parseResult, type TaskMetrics } from "./metrics.js";

export interface QualityOptions {
  repo: string;
  quick?: boolean;
  full?: boolean;
  reportOnly?: boolean;
  arms?: string;
  rerun?: string;
  corpusRepo?: string;
  corpusRef?: string;
  timeoutMs?: number;
  resume?: boolean;
  outputDir?: string;
}

export interface ArmConfig {
  label: string;
  serena: boolean;
  briefed: "none" | "static" | "deep";
}

export const ARM_LABELS: Record<string, string> = {
  A: "no-serena + no-briefed",
  B: "no-serena + briefed-deep",
  C: "serena + no-briefed",
  D: "serena + briefed-deep",
  E: "no-serena + briefed-static",
  F: "serena + briefed-static",
};

const DEFAULT_MATRIX: ArmConfig[] = [
  { label: "A", serena: false, briefed: "none" },
  { label: "B", serena: false, briefed: "deep" },
  { label: "C", serena: true, briefed: "none" },
  { label: "D", serena: true, briefed: "deep" },
];

const FULL_EXTRA: ArmConfig[] = [
  { label: "E", serena: false, briefed: "static" },
  { label: "F", serena: true, briefed: "static" },
];

export function enumerateArms(opts: QualityOptions): ArmConfig[] {
  let arms = [...DEFAULT_MATRIX];
  if (opts.full) arms = arms.concat(FULL_EXTRA);
  if (opts.arms) {
    const wanted = new Set(opts.arms.split(",").map((s) => s.trim().toUpperCase()));
    arms = arms.filter((a) => wanted.has(a.label));
  }
  return arms;
}

export interface QualityCellResult {
  arm: ArmConfig;
  task: QualityTask;
  metrics: TaskMetrics | null;
  error: string | null;
}

/**
 * Main orchestrator. Single long function by design — the state-transition
 * sequencing is the whole point, and splitting it into helpers makes the
 * control flow harder to audit.
 */
export async function runQualityBench(opts: QualityOptions): Promise<QualityCellResult[]> {
  const hostRepo = resolve(opts.repo);
  const tasks = opts.quick ? QUALITY_TASKS.slice(0, 2) : QUALITY_TASKS;
  const arms = enumerateArms(opts);

  const outputDir = resolve(opts.outputDir || join(hostRepo, ".briefed", "bench", "quality"));
  const corpusCacheRoot = join(outputDir, "corpus");
  const timeoutMs = opts.timeoutMs || 600_000;
  const resume = opts.resume !== false;

  mkdirSync(outputDir, { recursive: true });

  const claudePath = findClaude();
  if (!claudePath) {
    console.error("  Error: 'claude' CLI not found. Install with: npm i -g @anthropic-ai/claude-code");
    return [];
  }
  console.log(`  Using: ${claudePath}`);

  // Corpus prep
  const corpus: CorpusSpec = {
    name: opts.corpusRepo ? deriveNameFromUrl(opts.corpusRepo) : DEFAULT_CORPUS.name,
    url: opts.corpusRepo || DEFAULT_CORPUS.url,
    ref: opts.corpusRef || DEFAULT_CORPUS.ref,
  };
  console.log(`  Corpus: ${corpus.name} @ ${corpus.ref.slice(0, 7)}`);
  let corpusPath: string;
  try {
    corpusPath = await ensureCorpus(corpus, corpusCacheRoot);
  } catch (e) {
    console.error(`  Corpus prep failed: ${(e as Error).message}`);
    return [];
  }
  console.log(`  Corpus path: ${corpusPath}`);

  // Plugin-serena detection for arms that need serena OFF
  const serenaIsPluginInstalled = detectPluginInstalledServer(claudePath, corpusPath, "serena");
  if (serenaIsPluginInstalled && arms.some((a) => !a.serena)) {
    console.error(
      "  Error: Serena is installed via a Claude Code plugin and cannot be\n" +
        "  temporarily disabled for the no-serena arms. Either:\n" +
        "    (a) uninstall the plugin for this bench,\n" +
        "    (b) pass `--arms C,D` to run only the serena arms, or\n" +
        "    (c) install Serena via .claude/settings.json instead.",
    );
    return [];
  }

  // Snapshot CORPUS state so every arm mutation is reversible
  const state: RepoStateSnapshot = snapshotRepoState(corpusPath);

  const restore = () => {
    try {
      restoreRepoState(state);
      console.log("  Corpus state restored.");
    } catch (e) {
      console.error(`  Restore failed: ${(e as Error).message}`);
    }
  };
  process.once("SIGINT", () => { restore(); process.exit(130); });
  process.once("SIGTERM", () => { restore(); process.exit(143); });

  const results: QualityCellResult[] = [];
  const pushedKeys = new Set<string>();

  // Parse rerun spec: "arm=D,task=env-var-audit" → {"D:env-var-audit"}
  // Multiple pairs allowed: "arm=A,task=x,arm=B,task=y" → {"A:x", "B:y"}
  const rerunSet = new Set<string>();
  if (opts.rerun) {
    const matches = opts.rerun.matchAll(/arm=([A-Z])\s*,\s*task=([a-z-]+)/gi);
    for (const m of matches) {
      rerunSet.add(`${m[1].toUpperCase()}:${m[2]}`);
    }
  }

  try {
    for (const arm of arms) {
      console.log(`\n  Arm ${arm.label}: ${ARM_LABELS[arm.label]}`);
      mkdirSync(join(outputDir, arm.label), { recursive: true });

      if (!opts.reportOnly) {
        try {
          applyArmState(corpusPath, arm, claudePath);
        } catch (e) {
          const msg = (e as Error).message;
          console.error(`    arm setup failed: ${msg.slice(0, 200)}`);
          for (const task of tasks) {
            results.push({ arm, task, metrics: null, error: `arm setup failed: ${msg}` });
            pushedKeys.add(`${arm.label}:${task.name}`);
          }
          continue;
        }

        for (let i = 0; i < tasks.length; i++) {
          const task = tasks[i];
          const out = join(outputDir, arm.label, `${task.name}.json`);
          const cellKey = `${arm.label}:${task.name}`;
          if (resume && existsSync(out) && !rerunSet.has(cellKey)) {
            console.log(`    [${i + 1}/${tasks.length}] ${task.name} (cached)`);
            continue;
          }
          console.log(`    [${i + 1}/${tasks.length}] ${task.name}`);
          try {
            runClaudeTask(claudePath, corpusPath, task.prompt, out, timeoutMs);
            const m = parseResult(out);
            console.log(
              `      ${(m.durationMs / 1000).toFixed(1)}s, ${m.numTurns} turns, ${m.totalToolCalls} tool calls`,
            );
          } catch (e) {
            console.error(`      Error: ${(e as Error).message.slice(0, 120)}`);
          }
        }
      }
    }
  } finally {
    restore();
  }

  // Judge pass (randomized order)
  console.log("\n  Judge pass:");
  const cells: Array<{ arm: ArmConfig; task: QualityTask }> = [];
  for (const arm of arms) for (const task of tasks) cells.push({ arm, task });
  shuffle(cells);

  for (const { arm, task } of cells) {
    const out = join(outputDir, arm.label, `${task.name}.json`);
    if (!existsSync(out)) continue;
    const judgeOut = out + ".judge.json";
    const cellKey = `${arm.label}:${task.name}`;
    if (resume && existsSync(judgeOut) && !rerunSet.has(cellKey)) continue;
    console.log(`    ${arm.label} / ${task.name}`);
    try {
      const score = judgeTranscript(claudePath, corpusPath, task, out);
      if (score) {
        console.log(
          `      overall=${score.overall}/5 coverage=${score.coverage} accuracy=${score.accuracy}`,
        );
      } else {
        console.log(`      unscored`);
      }
    } catch (e) {
      console.error(`      judge error: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  // Collect final results
  for (const arm of arms) {
    for (const task of tasks) {
      if (pushedKeys.has(`${arm.label}:${task.name}`)) continue;
      const out = join(outputDir, arm.label, `${task.name}.json`);
      if (!existsSync(out)) {
        results.push({ arm, task, metrics: null, error: "no transcript" });
        continue;
      }
      try {
        const m = parseResult(out);
        const judgeOut = out + ".judge.json";
        if (existsSync(judgeOut)) {
          try {
            const judged = JSON.parse(readFileSync(judgeOut, "utf-8")) as Record<string, unknown>;
            if (
              judged &&
              typeof judged.coverage === "number" && Number.isInteger(judged.coverage) &&
              typeof judged.accuracy === "number" && Number.isInteger(judged.accuracy) &&
              typeof judged.specificity === "number" && Number.isInteger(judged.specificity) &&
              typeof judged.overall === "number" && Number.isInteger(judged.overall) &&
              typeof judged.justification === "string"
            ) {
              m.correctness = {
                coverage: judged.coverage,
                accuracy: judged.accuracy,
                specificity: judged.specificity,
                overall: judged.overall,
                justification: judged.justification,
              };
            }
            // If validation fails, leave m.correctness as null and the cell shows "unscored"
          } catch {
            // Bad JSON in the .judge.json file — leave correctness as null
          }
        }
        results.push({ arm, task, metrics: m, error: null });
      } catch (e) {
        results.push({ arm, task, metrics: null, error: (e as Error).message });
      }
    }
  }

  return results;
}

function applyArmState(corpusPath: string, arm: ArmConfig, claudePath: string): void {
  // 1. Clean slate: strip any briefed artifacts
  stripBriefedPreservingMcp(corpusPath);

  // 2. Toggle serena presence in .claude/settings.json
  toggleSerenaInSettings(corpusPath, arm.serena);

  // 3. Install briefed if this arm requires it
  if (arm.briefed !== "none") {
    const briefedCli = join(import.meta.dirname, "..", "cli.js");
    const flags = ["init", "--repo", corpusPath, "--skip-hooks"];
    if (arm.briefed === "deep") flags.push("--deep");
    const result = spawnSync("node", [briefedCli, ...flags], {
      stdio: "inherit",
      timeout: 600_000,
    });
    if (result.status !== 0) {
      throw new Error(`briefed init exited with status ${result.status ?? "unknown"}`);
    }
    // Sanity: briefed MCP must be registered after init, otherwise the run is meaningless
    if (!isMcpServerRegistered(claudePath, corpusPath, "briefed")) {
      throw new Error(
        `briefed init succeeded but the briefed MCP server is not registered for ${corpusPath}. ` +
          `This arm cannot exercise briefed's MCP surface — aborting to avoid misleading bench numbers.`,
      );
    }
  }

  // 4. Sanity: if arm requires serena, it must still be visible after setup
  if (arm.serena && !isMcpServerRegistered(claudePath, corpusPath, "serena")) {
    throw new Error("serena required by this arm but not registered after setup");
  }
}

function toggleSerenaInSettings(corpusPath: string, enable: boolean): void {
  const settingsPath = join(corpusPath, ".claude", "settings.json");
  let parsed: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      parsed = {};
    }
  }
  const servers = (parsed.mcpServers as Record<string, unknown> | undefined) || {};
  if (enable) {
    if (!servers.serena) {
      servers.serena = {
        command: "uvx",
        args: [
          "--from",
          "git+https://github.com/oraios/serena",
          "serena-mcp-server",
          "--context",
          "ide-assistant",
          "--project",
          corpusPath,
        ],
      };
    }
  } else {
    delete servers.serena;
  }
  parsed.mcpServers = servers;
  mkdirSync(join(corpusPath, ".claude"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + "\n");
}

function detectPluginInstalledServer(claudePath: string, cwd: string, name: string): boolean {
  if (!isMcpServerRegistered(claudePath, cwd, name)) return false;
  const settingsPath = join(cwd, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return true;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const servers = (parsed.mcpServers || {}) as Record<string, unknown>;
    return !(name in servers);
  } catch {
    return true;
  }
}

function deriveNameFromUrl(url: string): string {
  const m = url.match(/\/([^/]+?)(\.git)?$/);
  return m ? m[1] : "corpus";
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * Format a numeric value with k/M suffixes for compact reporting.
 */
function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

/**
 * Generate a report string comparing arms across tasks.
 */
export function generateQualityReport(results: QualityCellResult[]): string {
  const lines: string[] = [];
  lines.push("  " + "=".repeat(80));
  lines.push("  briefed Quality Bench — correctness + tokens + speed");
  lines.push("  " + "=".repeat(80));
  lines.push("");

  const byTask = new Map<string, QualityCellResult[]>();
  for (const r of results) {
    if (!byTask.has(r.task.name)) byTask.set(r.task.name, []);
    byTask.get(r.task.name)!.push(r);
  }

  for (const [taskName, cells] of byTask) {
    lines.push(`  Task: ${taskName}`);
    lines.push("  " + "-".repeat(80));
    lines.push("    arm   duration   in-tokens   cost     overall  coverage  accuracy");
    lines.push("  " + "-".repeat(80));
    for (const cell of cells) {
      const m = cell.metrics;
      if (!m) {
        lines.push(`    ${cell.arm.label.padEnd(5)} ${(cell.error || "error").slice(0, 60)}`);
        continue;
      }
      const score = m.correctness;
      lines.push(
        `    ${cell.arm.label.padEnd(5)}` +
          ` ${(m.durationMs / 1000).toFixed(1).padStart(7)}s` +
          ` ${formatNum(m.inputTokens).padStart(10)}` +
          ` $${m.totalCostUsd.toFixed(4).padStart(6)}` +
          ` ${score ? (score.overall + "/5").padStart(8) : "unscored".padStart(8)}` +
          ` ${score ? (score.coverage + "/5").padStart(9) : "-".padStart(9)}` +
          ` ${score ? (score.accuracy + "/5").padStart(9) : "-".padStart(9)}`,
      );
    }
    lines.push("");
  }

  lines.push("  " + "=".repeat(80));
  lines.push("  SUMMARY (mean across tasks per arm)");
  lines.push("  " + "=".repeat(80));
  const armTotals = new Map<
    string,
    { count: number; duration: number; tokens: number; cost: number; overall: number; overallN: number }
  >();
  for (const r of results) {
    if (!r.metrics) continue;
    const key = r.arm.label;
    const t = armTotals.get(key) || {
      count: 0,
      duration: 0,
      tokens: 0,
      cost: 0,
      overall: 0,
      overallN: 0,
    };
    t.count++;
    t.duration += r.metrics.durationMs;
    t.tokens += r.metrics.inputTokens;
    t.cost += r.metrics.totalCostUsd;
    if (r.metrics.correctness) {
      t.overall += r.metrics.correctness.overall;
      t.overallN++;
    }
    armTotals.set(key, t);
  }
  for (const [label, t] of armTotals) {
    const meanOverall = t.overallN > 0 ? (t.overall / t.overallN).toFixed(2) : "—";
    lines.push(
      `    ${label} (${ARM_LABELS[label] || "?"})`.padEnd(45) +
        ` dur=${(t.duration / t.count / 1000).toFixed(1)}s` +
        ` tok=${formatNum(Math.round(t.tokens / t.count))}` +
        ` $${(t.cost / t.count).toFixed(4)}` +
        ` overall=${meanOverall}`,
    );
  }

  lines.push("  " + "=".repeat(80));
  return lines.join("\n");
}
