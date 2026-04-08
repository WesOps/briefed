/**
 * Clone a SWE-PolyBench task's repo and manage the base-commit state.
 *
 * Workflow per task:
 *   1. cloneTask() — wipe any prior dir, `git clone` the task's repo, checkout baseCommit
 *   2. adapter.setup(repoPath) runs — writes CLAUDE.md, .briefed/, etc.
 *   3. commitBaseState() — git add + commit, so `git diff HEAD` later captures
 *      ONLY the model's changes, not the adapter's artifacts
 *   4. claude -p runs, edits source files
 *   5. captureAndFilterDiff() reads git diff HEAD (filtered to source-only)
 *   6. caller rm -rf's the clone dir
 *
 * Keeping the commit AFTER the adapter runs is the fix for the contamination
 * bug we hit in the manual bench — otherwise briefed's deep-cache timestamp
 * and codesight's wiki files show up in the model_patch as "the model's fix."
 */

import { spawnSync } from "child_process";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { simpleGit } from "simple-git";
import type { PolyTask } from "./types.js";

/**
 * Clone the task's repo at its baseCommit into `<workDir>/<instanceId>/`.
 * Wipes any pre-existing directory at that path first (task reruns are safe).
 * Returns the absolute repo path.
 */
export async function cloneTask(task: PolyTask, workDir: string): Promise<string> {
  mkdirSync(workDir, { recursive: true });
  const repoPath = resolve(join(workDir, task.instanceId));

  if (existsSync(repoPath)) {
    rmSync(repoPath, { recursive: true, force: true });
  }

  const cloneUrl = `https://github.com/${task.repo}.git`;
  const git = simpleGit();
  await git.clone(cloneUrl, repoPath);

  const repo = simpleGit(repoPath);
  try {
    await repo.checkout(task.baseCommit);
  } catch {
    // SWE-PolyBench sometimes targets commits not reachable from the default
    // branch. Fetch everything (unshallow is a no-op on full clones) and retry.
    await repo.fetch(["--all", "--tags"]);
    await repo.checkout(task.baseCommit);
  }

  return repoPath;
}

/**
 * Commit the current working-tree state (after the adapter ran) as the
 * "base" commit. Subsequent `git diff HEAD` will therefore show only
 * post-base changes — i.e. the model's edits — not the adapter's artifacts.
 *
 * Uses `--allow-empty` because for the baseline arm (no adapter), nothing has
 * been written and we still need a fresh commit to anchor the diff.
 * Uses in-command `-c user.*` so we don't pollute the user's global git config.
 */
export async function commitBaseState(repoPath: string): Promise<void> {
  // Stage everything including any new files the adapter wrote
  const add = spawnSync("git", ["add", "-A"], {
    cwd: repoPath,
    stdio: "pipe",
    encoding: "utf-8",
  });
  if (add.status !== 0) {
    throw new Error(`git add -A failed in ${repoPath}: ${(add.stderr || "").slice(0, 200)}`);
  }

  const commit = spawnSync(
    "git",
    [
      "-c",
      "user.email=bench@local",
      "-c",
      "user.name=bench",
      "commit",
      "--allow-empty",
      "-m",
      "polybench base",
    ],
    {
      cwd: repoPath,
      stdio: "pipe",
      encoding: "utf-8",
    },
  );
  if (commit.status !== 0) {
    throw new Error(
      `git commit failed in ${repoPath}: ${(commit.stderr || "").slice(0, 200)}`,
    );
  }
}
