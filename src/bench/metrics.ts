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

  // The transcript may be:
  //   1) A single JSON array of events (claude --output-format json)
  //   2) JSONL (one JSON object per line)
  //   3) A single JSON object (just the result)
  let entries: Record<string, unknown>[] = [];
  try {
    const parsed = JSON.parse(content);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Fall back to JSONL parsing
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch { /* skip */ }
    }
  }

  // Find the result entry (usually last)
  let data: Record<string, unknown> | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "result" || e.duration_ms) {
      data = e;
      break;
    }
  }
  if (!data && entries.length > 0) data = entries[entries.length - 1];
  if (!data) throw new Error("No valid JSON found in transcript");

  const usage = (typeof data.usage === "object" && data.usage !== null ? data.usage : {}) as Record<string, unknown>;

  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  // Count tool_use blocks across all entries.
  // Tool use blocks live at entry.message.content[].{type:"tool_use",name,input}
  // for assistant messages in the streaming format.
  let fileReads = 0;
  let fileEdits = 0;
  const filesRead = new Set<string>();
  for (const entry of entries) {
    const message = (entry.message as Record<string, unknown> | undefined);
    const contents = Array.isArray(message?.content)
      ? (message.content as Record<string, unknown>[])
      : Array.isArray(entry.content)
        ? (entry.content as Record<string, unknown>[])
        : [];
    for (const block of contents) {
      if (block.type !== "tool_use") continue;
      const name = block.name;
      const input = (block.input as Record<string, unknown> | undefined) || {};
      if (name === "Read") {
        fileReads++;
        const fp = input.file_path;
        if (typeof fp === "string") filesRead.add(fp);
      } else if (name === "Edit" || name === "Write" || name === "MultiEdit") {
        fileEdits++;
      }
    }
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
 * Three-way comparison: baseline / with briefed / with briefed --deep.
 * Printed as four columns so you can eyeball whether the extra deep cost
 * is worth it versus the static skeleton alone.
 */
export function compareMetrics3(
  without: TaskMetrics,
  withCctx: TaskMetrics,
  withDeep: TaskMetrics,
  taskName: string,
): string {
  const lines: string[] = [];
  lines.push(`  Task: "${taskName}"`);
  lines.push("  " + "─".repeat(78));
  lines.push(pad4("", "Baseline", "Static", "Deep", "Δ deep vs base"));
  lines.push("  " + "─".repeat(78));

  lines.push(
    pad4(
      "Duration",
      `${(without.durationMs / 1000).toFixed(1)}s`,
      `${(withCctx.durationMs / 1000).toFixed(1)}s`,
      `${(withDeep.durationMs / 1000).toFixed(1)}s`,
      formatDelta(without.durationMs, withDeep.durationMs),
    ),
  );
  lines.push(
    pad4(
      "Turns",
      without.numTurns.toString(),
      withCctx.numTurns.toString(),
      withDeep.numTurns.toString(),
      formatDelta(without.numTurns, withDeep.numTurns),
    ),
  );
  lines.push(
    pad4(
      "Input tokens",
      formatNumber(without.inputTokens),
      formatNumber(withCctx.inputTokens),
      formatNumber(withDeep.inputTokens),
      formatDelta(without.inputTokens, withDeep.inputTokens),
    ),
  );
  lines.push(
    pad4(
      "Output tokens",
      formatNumber(without.outputTokens),
      formatNumber(withCctx.outputTokens),
      formatNumber(withDeep.outputTokens),
      formatDelta(without.outputTokens, withDeep.outputTokens, true),
    ),
  );
  lines.push(
    pad4(
      "Cost",
      `$${without.totalCostUsd.toFixed(4)}`,
      `$${withCctx.totalCostUsd.toFixed(4)}`,
      `$${withDeep.totalCostUsd.toFixed(4)}`,
      formatDelta(without.totalCostUsd, withDeep.totalCostUsd),
    ),
  );
  lines.push(
    pad4(
      "File reads",
      without.fileReads.toString(),
      withCctx.fileReads.toString(),
      withDeep.fileReads.toString(),
      formatDelta(without.fileReads, withDeep.fileReads),
    ),
  );
  lines.push(
    pad4(
      "Unique reads",
      without.uniqueFilesRead.toString(),
      withCctx.uniqueFilesRead.toString(),
      withDeep.uniqueFilesRead.toString(),
      formatDelta(without.uniqueFilesRead, withDeep.uniqueFilesRead),
    ),
  );
  lines.push(
    pad4(
      "File edits",
      without.fileEdits.toString(),
      withCctx.fileEdits.toString(),
      withDeep.fileEdits.toString(),
      formatDelta(without.fileEdits, withDeep.fileEdits, true),
    ),
  );

  lines.push("  " + "─".repeat(78));
  return lines.join("\n");
}

function pad4(label: string, c1: string, c2: string, c3: string, c4: string): string {
  return `  ${label.padEnd(14)} ${c1.padStart(12)} ${c2.padStart(12)} ${c3.padStart(12)} ${c4.padStart(14)}`;
}

/**
 * Generate a summary report from multiple task comparisons.
 */
export function generateSummary(
  results: Array<{
    task: string;
    without: TaskMetrics | null;
    withCctx: TaskMetrics | null;
    withDeep?: TaskMetrics | null;
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

  // Deep arm totals (only populated when results have withDeep)
  let deepCompared = 0;
  let totalDurationDeep = 0;
  let totalInputDeep = 0;
  let totalTurnsDeep = 0;
  let totalCostDeep = 0;

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

      if (r.withDeep) {
        deepCompared++;
        totalDurationDeep += r.withDeep.durationMs;
        totalInputDeep += r.withDeep.inputTokens;
        totalTurnsDeep += r.withDeep.numTurns;
        totalCostDeep += r.withDeep.totalCostUsd;
      }
    }
  }

  if (compared === 0) {
    lines.push("  No tasks with both runs to compare.");
    return lines.join("\n");
  }

  lines.push("  " + "═".repeat(62));
  lines.push("  SUMMARY");
  lines.push("  " + "═".repeat(62));
  lines.push(`  Tasks compared:       ${compared}${deepCompared > 0 ? ` (${deepCompared} with deep)` : ""}`);
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

  if (deepCompared > 0) {
    lines.push("");
    lines.push("  Deep arm (vs baseline):");
    lines.push(
      `  Avg duration:         ${(totalDurationWithout / deepCompared / 1000).toFixed(1)}s → ${(totalDurationDeep / deepCompared / 1000).toFixed(1)}s (${formatDelta(totalDurationWithout, totalDurationDeep)})`
    );
    lines.push(
      `  Avg input tokens:     ${formatNumber(Math.round(totalInputWithout / deepCompared))} → ${formatNumber(Math.round(totalInputDeep / deepCompared))} (${formatDelta(totalInputWithout, totalInputDeep)})`
    );
    lines.push(
      `  Avg turns:            ${(totalTurnsWithout / deepCompared).toFixed(1)} → ${(totalTurnsDeep / deepCompared).toFixed(1)} (${formatDelta(totalTurnsWithout, totalTurnsDeep)})`
    );
    lines.push(
      `  Total cost:           $${totalCostWithout.toFixed(4)} → $${totalCostDeep.toFixed(4)} (${formatDelta(totalCostWithout, totalCostDeep)})`
    );
  }

  lines.push("  " + "═".repeat(62));

  return lines.join("\n");
}

function padRow(label: string, col1: string, col2: string, col3: string): string {
  return `  ${label.padEnd(18)} ${col1.padStart(14)} ${col2.padStart(14)} ${col3.padStart(10)}`;
}

function formatDelta(before: number, after: number, higherIsBetter = false): string {
  if (before === 0 && after === 0) return "—";
  if (before === 0) return `+${after}`;
  const pct = Math.round(((after - before) / before) * 100);
  const sign = pct >= 0 ? "+" : "";
  const good = higherIsBetter ? pct > 0 : pct < 0;
  const indicator = pct === 0 ? "" : good ? " ✓" : " ✗";
  return `${sign}${pct}%${indicator}`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}
