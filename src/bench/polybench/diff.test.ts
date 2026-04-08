import { describe, it, expect } from "vitest";
import { filterDiff, isExcludedPath } from "./diff.js";

describe("isExcludedPath", () => {
  it("excludes cross-tool output files by exact match", () => {
    expect(isExcludedPath("CLAUDE.md")).toBe(true);
    expect(isExcludedPath("AGENTS.md")).toBe(true);
    expect(isExcludedPath(".cursorrules")).toBe(true);
    expect(isExcludedPath(".github/copilot-instructions.md")).toBe(true);
    expect(isExcludedPath("codex.md")).toBe(true);
    expect(isExcludedPath(".gitignore")).toBe(true);
  });

  it("excludes briefed and codesight artifacts by prefix", () => {
    expect(isExcludedPath(".briefed/index.json")).toBe(true);
    expect(isExcludedPath(".briefed/deep-cache.json")).toBe(true);
    expect(isExcludedPath(".briefed/contracts/foo.json")).toBe(true);
    expect(isExcludedPath(".codesight/CODESIGHT.md")).toBe(true);
    expect(isExcludedPath(".codesight/wiki/auth.md")).toBe(true);
    expect(isExcludedPath(".claude/rules/briefed-deep-src.md")).toBe(true);
    expect(isExcludedPath(".claude/settings.json")).toBe(true);
  });

  it("does NOT exclude source files that happen to contain similar names", () => {
    // A file literally named "briefed-utils.ts" under src/ is NOT a briefed
    // artifact — briefed's artifacts live under `.briefed/` and `.claude/rules/`.
    expect(isExcludedPath("src/briefed-utils.ts")).toBe(false);
    expect(isExcludedPath("src/utils/CLAUDE_helper.ts")).toBe(false);
    expect(isExcludedPath("docs/CLAUDE.md.backup")).toBe(false);
    expect(isExcludedPath("src/generators/flexbox.js")).toBe(false);
  });

  it("does NOT exclude files with similar but non-matching prefixes", () => {
    // `.briefedx` is not `.briefed/` — startsWith("briefed/") is what we check
    expect(isExcludedPath(".briefedx/foo.json")).toBe(false);
    expect(isExcludedPath("src/.briefed-like/foo.json")).toBe(false);
  });
});

describe("filterDiff", () => {
  const FIX_FLEXBOX_DIFF = `diff --git a/src/generators/flexbox.js b/src/generators/flexbox.js
index 10e26c30..30827dc7 100644
--- a/src/generators/flexbox.js
+++ b/src/generators/flexbox.js
@@ -90,7 +90,7 @@ export default function() {
     'flex-1': {
-      flex: '1',
+      flex: '1 1 0%',
     },
`;

  const BRIEFED_INDEX_DIFF = `diff --git a/.briefed/index.json b/.briefed/index.json
index d1ef293e..7868b9a5 100644
--- a/.briefed/index.json
+++ b/.briefed/index.json
@@ -306,5 +306,5 @@
     }
   ],
-  "generated": "2026-04-08T07:12:12.114Z"
+  "generated": "2026-04-08T07:12:14.740Z"
 }
`;

  const GITIGNORE_DIFF = `diff --git a/.gitignore b/.gitignore
index 60fd5ef5..5f4277d0 100644
--- a/.gitignore
+++ b/.gitignore
@@ -2,3 +2,9 @@
 /lib
+
+# briefed:start
+.briefed/extract-cache.json
+# briefed:end
`;

  it("returns empty string when all blocks are excluded", () => {
    const diff = BRIEFED_INDEX_DIFF + GITIGNORE_DIFF;
    expect(filterDiff(diff)).toBe("");
  });

  it("keeps source-only blocks intact", () => {
    const result = filterDiff(FIX_FLEXBOX_DIFF);
    expect(result).toContain("diff --git a/src/generators/flexbox.js");
    expect(result).toContain("flex: '1 1 0%'");
    expect(result.endsWith("\n")).toBe(true);
  });

  it("drops only the excluded blocks in a mixed diff", () => {
    const mixed = BRIEFED_INDEX_DIFF + FIX_FLEXBOX_DIFF + GITIGNORE_DIFF;
    const result = filterDiff(mixed);
    expect(result).toContain("src/generators/flexbox.js");
    expect(result).not.toContain(".briefed/index.json");
    expect(result).not.toContain(".gitignore");
    expect(result).not.toContain("briefed:start");
  });

  it("returns empty string for empty input", () => {
    expect(filterDiff("")).toBe("");
  });

  it("handles a diff with multiple source files", () => {
    const twoFiles =
      FIX_FLEXBOX_DIFF +
      `diff --git a/src/lib/generateUtilities.js b/src/lib/generateUtilities.js
index aaaaaaaa..bbbbbbbb 100644
--- a/src/lib/generateUtilities.js
+++ b/src/lib/generateUtilities.js
@@ -1,3 +1,3 @@
-const x = 1;
+const x = 2;
`;
    const result = filterDiff(twoFiles);
    expect(result).toContain("src/generators/flexbox.js");
    expect(result).toContain("src/lib/generateUtilities.js");
  });

  it("handles contamination in code-server-4923 shape (multiple tool artifacts)", () => {
    // The worst real-world case we saw: briefed regenerated CLAUDE.md,
    // AGENTS.md, .cursorrules, copilot-instructions, codex.md, and
    // .briefed/skeleton.md all between the base commit and the diff capture.
    const badDiff = `diff --git a/.briefed/index.json b/.briefed/index.json
index aaa..bbb 100644
--- a/.briefed/index.json
+++ b/.briefed/index.json
@@ -1,1 +1,1 @@
-old
+new
diff --git a/.briefed/skeleton.md b/.briefed/skeleton.md
index ccc..ddd 100644
--- a/.briefed/skeleton.md
+++ b/.briefed/skeleton.md
@@ -1,1 +1,1 @@
-old
+new
diff --git a/CLAUDE.md b/CLAUDE.md
index eee..fff 100644
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -1,1 +1,1 @@
-old
+new
diff --git a/AGENTS.md b/AGENTS.md
index 111..222 100644
--- a/AGENTS.md
+++ b/AGENTS.md
@@ -1,1 +1,1 @@
-old
+new
diff --git a/src/node/app.ts b/src/node/app.ts
index 333..444 100644
--- a/src/node/app.ts
+++ b/src/node/app.ts
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
diff --git a/src/node/cli.ts b/src/node/cli.ts
index 555..666 100644
--- a/src/node/cli.ts
+++ b/src/node/cli.ts
@@ -1,1 +1,1 @@
-const b = 1;
+const b = 2;
`;
    const result = filterDiff(badDiff);
    // The two source files should be preserved
    expect(result).toContain("src/node/app.ts");
    expect(result).toContain("src/node/cli.ts");
    // The four tool artifacts should be stripped
    expect(result).not.toContain(".briefed/index.json");
    expect(result).not.toContain(".briefed/skeleton.md");
    expect(result).not.toContain("CLAUDE.md");
    expect(result).not.toContain("AGENTS.md");
  });
});
