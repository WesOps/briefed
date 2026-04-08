/**
 * CSV task loader for the polybench harness.
 *
 * Reads a SWE-PolyBench export CSV (see the `AmazonScience/SWE-PolyBench`
 * datasets on HuggingFace) and yields `PolyTask` objects filtered by
 * language. We ship our own minimal CSV parser to avoid pulling in a new
 * dependency — the SWE-PolyBench format has embedded newlines and embedded
 * double quotes inside `problem_statement`, so a naive split-on-comma fails.
 */

import { existsSync, readFileSync } from "fs";
import type { PolyTask } from "./types.js";

/**
 * Parse CSV text into rows of strings. Handles:
 * - Quoted fields with embedded commas
 * - Quoted fields with embedded newlines
 * - Escaped quotes (`""` inside a quoted field)
 * - RFC 4180 conformant enough for SWE-PolyBench's exports
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        // Check for escaped quote "" inside a quoted field
        if (text[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      currentField += ch;
      i++;
      continue;
    }
    // Not in quotes
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      currentRow.push(currentField);
      currentField = "";
      i++;
      continue;
    }
    if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = "";
      i += ch === "\r" ? 2 : 1;
      continue;
    }
    currentField += ch;
    i++;
  }
  // Flush trailing partial row (no trailing newline)
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }
  return rows;
}

const REQUIRED_COLUMNS = [
  "instance_id",
  "repo",
  "base_commit",
  "problem_statement",
  "language",
] as const;

/**
 * Load PolyTask rows from a SWE-PolyBench CSV, filtered by language, limited
 * to the first `n` rows after filtering (if set). Throws if the file is
 * missing or the required columns aren't present.
 */
export function loadTasks(csvPath: string, language: string, n?: number): PolyTask[] {
  if (!existsSync(csvPath)) {
    throw new Error(`tasks CSV not found: ${csvPath}`);
  }
  const content = readFileSync(csvPath, "utf-8");
  const rows = parseCsv(content);
  if (rows.length === 0) return [];

  const header = rows[0];
  const colIdx: Record<string, number> = {};
  for (const col of REQUIRED_COLUMNS) {
    const idx = header.indexOf(col);
    if (idx === -1) {
      throw new Error(
        `CSV missing required column "${col}". Found columns: ${header.join(", ")}`,
      );
    }
    colIdx[col] = idx;
  }

  const tasks: PolyTask[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < header.length) continue; // skip malformed row
    const taskLanguage = row[colIdx.language] ?? "";
    if (taskLanguage !== language) continue;
    tasks.push({
      instanceId: row[colIdx.instance_id] ?? "",
      repo: row[colIdx.repo] ?? "",
      baseCommit: row[colIdx.base_commit] ?? "",
      problemStatement: row[colIdx.problem_statement] ?? "",
      language: taskLanguage,
    });
    if (n !== undefined && tasks.length >= n) break;
  }
  return tasks;
}
