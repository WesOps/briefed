import { execSync } from "child_process";

export interface FileChurn {
  file: string;
  commits: number;   // commits in window
  authors: number;   // distinct authors in window
}

/**
 * Compute commit churn per file over a time window. Files that change a
 * lot are typically where bugs live and where AI agents should be careful.
 *
 * Uses a single `git log` invocation rather than per-file calls so it
 * stays fast on large repos.
 */
export function extractChurn(root: string, daysAgo: number = 90): FileChurn[] {
  let raw: string;
  try {
    raw = execSync(
      `git log --since="${daysAgo} days ago" --name-only --pretty=format:"AUTHOR:%an"`,
      { cwd: root, encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch {
    return [];
  }

  const counts = new Map<string, { commits: number; authors: Set<string> }>();
  let currentAuthor = "";
  const lines = raw.split("\n");

  for (const line of lines) {
    if (line.startsWith("AUTHOR:")) {
      currentAuthor = line.slice("AUTHOR:".length);
      continue;
    }
    const file = line.trim();
    if (!file) continue;
    let entry = counts.get(file);
    if (!entry) {
      entry = { commits: 0, authors: new Set() };
      counts.set(file, entry);
    }
    entry.commits++;
    if (currentAuthor) entry.authors.add(currentAuthor);
  }

  const result: FileChurn[] = [];
  for (const [file, { commits, authors }] of counts) {
    result.push({ file, commits, authors: authors.size });
  }
  result.sort((a, b) => b.commits - a.commits);
  return result;
}

/**
 * Format the top hot files for inclusion in the skeleton.
 * Filters to files that still exist (filtered against the scan set).
 */
export function formatChurn(churn: FileChurn[], existingFiles: Set<string>, top: number = 10): string {
  const filtered = churn.filter((c) => existingFiles.has(c.file)).slice(0, top);
  if (filtered.length === 0) return "";
  const lines: string[] = [];
  lines.push(`Hot files (last 90d, touch carefully):`);
  for (const c of filtered) {
    const authorTag = c.authors > 1 ? `, ${c.authors} authors` : "";
    lines.push(`  - ${c.file} (${c.commits} commits${authorTag})`);
  }
  return lines.join("\n");
}
