import { execSync } from "child_process";

export interface FileHistory {
  file: string;
  recentCommits: CommitInfo[];
  changeFrequency: number;   // commits in last 30 days
  lastChanged: string | null; // ISO date
}

export interface CommitInfo {
  hash: string;
  message: string;
  date: string;
  author: string;
}

/**
 * Extract recent git history for files.
 * Shows WHY code is the way it is — addresses the "wrong problem mapping" failure (21% of LLM errors).
 */
export function getFileHistory(
  filePath: string,
  root: string,
  maxCommits: number = 5
): FileHistory | null {
  try {
    const result = execSync(
      `git log --format="%H|%s|%ai|%an" -n ${maxCommits} --follow -- "${filePath}"`,
      { cwd: root, encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    if (!result) return null;

    const commits: CommitInfo[] = result
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, message, date, author] = line.split("|");
        return {
          hash: hash?.slice(0, 7) || "",
          message: (message || "").trim(),
          date: (date || "").trim(),
          author: (author || "").trim(),
        };
      })
      .filter((c) => c.message && !isTrivialCommit(c.message));

    // Count commits in last 30 days
    let recentCount = 0;
    try {
      const countResult = execSync(
        `git log --since="30 days ago" --oneline --follow -- "${filePath}"`,
        { cwd: root, encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      recentCount = countResult ? countResult.split("\n").length : 0;
    } catch {
      // ignore
    }

    return {
      file: filePath,
      recentCommits: commits,
      changeFrequency: recentCount,
      lastChanged: commits[0]?.date || null,
    };
  } catch {
    return null;
  }
}

/**
 * Get history for multiple files efficiently.
 * Only processes files above a complexity threshold (don't waste time on simple files).
 */
export function getBatchHistory(
  files: Array<{ path: string; complexity: number }>,
  root: string,
  complexityThreshold: number = 3
): Map<string, FileHistory> {
  const histories = new Map<string, FileHistory>();

  // Only get history for complex files (above threshold)
  const importantFiles = files.filter((f) => f.complexity >= complexityThreshold);

  for (const file of importantFiles) {
    const history = getFileHistory(file.path, root);
    if (history && history.recentCommits.length > 0) {
      histories.set(file.path, history);
    }
  }

  return histories;
}

/**
 * Filter out trivial/noisy commit messages.
 */
function isTrivialCommit(message: string): boolean {
  const trivial = [
    /^merge\s/i,
    /^wip$/i,
    /^fixup/i,
    /^squash/i,
    /^revert\s+"?revert/i,
    /^bump\s+version/i,
    /^update\s+dependencies/i,
    /^chore\(deps\)/i,
    /^auto-commit/i,
    /^initial commit$/i,
  ];
  return trivial.some((r) => r.test(message.trim()));
}
