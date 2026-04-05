import { readFileSync } from "fs";

/**
 * Metrics extracted from a `claude -p --output-format json` result.
 */
export interface TaskMetrics {
  durationMs: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCostUsd: number;
  resultLength: number;
  sessionId: string;
  success: boolean;
  fileReads: number;      // how many Read tool calls (orientation cost)
  fileEdits: number;      // how many Edit/Write tool calls (actual work)
  uniqueFilesRead: number; // unique files read (deduped)
}

/**
 * Parse a claude -p JSON output file into metrics.
 */
export function parseResult(filePath: string): TaskMetrics {
  const content = readFileSync(filePath, "utf-8").trim();

  // Handle JSONL (multiple lines) — take the last valid JSON
  const lines = content.split("\n").filter(Boolean);
  let data: Record<string, unknown> | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed.type === "result" || parsed.duration_ms) {
        data = parsed;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!data) {
    // Try parsing the whole content as one JSON
    data = JSON.parse(content);
  }

  if (!data) throw new Error("No valid JSON found in transcript");

  const usage = (typeof data.usage === "object" && data.usage !== null ? data.usage : {}) as Record<string, unknown>;

  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  // Count tool calls from JSONL lines (each line may be a tool_use message)
  let fileReads = 0;
  let fileEdits = 0;
  const filesRead = new Set<string>();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      // Check for tool_use in content blocks
      const contents = Array.isArray(entry.content) ? entry.content : [];
      for (const block of contents) {
        if (block.type === "tool_use") {
          if (block.name === "Read") {
            fileReads++;
            if (block.input?.file_path) filesRead.add(block.input.file_path);
          } else if (block.name === "Edit" || block.name === "Write") {
            fileEdits++;
          }
        }
      }
      // Also check tool_name at top level (some formats)
      if (entry.tool_name === "Read") {
        fileReads++;
        if (entry.tool_input?.file_path) filesRead.add(entry.tool_input.file_path);
      } else if (entry.tool_name === "Edit" || entry.tool_name === "Write") {
        fileEdits++;
      }
    } catch { /* skip non-JSON lines */ }
  }

  return {
    durationMs: num(data.duration_ms),
    numTurns: num(data.num_turns),
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    totalCostUsd: num(data.total_cost_usd),
    resultLength: str(data.result).length,
    sessionId: str(data.session_id),
    success: data.subtype === "success" && !data.is_error,
    fileReads,
    fileEdits,
    uniqueFilesRead: filesRead.size,
  };
}

/**
 * Compare two task results and produce a formatted row.
 */
export function compareMetrics(
  without: TaskMetrics,
  withCctx: TaskMetrics,
  taskName: string
): string {
  const lines: string[] = [];
  lines.push(`  Task: "${taskName}"`);
  lines.push("  " + "─".repeat(62));
  lines.push(
    padRow("", "Without briefed", "With briefed", "Delta")
  );
  lines.push("  " + "─".repeat(62));

  lines.push(
    padRow(
      "Duration",
      `${(without.durationMs / 1000).toFixed(1)}s`,
      `${(withCctx.durationMs / 1000).toFixed(1)}s`,
      formatDelta(without.durationMs, withCctx.durationMs)
    )
  );

  lines.push(
    padRow(
      "Turns",
      without.numTurns.toString(),
      withCctx.numTurns.toString(),
      formatDelta(without.numTurns, withCctx.numTurns)
    )
  );

  lines.push(
    padRow(
      "Input tokens",
      formatNumber(without.inputTokens),
      formatNumber(withCctx.inputTokens),
      formatDelta(without.inputTokens, withCctx.inputTokens)
    )
  );

  lines.push(
    padRow(
      "Output tokens",
      formatNumber(without.outputTokens),
      formatNumber(withCctx.outputTokens),
      formatDelta(without.outputTokens, withCctx.outputTokens, true)
    )
  );

  lines.push(
    padRow(
      "Cache created",
      formatNumber(without.cacheCreationTokens),
      formatNumber(withCctx.cacheCreationTokens),
      formatDelta(without.cacheCreationTokens, withCctx.cacheCreationTokens)
    )
  );

  lines.push(
    padRow(
      "Cache read",
      formatNumber(without.cacheReadTokens),
      formatNumber(withCctx.cacheReadTokens),
      formatDelta(without.cacheReadTokens, withCctx.cacheReadTokens, true)
    )
  );

  lines.push(
    padRow(
      "Cost",
      `$${without.totalCostUsd.toFixed(4)}`,
      `$${withCctx.totalCostUsd.toFixed(4)}`,
      formatDelta(without.totalCostUsd, withCctx.totalCostUsd)
    )
  );

  lines.push(
    padRow(
      "File reads",
      without.fileReads.toString(),
      withCctx.fileReads.toString(),
      formatDelta(without.fileReads, withCctx.fileReads)
    )
  );

  lines.push(
    padRow(
      "Unique files read",
      without.uniqueFilesRead.toString(),
      withCctx.uniqueFilesRead.toString(),
      formatDelta(without.uniqueFilesRead, withCctx.uniqueFilesRead)
    )
  );

  lines.push(
    padRow(
      "File edits",
      without.fileEdits.toString(),
      withCctx.fileEdits.toString(),
      formatDelta(without.fileEdits, withCctx.fileEdits, true)
    )
  );

  // Efficiency ratio: edits per read (higher = less orientation overhead)
  const effWithout = without.fileReads > 0 ? (without.fileEdits / without.fileReads).toFixed(2) : "—";
  const effWith = withCctx.fileReads > 0 ? (withCctx.fileEdits / withCctx.fileReads).toFixed(2) : "—";
  lines.push(
    padRow("Edit/Read ratio", effWithout, effWith, "")
  );

  lines.push("  " + "─".repeat(62));
  return lines.join("\n");
}

/**
 * Generate a summary report from multiple task comparisons.
 */
export function generateSummary(
  results: Array<{
    task: string;
    without: TaskMetrics | null;
    withCctx: TaskMetrics | null;
  }>
): string {
  const lines: string[] = [];
  let compared = 0;
  let totalDurationWithout = 0;
  let totalDurationWith = 0;
  let totalInputWithout = 0;
  let totalInputWith = 0;
  let totalTurnsWithout = 0;
  let totalTurnsWith = 0;
  let totalCostWithout = 0;
  let totalCostWith = 0;

  for (const r of results) {
    if (r.without && r.withCctx) {
      compared++;
      totalDurationWithout += r.without.durationMs;
      totalDurationWith += r.withCctx.durationMs;
      totalInputWithout += r.without.inputTokens;
      totalInputWith += r.withCctx.inputTokens;
      totalTurnsWithout += r.without.numTurns;
      totalTurnsWith += r.withCctx.numTurns;
      totalCostWithout += r.without.totalCostUsd;
      totalCostWith += r.withCctx.totalCostUsd;
    }
  }

  if (compared === 0) {
    lines.push("  No tasks with both runs to compare.");
    return lines.join("\n");
  }

  lines.push("  " + "═".repeat(62));
  lines.push("  SUMMARY");
  lines.push("  " + "═".repeat(62));
  lines.push(`  Tasks compared:       ${compared}`);
  lines.push(
    `  Avg duration:         ${(totalDurationWithout / compared / 1000).toFixed(1)}s → ${(totalDurationWith / compared / 1000).toFixed(1)}s (${formatDelta(totalDurationWithout, totalDurationWith)})`
  );
  lines.push(
    `  Avg input tokens:     ${formatNumber(Math.round(totalInputWithout / compared))} → ${formatNumber(Math.round(totalInputWith / compared))} (${formatDelta(totalInputWithout, totalInputWith)})`
  );
  lines.push(
    `  Avg turns:            ${(totalTurnsWithout / compared).toFixed(1)} → ${(totalTurnsWith / compared).toFixed(1)} (${formatDelta(totalTurnsWithout, totalTurnsWith)})`
  );
  lines.push(
    `  Total cost:           $${totalCostWithout.toFixed(4)} → $${totalCostWith.toFixed(4)} (${formatDelta(totalCostWithout, totalCostWith)})`
  );
  lines.push("  " + "═".repeat(62));

  return lines.join("\n");
}

function padRow(label: string, col1: string, col2: string, col3: string): string {
  return `  ${label.padEnd(18)} ${col1.padStart(14)} ${col2.padStart(14)} ${col3.padStart(10)}`;
}

function formatDelta(before: number, after: number, _higherIsBetter = false): string {
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
