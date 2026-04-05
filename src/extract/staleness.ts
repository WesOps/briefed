import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

export interface StalenessReport {
  isStale: boolean;
  lastIndexed: Date | null;
  changedFiles: number;
  totalFiles: number;
  stalePct: number;
  details: string[];
}

/**
 * Check if the briefed context is stale (source files changed since last index).
 */
export function checkStaleness(root: string): StalenessReport {
  const report: StalenessReport = {
    isStale: false,
    lastIndexed: null,
    changedFiles: 0,
    totalFiles: 0,
    stalePct: 0,
    details: [],
  };

  const indexPath = join(root, ".briefed", "index.json");
  if (!existsSync(indexPath)) {
    report.isStale = true;
    report.details.push("No index found — run briefed init");
    return report;
  }

  // Get last indexed time
  const indexStat = statSync(indexPath);
  report.lastIndexed = indexStat.mtime;

  // Use git to find files changed since last index
  try {
    const sinceDate = indexStat.mtime.toISOString();
    const changedOutput = execSync(
      `git diff --name-only --diff-filter=ACMR HEAD -- "*.ts" "*.tsx" "*.js" "*.jsx" "*.py" "*.go" "*.rs" "*.java"`,
      { cwd: root, encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    // Also check for uncommitted changes
    const uncommitted = execSync(
      `git status --porcelain -- "*.ts" "*.tsx" "*.js" "*.jsx" "*.py" "*.go" "*.rs" "*.java"`,
      { cwd: root, encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    const changed = new Set<string>();
    if (changedOutput) {
      for (const f of changedOutput.split("\n")) changed.add(f.trim());
    }
    if (uncommitted) {
      for (const line of uncommitted.split("\n")) {
        const file = line.trim().slice(3); // strip status chars
        if (file) changed.add(file);
      }
    }

    // Check which changed files are newer than the index
    let staleCount = 0;
    for (const file of changed) {
      const fullPath = join(root, file);
      if (existsSync(fullPath)) {
        const fileStat = statSync(fullPath);
        if (fileStat.mtime > indexStat.mtime) {
          staleCount++;
          if (staleCount <= 5) {
            report.details.push(`  changed: ${file}`);
          }
        }
      }
    }

    if (staleCount > 5) {
      report.details.push(`  ... and ${staleCount - 5} more`);
    }

    report.changedFiles = staleCount;

    // Load index to get total file count
    try {
      const index = JSON.parse(readFileSync(indexPath, "utf-8"));
      report.totalFiles = index.modules?.reduce(
        (sum: number, m: { files?: string[] }) => sum + (m.files?.length || 0),
        0
      ) || 0;
    } catch { /* skip */ }

    report.stalePct = report.totalFiles > 0
      ? Math.round((staleCount / report.totalFiles) * 100)
      : 0;

    // Consider stale if >10% of files changed or >5 files changed
    report.isStale = staleCount > 5 || report.stalePct > 10;

  } catch {
    // Not a git repo or git not available — check file timestamps
    report.details.push("No git available — using timestamp comparison");
    report.isStale = true;
  }

  return report;
}

/**
 * Format staleness report for display.
 */
export function formatStaleness(report: StalenessReport): string {
  if (!report.isStale) {
    const age = report.lastIndexed
      ? timeSince(report.lastIndexed)
      : "unknown";
    return `  Context is fresh (indexed ${age} ago)`;
  }

  const lines: string[] = [];
  lines.push(`  Context is STALE — ${report.changedFiles} files changed since last index`);
  for (const d of report.details) {
    lines.push(d);
  }
  lines.push(`  Run: npx briefed init`);
  return lines.join("\n");
}

function timeSince(date: Date): string {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}
