import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generateBreadcrumb, updateClaudeMd, saveSkeletonFile } from "./claudemd.js";

describe("generateBreadcrumb", () => {
  const breadcrumb = generateBreadcrumb();

  it("is short — the always-loaded tax matters", () => {
    // The bench result says fat CLAUDE.md hurts pass rate. Keep it tiny.
    expect(breadcrumb.length).toBeLessThan(1000);
  });

  it("points the model at .briefed/skeleton.md", () => {
    expect(breadcrumb).toContain(".briefed/skeleton.md");
  });

  it("points the model at .briefed/contracts/", () => {
    expect(breadcrumb).toContain(".briefed/contracts/");
  });

  it("mentions the path-scoped deep rules", () => {
    expect(breadcrumb).toContain(".claude/rules/briefed-deep-");
  });

  it("does not include the actual skeleton content (it's a breadcrumb)", () => {
    // Common fat-skeleton artifacts we should NOT see in a breadcrumb
    expect(breadcrumb).not.toContain("## src/");
    expect(breadcrumb).not.toContain("Schema:");
    expect(breadcrumb).not.toContain("API:");
    expect(breadcrumb).not.toContain("Required env");
  });
});

describe("updateClaudeMd", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "briefed-claudemd-test-"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("creates a new CLAUDE.md with the body wrapped in briefed markers", () => {
    updateClaudeMd(repo, "HELLO BODY");
    const content = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(content).toContain("<!-- briefed:start -->");
    expect(content).toContain("HELLO BODY");
    expect(content).toContain("<!-- briefed:end -->");
  });

  it("works with generateBreadcrumb() as the body", () => {
    updateClaudeMd(repo, generateBreadcrumb());
    const content = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(content).toContain(".briefed/skeleton.md");
    expect(content).toContain("briefed:start");
    expect(content).toContain("briefed:end");
  });

  it("preserves existing user content outside the briefed markers", () => {
    const existing =
      "# My Project\n\nSome user notes about auth.\n\n" +
      "Another paragraph about the build system.\n";
    writeFileSync(join(repo, "CLAUDE.md"), existing);

    updateClaudeMd(repo, "BRIEFED BODY");

    const content = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(content).toContain("# My Project");
    expect(content).toContain("Some user notes about auth");
    expect(content).toContain("Another paragraph about the build system");
    expect(content).toContain("BRIEFED BODY");
  });

  it("replaces an existing briefed section instead of duplicating it", () => {
    updateClaudeMd(repo, "FIRST BODY");
    updateClaudeMd(repo, "SECOND BODY");
    const content = readFileSync(join(repo, "CLAUDE.md"), "utf-8");

    expect(content).toContain("SECOND BODY");
    expect(content).not.toContain("FIRST BODY");
    // Exactly one start/end marker pair
    expect(content.match(/<!-- briefed:start -->/g)?.length).toBe(1);
    expect(content.match(/<!-- briefed:end -->/g)?.length).toBe(1);
  });

  it("strips a legacy cctx section if present", () => {
    const legacy =
      "# Project\n\n" +
      "<!-- cctx:start -->\nold cctx content\n<!-- cctx:end -->\n\n" +
      "User notes below.\n";
    writeFileSync(join(repo, "CLAUDE.md"), legacy);

    updateClaudeMd(repo, "NEW BRIEFED BODY");

    const content = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(content).not.toContain("cctx:start");
    expect(content).not.toContain("old cctx content");
    expect(content).toContain("User notes below");
    expect(content).toContain("NEW BRIEFED BODY");
  });
});

describe("saveSkeletonFile", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "briefed-skeleton-test-"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("writes the full skeleton to .briefed/skeleton.md", () => {
    const skeleton = "# full skeleton\n\nlots of content here";
    saveSkeletonFile(repo, skeleton);

    const path = join(repo, ".briefed", "skeleton.md");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(skeleton);
  });
});
