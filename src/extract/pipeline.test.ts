import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runExtractionPipeline } from "./pipeline.js";
import { scanFiles } from "./scanner.js";
import { detectStack } from "../utils/detect.js";

describe("runExtractionPipeline gotcha extraction", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "briefed-pipe-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "x", version: "0.0.0" })
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("does not extract gotchas from test files (avoids fixture leakage)", () => {
    // Real source — should produce one gotcha.
    writeFileSync(
      join(root, "src", "real.ts"),
      `// FIXME: This payment retry loop must back off exponentially or we get rate-limited\nexport const x = 1;\n`
    );

    // Test file with the SAME comment-shaped strings inside string literals.
    // Without the test-file skip these would be matched and leak into rules.
    writeFileSync(
      join(root, "src", "real.test.ts"),
      [
        "import { it } from 'vitest';",
        "it('extracts', () => {",
        "  const fixture = `// TODO: This rate limiter must be checked before processing payments`;",
        "  const fixture2 = `// HACK: This workaround is needed because the API returns stale cache entries`;",
        "  return [fixture, fixture2];",
        "});",
        "",
      ].join("\n")
    );

    const scan = scanFiles(root);
    const stack = detectStack(root);
    const result = runExtractionPipeline(root, scan, stack);

    // Only the real source's FIXME should appear; nothing from .test.ts.
    const importantComments = result.gotchas.filter(
      (g) => g.category === "important_comment"
    );
    expect(importantComments.length).toBe(1);
    expect(importantComments[0].file).toContain("real.ts");
    expect(importantComments[0].file).not.toContain(".test.ts");
    expect(importantComments[0].text).toContain("FIXME");

    for (const g of result.gotchas) {
      expect(g.file).not.toContain(".test.ts");
      expect(g.file).not.toContain(".spec.ts");
    }
  });
});
