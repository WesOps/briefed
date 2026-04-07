import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ensureCorpus, DEFAULT_CORPUS } from "./corpus.js";
import * as simpleGitModule from "simple-git";

vi.mock("simple-git");

describe("ensureCorpus", () => {
  let cacheRoot: string;
  let mockClone: ReturnType<typeof vi.fn>;
  let mockCheckout: ReturnType<typeof vi.fn>;
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockRevparse: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "briefed-corpus-test-"));

    mockClone = vi.fn().mockResolvedValue(undefined);
    mockCheckout = vi.fn().mockResolvedValue(undefined);
    mockFetch = vi.fn().mockResolvedValue(undefined);
    mockRevparse = vi.fn().mockResolvedValue("19eeb4ba358781ea447762e70403f7b78994db10\n");

    vi.mocked(simpleGitModule.simpleGit).mockReturnValue({
      clone: mockClone,
      checkout: mockCheckout,
      fetch: mockFetch,
      revparse: mockRevparse,
    } as unknown as ReturnType<typeof simpleGitModule.simpleGit>);
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
    vi.clearAllMocks();
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

  it("throws with corpus context if cached checkout is corrupted", async () => {
    const target = join(cacheRoot, "epic-stack");
    mkdirSync(join(target, ".git"), { recursive: true });

    mockRevparse.mockRejectedValue(new Error("corrupted index"));

    await expect(ensureCorpus(DEFAULT_CORPUS, cacheRoot)).rejects.toThrow(
      /epic-stack[\s\S]*19eeb4ba[\s\S]*Delete the directory/,
    );
  });

  it("falls back to --unshallow when first checkout fails", async () => {
    mockCheckout.mockRejectedValueOnce(new Error("pathspec did not match")).mockResolvedValueOnce(undefined);

    const path = await ensureCorpus(DEFAULT_CORPUS, cacheRoot);
    expect(path).toBe(join(cacheRoot, "epic-stack"));
    expect(mockFetch).toHaveBeenCalledWith(["--unshallow"]);
    expect(mockCheckout).toHaveBeenCalledTimes(2);
  });

  it("warns and returns existing non-git directory as-is", async () => {
    const target = join(cacheRoot, "epic-stack");
    mkdirSync(target, { recursive: true });
    // No .git directory — just a plain dir

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const path = await ensureCorpus(DEFAULT_CORPUS, cacheRoot);
      expect(path).toBe(target);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnMsg: string = warnSpy.mock.calls[0][0];
      expect(warnMsg).toContain("not a git checkout");
      expect(warnMsg).toContain("19eeb4ba358781ea447762e70403f7b78994db10");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
