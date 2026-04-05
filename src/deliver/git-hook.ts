import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

/**
 * Install a git post-commit hook that auto-updates briefed context.
 * Runs `briefed init --skip-hooks` after every commit (~5 seconds).
 * Developer never thinks about it — context stays fresh automatically.
 */
export function installGitHook(root: string) {
  // Find the git hooks directory
  let hooksDir: string;
  try {
    const gitDir = execSync("git rev-parse --git-dir", {
      cwd: root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    hooksDir = join(root, gitDir, "hooks");
  } catch {
    // Not a git repo — skip
    return false;
  }

  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  const hookPath = join(hooksDir, "post-commit");
  const briefedMarker = "# briefed: auto-update context";

  const hookScript = `#!/bin/sh
${briefedMarker}
# Re-index codebase after each commit to keep context fresh.
# Runs in background so it doesn't slow down your commit.
# Remove this hook with: briefed unhook
(npx briefed init --skip-hooks > /dev/null 2>&1 &)
`;

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");

    // Already has briefed hook
    if (existing.includes(briefedMarker)) return true;

    // Append to existing hook
    writeFileSync(hookPath, existing.trimEnd() + "\n\n" + hookScript);
  } else {
    writeFileSync(hookPath, hookScript);
  }

  // Make executable (Unix/Mac)
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    // Windows doesn't need chmod
  }

  return true;
}

/**
 * Remove briefed's git hook.
 */
export function removeGitHook(root: string) {
  let hooksDir: string;
  try {
    const gitDir = execSync("git rev-parse --git-dir", {
      cwd: root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    hooksDir = join(root, gitDir, "hooks");
  } catch {
    return;
  }

  const hookPath = join(hooksDir, "post-commit");
  if (!existsSync(hookPath)) return;

  const content = readFileSync(hookPath, "utf-8");
  const briefedMarker = "# briefed: auto-update context";

  if (!content.includes(briefedMarker)) return;

  // Remove the briefed section
  const lines = content.split("\n");
  const filtered: string[] = [];
  let inBriefedBlock = false;

  for (const line of lines) {
    if (line.includes(briefedMarker)) {
      inBriefedBlock = true;
      continue;
    }
    if (inBriefedBlock && (line.startsWith("#") || line.startsWith("(npx briefed"))) {
      continue;
    }
    inBriefedBlock = false;
    filtered.push(line);
  }

  const remaining = filtered.join("\n").trim();
  if (remaining === "#!/bin/sh" || !remaining) {
    // Hook is now empty — remove it
    const { unlinkSync } = require("fs");
    unlinkSync(hookPath);
  } else {
    writeFileSync(hookPath, remaining + "\n");
  }
}
