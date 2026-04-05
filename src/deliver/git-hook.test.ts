import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { installGitHook, removeGitHook } from "./git-hook.js";

describe("installGitHook", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "briefed-test-githook-"));
    // Initialize a git repo
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a post-commit hook in a git repo", () => {
    const result = installGitHook(tmpDir);
    expect(result).toBe(true);

    const hookPath = join(tmpDir, ".git", "hooks", "post-commit");
    expect(existsSync(hookPath)).toBe(true);
    const content = readFileSync(hookPath, "utf-8");
    expect(content).toContain("#!/bin/sh");
    expect(content).toContain("briefed: auto-update context");
    expect(content).toContain("npx briefed init --skip-hooks");
  });

  it("returns true if hook already installed (idempotent)", () => {
    installGitHook(tmpDir);
    const result = installGitHook(tmpDir);
    expect(result).toBe(true);

    // Should not duplicate the hook content
    const hookPath = join(tmpDir, ".git", "hooks", "post-commit");
    const content = readFileSync(hookPath, "utf-8");
    const matches = content.match(/briefed: auto-update context/g);
    expect(matches).toHaveLength(1);
  });

  it("appends to an existing post-commit hook", () => {
    const hooksDir = join(tmpDir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "post-commit");
    writeFileSync(hookPath, "#!/bin/sh\necho 'existing hook'\n");

    installGitHook(tmpDir);
    const content = readFileSync(hookPath, "utf-8");
    expect(content).toContain("existing hook");
    expect(content).toContain("briefed: auto-update context");
  });

  it("returns false for non-git directories", () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), "briefed-test-nogit-"));
    try {
      const result = installGitHook(nonGitDir);
      expect(result).toBe(false);
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});

describe("removeGitHook", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "briefed-test-githook-rm-"));
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes the briefed hook section", () => {
    installGitHook(tmpDir);
    removeGitHook(tmpDir);

    const hookPath = join(tmpDir, ".git", "hooks", "post-commit");
    // If only briefed's content was present, the file should be removed
    expect(existsSync(hookPath)).toBe(false);
  });

  it("preserves other hook content when removing briefed section", () => {
    const hooksDir = join(tmpDir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "post-commit");
    writeFileSync(hookPath, "#!/bin/sh\necho 'custom hook'\n");

    installGitHook(tmpDir);
    removeGitHook(tmpDir);

    expect(existsSync(hookPath)).toBe(true);
    const content = readFileSync(hookPath, "utf-8");
    expect(content).toContain("custom hook");
    expect(content).not.toContain("briefed: auto-update context");
  });

  it("does nothing for non-git directories", () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), "briefed-test-nogit-"));
    try {
      // Should not throw
      removeGitHook(nonGitDir);
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("does nothing if no hook exists", () => {
    // Should not throw
    removeGitHook(tmpDir);
  });
});
