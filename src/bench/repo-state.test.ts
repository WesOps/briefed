import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { snapshotRepoState, restoreRepoState } from "./repo-state.js";

describe("RepoState", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "briefed-state-test-"));
    mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
    mkdirSync(join(repo, ".briefed"), { recursive: true });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("restores CLAUDE.md, settings.json, rules/, .briefed/ to snapshot state", () => {
    writeFileSync(join(repo, "CLAUDE.md"), "original\n");
    writeFileSync(join(repo, ".claude", "settings.json"), '{"original":true}');
    writeFileSync(join(repo, ".claude", "rules", "r.md"), "orig-rule");
    writeFileSync(join(repo, ".briefed", "skeleton.md"), "orig-skel");

    const state = snapshotRepoState(repo);

    writeFileSync(join(repo, "CLAUDE.md"), "mutated\n");
    writeFileSync(join(repo, ".claude", "settings.json"), '{"mutated":true}');
    writeFileSync(join(repo, ".claude", "rules", "r.md"), "mut-rule");
    writeFileSync(join(repo, ".claude", "rules", "new.md"), "added");
    writeFileSync(join(repo, ".briefed", "skeleton.md"), "mut-skel");

    restoreRepoState(state);

    expect(readFileSync(join(repo, "CLAUDE.md"), "utf-8")).toBe("original\n");
    expect(readFileSync(join(repo, ".claude", "settings.json"), "utf-8")).toBe('{"original":true}');
    expect(readFileSync(join(repo, ".claude", "rules", "r.md"), "utf-8")).toBe("orig-rule");
    expect(existsSync(join(repo, ".claude", "rules", "new.md"))).toBe(false);
    expect(readFileSync(join(repo, ".briefed", "skeleton.md"), "utf-8")).toBe("orig-skel");
  });

  it("restores missing files to missing state", () => {
    const state = snapshotRepoState(repo);
    writeFileSync(join(repo, "CLAUDE.md"), "created-after-snapshot");
    restoreRepoState(state);
    expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);
  });

  it("excludes the quality bench output dir from the .briefed snapshot", () => {
    mkdirSync(join(repo, ".briefed", "bench", "quality"), { recursive: true });
    writeFileSync(join(repo, ".briefed", "bench", "quality", "should-survive.txt"), "keep-me");
    writeFileSync(join(repo, ".briefed", "skeleton.md"), "orig");

    const state = snapshotRepoState(repo);
    writeFileSync(join(repo, ".briefed", "skeleton.md"), "mut");
    writeFileSync(join(repo, ".briefed", "bench", "quality", "new.txt"), "also-keep");
    restoreRepoState(state);

    expect(readFileSync(join(repo, ".briefed", "skeleton.md"), "utf-8")).toBe("orig");
    expect(existsSync(join(repo, ".briefed", "bench", "quality", "should-survive.txt"))).toBe(true);
    expect(existsSync(join(repo, ".briefed", "bench", "quality", "new.txt"))).toBe(true);
  });
});
