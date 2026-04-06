import { readFileSync } from "fs";
import { join, dirname, basename, extname } from "path";
import { glob } from "glob";

export interface TestMapping {
  sourceFile: string;     // relative path to source file
  testFile: string;       // relative path to matching test file
  testNames: string[];    // extracted test/describe/it names
  testCount: number;      // number of test cases
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

  // Match source files to test files
  for (const sourceFile of sourceFiles) {
    if (isTestFile(sourceFile)) continue;

    const matched = findMatchingTest(sourceFile, testFileSet);
    if (matched) {
      const testPath = join(root, matched);
      let testNames: string[] = [];
      let testCount = 0;

      try {
        const content = readFileSync(testPath, "utf-8");
        const extracted = extractTestNames(content, extname(matched));
        testNames = extracted.names;
        testCount = extracted.count;
      } catch {
        // Can't read test file — still map it
      }

      mappings.push({
        sourceFile,
        testFile: matched,
        testNames,
        testCount,
      });
    }
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
 * Find the test file that matches a given source file.
 */
function findMatchingTest(
  sourceFile: string,
  testFiles: Set<string>
): string | null {
  const dir = dirname(sourceFile);
  const ext = extname(sourceFile);
  const name = basename(sourceFile, ext);

  // Try common test file naming patterns
  const candidates = [
    // Colocated: foo.test.ts next to foo.ts
    `${dir}/${name}.test${ext}`,
    `${dir}/${name}.spec${ext}`,
    // __tests__ directory
    `${dir}/__tests__/${name}.test${ext}`,
    `${dir}/__tests__/${name}${ext}`,
    // test/ directory at same level
    `${dir.replace(/\/src\//, "/test/")}/${name}.test${ext}`,
    `${dir.replace(/\/src\//, "/test/")}/${name}${ext}`,
    `${dir.replace(/\/src\//, "/tests/")}/${name}.test${ext}`,
    // test/ at root
    `test/${name}.test${ext}`,
    `test/${name}${ext}`,
    `tests/${name}.test${ext}`,
    // Python conventions
    `${dir}/test_${name}${ext}`,
    `test/test_${name}${ext}`,
    `tests/test_${name}${ext}`,
    // Go conventions
    `${dir}/${name}_test${ext}`,
    // Rust conventions
    `tests/${name}${ext}`,
  ];

  for (const candidate of candidates) {
    const normalized = candidate.replace(/\\/g, "/");
    if (testFiles.has(normalized)) return normalized;
  }

  // Fuzzy match: look for any test file containing the source name
  for (const testFile of testFiles) {
    const testName = basename(testFile, extname(testFile))
      .replace(/\.test$|\.spec$|^test_|_test$/, "");
    if (testName === name) return testFile;
  }

  return null;
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
