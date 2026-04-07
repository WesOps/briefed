import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ensureCorpus, DEFAULT_CORPUS } from "./corpus.js";

vi.mock("simple-git", () => {
  return {
    simpleGit: vi.fn(() => ({
      clone: vi.fn().mockResolvedValue(undefined),
      checkout: vi.fn().mockResolvedValue(undefined),
      fetch: vi.fn().mockResolvedValue(undefined),
      revparse: vi.fn().mockResolvedValue("19eeb4ba358781ea447762e70403f7b78994db10\n"),
    })),
  };
});

describe("ensureCorpus", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "briefed-corpus-test-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("returns cacheRoot/<repo-name> on first call", async () => {
    const path = await ensureCorpus(DEFAULT_CORPUS, cacheRoot);
    expect(path).toBe(join(cacheRoot, "epic-stack"));
  });

  it("reuses existing checkout if the ref already matches", async () => {
    const target = join(cacheRoot, "epic-stack");
    mkdirSync(target, { recursive: true });
    mkdirSync(join(target, ".git"));
    writeFileSync(join(target, "marker"), "pre-existing");

    const path = await ensureCorpus(DEFAULT_CORPUS, cacheRoot);
    expect(path).toBe(target);
    expect(existsSync(join(target, "marker"))).toBe(true);
  });

  it("DEFAULT_CORPUS is epic-stack pinned to a real 40-char SHA", () => {
    expect(DEFAULT_CORPUS.name).toBe("epic-stack");
    expect(DEFAULT_CORPUS.url).toMatch(/epicweb-dev\/epic-stack/);
    expect(DEFAULT_CORPUS.ref).toMatch(/^[0-9a-f]{40}$/);
  });
});
