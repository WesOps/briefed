import { readFileSync } from "fs";
import { join, dirname, basename, extname } from "path";
import { glob } from "glob";

export interface TestCandidate {
  file: string;
  score: number;
  reasons: string[];
}

export interface TestMapping {
  sourceFile: string;     // relative path to source file
  testFile: string;       // best-match test file (primary)
  testNames: string[];    // extracted test/describe/it names
  testCount: number;      // number of test cases
  confidence: number;     // 0-1: how confident we are in the primary match
  candidates: TestCandidate[];  // all scored candidates, best first
}

/**
 * Find test files that correspond to source files.
 * Uses naming conventions: foo.test.ts, foo.spec.ts, test_foo.py, etc.
 * This is the #1 research-backed improvement: +45.97% pass@1 (TiCoder, IEEE TSE).
 */
export function findTestMappings(
  sourceFiles: string[],
  root: string
): TestMapping[] {
  const mappings: TestMapping[] = [];

  // Build a map of all test files for fast lookup
  const testFileSet = new Set<string>();
  const allFiles = sourceFiles;

  for (const f of allFiles) {
    if (isTestFile(f)) testFileSet.add(f);
  }

  // Also scan for test files not in the source list (test/ directories)
  try {
    const testGlobs = [
      "test/**/*.{ts,tsx,js,jsx,py,go,rs}",
      "tests/**/*.{ts,tsx,js,jsx,py,go,rs}",
      "**/*.test.{ts,tsx,js,jsx}",
      "**/*.spec.{ts,tsx,js,jsx}",
      "**/test_*.py",
      "**/*_test.go",
      "**/*_test.rs",
    ];
    for (const pattern of testGlobs) {
      const found = glob.sync(pattern, {
        cwd: root,
        ignore: ["node_modules/**", ".git/**", "dist/**", "build/**"],
      });
      for (const f of found) testFileSet.add(f.replace(/\\/g, "/"));
    }
  } catch {
    // glob errors are non-fatal
  }

  // Match source files to test files — ranked candidates with confidence
  for (const sourceFile of sourceFiles) {
    if (isTestFile(sourceFile)) continue;

    const candidates = scoreTestCandidates(sourceFile, testFileSet, root);
    if (candidates.length === 0) continue;

    const best = candidates[0];
    const testPath = join(root, best.file);
    let testNames: string[] = [];
    let testCount = 0;

    try {
      const content = readFileSync(testPath, "utf-8");
      const extracted = extractTestNames(content, extname(best.file));
      testNames = extracted.names;
      testCount = extracted.count;
    } catch {
      // Can't read test file — still map it
    }

    // Confidence: normalize best score; 10+ = exact match = 1.0
    const confidence = Math.min(best.score / 10, 1);

    mappings.push({
      sourceFile,
      testFile: best.file,
      testNames,
      testCount,
      confidence,
      candidates: candidates.slice(0, 3),
    });
  }

  return mappings;
}

/**
 * Check if a file path looks like a test file.
 */
function isTestFile(filePath: string): boolean {
  const name = basename(filePath);
  return (
    name.includes(".test.") ||
    name.includes(".spec.") ||
    name.includes("_test.") ||
    name.startsWith("test_") ||
    filePath.includes("/test/") ||
    filePath.includes("/tests/") ||
    filePath.includes("/__tests__/")
  );
}

/**
 * Score all test file candidates for a source file.
 * Returns ranked candidates (highest score first).
 *
 * Scoring:
 *   +10  exact basename match (foo.test.ts for foo.ts)
 *   + 5  partial basename match (foo appears in test name)
 *   + 3  same directory
 *   + 2  __tests__ sibling directory
 *   + 2  conventional path replacement (src/ → test/)
 *   + 1  fuzzy name contains source name
 */
function scoreTestCandidates(
  sourceFile: string,
  testFiles: Set<string>,
  _root: string,
): TestCandidate[] {
  const dir = dirname(sourceFile);
  const ext = extname(sourceFile);
  const name = basename(sourceFile, ext);
  const scores = new Map<string, { score: number; reasons: string[] }>();

  function addScore(file: string, delta: number, reason: string) {
    const normalized = file.replace(/\\/g, "/");
    if (!testFiles.has(normalized)) return;
    const entry = scores.get(normalized) ?? { score: 0, reasons: [] };
    entry.score += delta;
    entry.reasons.push(reason);
    scores.set(normalized, entry);
  }

  // Exact colocated patterns
  addScore(`${dir}/${name}.test${ext}`, 10, "exact basename");
  addScore(`${dir}/${name}.spec${ext}`, 10, "exact basename");
  addScore(`${dir}/__tests__/${name}.test${ext}`, 9, "__tests__ sibling");
  addScore(`${dir}/__tests__/${name}${ext}`, 8, "__tests__ sibling");
  addScore(`${dir.replace(/\/src\//, "/test/")}/${name}.test${ext}`, 7, "src→test path");
  addScore(`${dir.replace(/\/src\//, "/test/")}/${name}${ext}`, 6, "src→test path");
  addScore(`${dir.replace(/\/src\//, "/tests/")}/${name}.test${ext}`, 7, "src→tests path");
  addScore(`test/${name}.test${ext}`, 5, "root test dir");
  addScore(`test/${name}${ext}`, 4, "root test dir");
  addScore(`tests/${name}.test${ext}`, 5, "root tests dir");
  addScore(`tests/${name}${ext}`, 4, "root tests dir");
  // Language-specific
  addScore(`${dir}/test_${name}${ext}`, 10, "python exact");
  addScore(`test/test_${name}${ext}`, 8, "python test dir");
  addScore(`tests/test_${name}${ext}`, 8, "python tests dir");
  addScore(`${dir}/${name}_test${ext}`, 10, "go exact");
  addScore(`tests/${name}${ext}`, 6, "rust tests dir");

  // Fuzzy: scan all test files for partial name match
  for (const testFile of testFiles) {
    if (scores.has(testFile)) continue; // already scored exactly
    const testName = basename(testFile, extname(testFile))
      .replace(/\.test$|\.spec$|^test_|_test$/, "");
    if (testName === name) {
      addScore(testFile, 5, "fuzzy basename match");
    } else if (testName.includes(name) || name.includes(testName)) {
      addScore(testFile, 2, "partial name match");
    }
  }

  return [...scores.entries()]
    .map(([file, { score, reasons }]) => ({ file, score, reasons }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Extract test names (describe/it/test blocks) from a test file.
 */
function extractTestNames(
  content: string,
  ext: string
): { names: string[]; count: number } {
  const names: string[] = [];

  if ([".ts", ".tsx", ".js", ".jsx", ".mjs"].includes(ext)) {
    // JS/TS: describe("name"), it("name"), test("name")
    const regex = /(?:describe|it|test)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    for (const match of content.matchAll(regex)) {
      names.push(match[1]);
    }
  } else if (ext === ".py") {
    // Python: def test_name, class TestName
    const fnRegex = /def\s+(test_\w+)/g;
    const classRegex = /class\s+(Test\w+)/g;
    for (const match of content.matchAll(fnRegex)) names.push(match[1]);
    for (const match of content.matchAll(classRegex)) names.push(match[1]);
  } else if (ext === ".go") {
    // Go: func TestName(t *testing.T)
    const regex = /func\s+(Test\w+)\s*\(/g;
    for (const match of content.matchAll(regex)) names.push(match[1]);
  } else if (ext === ".rs") {
    // Rust: #[test] fn test_name()
    const regex = /fn\s+(test_\w+)\s*\(/g;
    for (const match of content.matchAll(regex)) names.push(match[1]);
  }

  return { names, count: names.length };
}
