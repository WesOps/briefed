import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * Snapshot of everything the quality bench might mutate. Excludes the
 * bench output directory (.briefed/bench/quality) itself so results
 * accumulated during the run survive restore.
 */
export interface RepoStateSnapshot {
  repo: string;
  files: Map<string, string | null>;
  dirs: Map<string, Map<string, string>>;
  absentDirs: Set<string>;
}

const TRACKED_FILES = ["CLAUDE.md", ".claude/settings.json"];
const TRACKED_DIRS = [".claude/rules", ".briefed"];
const SNAPSHOT_EXCLUDE_PREFIXES = [".briefed/bench/quality"];

export function snapshotRepoState(repo: string): RepoStateSnapshot {
  const files = new Map<string, string | null>();
  for (const rel of TRACKED_FILES) {
    const p = join(repo, rel);
    files.set(rel, existsSync(p) ? readFileSync(p, "utf-8") : null);
  }

  const dirs = new Map<string, Map<string, string>>();
  const absentDirs = new Set<string>();
  for (const rel of TRACKED_DIRS) {
    const p = join(repo, rel);
    if (!existsSync(p)) {
      absentDirs.add(rel);
      continue;
    }
    dirs.set(rel, snapshotDir(repo, p));
  }

  return { repo, files, dirs, absentDirs };
}

function snapshotDir(repo: string, absDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative(repo, full);
      if (SNAPSHOT_EXCLUDE_PREFIXES.some((p) => rel === p || rel.startsWith(p + "/"))) continue;
      const s = statSync(full);
      if (s.isDirectory()) walk(full);
      else if (s.isFile()) out.set(rel, readFileSync(full, "utf-8"));
    }
  };
  walk(absDir);
  return out;
}

export function restoreRepoState(state: RepoStateSnapshot): void {
  for (const [rel, content] of state.files) {
    const p = join(state.repo, rel);
    if (content === null) {
      if (existsSync(p)) rmSync(p, { force: true });
    } else {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
    }
  }

  for (const rel of TRACKED_DIRS) {
    const absDir = join(state.repo, rel);
    if (state.absentDirs.has(rel)) {
      if (existsSync(absDir)) wipeDirExcludingExcluded(state.repo, absDir);
      continue;
    }
    if (!existsSync(absDir)) mkdirSync(absDir, { recursive: true });
    wipeDirExcludingExcluded(state.repo, absDir);
    const snap = state.dirs.get(rel)!;
    for (const [relFile, content] of snap) {
      const p = join(state.repo, relFile);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
    }
  }
}

function wipeDirExcludingExcluded(repo: string, absDir: string) {
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative(repo, full);
      if (SNAPSHOT_EXCLUDE_PREFIXES.some((p) => rel === p || rel.startsWith(p + "/"))) continue;
      const s = statSync(full);
      if (s.isDirectory()) {
        walk(full);
        try {
          if (readdirSync(full).length === 0) rmSync(full, { recursive: true, force: true });
        } catch { /* ignore */ }
      } else {
        rmSync(full, { force: true });
      }
    }
  };
  walk(absDir);
}
