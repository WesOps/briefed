/**
 * Type definitions for the polybench universal benchmark harness.
 *
 * The harness runs paired comparisons of AI coding tools (briefed, codesight,
 * etc.) against SWE-PolyBench task instances. Each tool is a plug-in adapter
 * that implements `setup()` (run the tool's init step in a cloned repo) so
 * the harness can be extended to any context tool with a ~30 LOC file.
 */

/** A single SWE-PolyBench task instance, parsed from the dataset CSV. */
export interface PolyTask {
  /** e.g. "tailwindlabs__tailwindcss-550" — used as the row key everywhere. */
  instanceId: string;
  /** "owner/repo" — cloned via `git clone https://github.com/<repo>.git`. */
  repo: string;
  /** Full 40-char SHA the task targets. */
  baseCommit: string;
  /** The GitHub issue text handed to the model verbatim. */
  problemStatement: string;
  /** One of "TypeScript", "JavaScript", "Python", "Java", etc. */
  language: string;
}

/** Options passed to an adapter's setup() call. */
export interface AdapterOptions {
  /** Absolute path to the briefed dist/cli.js (used by the briefed adapter). */
  briefedCliPath: string;
  /** Per-step timeout for the adapter's init. */
  timeoutMs: number;
}

/**
 * An AI-coding-tool adapter. Adding a new tool to the harness = one new file
 * under `adapters/` plus one line in `adapters/registry.ts`.
 */
export interface PolyAdapter {
  /** Used on the CLI as `--arms <name>` and as the predictions file suffix. */
  name: string;
  /**
   * Optional per-arm setup, called ONCE before the arm's cell loop begins.
   * Intended for expensive arm-wide configuration like toggling Claude Code
   * plugins via `claude plugin enable/disable`. If this throws, the arm is
   * skipped entirely with the error recorded.
   */
  beforeArm?(): Promise<void>;
  /**
   * Optional per-arm teardown, called in a `finally` after the arm's cell loop
   * (even on error or cost-cap exit). MUST restore any state beforeArm mutated,
   * especially plugin enable/disable state, so subsequent arms and the user's
   * post-bench environment are clean. Failures here are logged but not thrown.
   */
  afterArm?(): Promise<void>;
  /**
   * Run the tool's init step in a freshly-cloned repo at the task's baseCommit.
   * Must throw on failure so the orchestrator can record the error and continue.
   */
  setup(repoPath: string, opts: AdapterOptions): Promise<void>;
  /** Optional teardown after a task completes (before the clone is wiped). */
  cleanup?(repoPath: string): Promise<void>;
}

/** Top-level options for a polybench run, populated from the CLI. */
export interface PolyBenchOptions {
  /** Which adapters to run (e.g. ["briefed", "codesight", "baseline"]). */
  arms: string[];
  /** Path to a SWE-PolyBench CSV export. */
  tasksCsv: string;
  /** Filter tasks by language (default "TypeScript"). */
  language?: string;
  /** Limit to the first N tasks after filtering (cost-control). */
  n?: number;
  /** Where predictions_*.jsonl and report.md are written. */
  outputDir: string;
  /** Where per-task repos are cloned (wiped after each task). */
  workDir: string;
  /** Hard cost cap — the harness aborts if total spent exceeds this. */
  maxCostUsd: number;
  /** Sleep between tasks within an arm to dodge per-account rate limits. */
  delayBetweenTasksMs: number;
  /** Run arms in parallel (default sequential). */
  parallelArms: boolean;
  /** Per-task claude -p timeout. */
  timeoutMs: number;
  /** claude -p --max-turns. */
  maxTurns: number;
  /** If true, skip cells whose prediction already exists on disk. */
  resume: boolean;
  /** If true, print the plan + estimated cost and exit without running. */
  dryRun: boolean;
  /** "arm=X,task=Y[,arm=X,task=Y]..." — cells to force re-run. */
  rerun?: string;
  /** Path to a SWE-PolyBench evaluator checkout (optional pass/fail step). */
  evaluatorPath?: string;
}

/** The result of one (arm, task) cell. Written as a line to predictions_<arm>.jsonl. */
export interface CellResult {
  instanceId: string;
  arm: string;
  /** Unified diff captured via `git diff HEAD`, post-filtered to source files. */
  modelPatch: string;
  elapsedSec: number;
  costUsd: number;
  numTurns: number | "unknown";
  /** Set when the cell errored mid-run (setup/claude/diff failure). */
  error: string | null;
  /** True if this cell was loaded from an existing predictions file (resume). */
  skipped: boolean;
}

/** Aggregated results for one arm after a polybench run finishes. */
export interface ArmReport {
  arm: string;
  results: CellResult[];
  totalCostUsd: number;
  totalElapsedSec: number;
  /** Populated only when the evaluator was run; null otherwise. */
  passCount: number | null;
  failCount: number | null;
}
