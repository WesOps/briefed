# Danger-Zone Annotations + Test Assertion Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend deep analysis to produce defensive context ("what breaks if you change this wrong") and surface test assertion content, raising briefed's ceiling from navigation-only to fix-quality assistance.

**Architecture:** Two workstreams feeding each other. Workstream B (test assertion extraction) is pure static analysis in `tests.ts`. Workstream A (danger-zone annotations) modifies the deep analysis prompt, response parser, cache format, and rules output in `deep.ts`. B feeds into A as input to the LLM prompt. Output surfaces through path-scoped rules, MCP tools, and hooks.

**Tech Stack:** TypeScript, vitest, existing `deep.ts` LLM pipeline (`claude -p`), existing depGraph symbolRefs

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/extract/tests.ts` | Modify | Add `extractTestAssertions()`, update `TestMapping` interface, call from `findTestMappings` |
| `src/extract/tests.test.ts` | Create | Tests for `extractTestAssertions` |
| `src/extract/deep.ts` | Modify | `parseBatchResponse` handles `{description, danger}`, `buildBatchPrompt` adds caller+test context, `DeepCacheEntry` gains `dangerZones`, `buildDeepRules` emits danger+expects lines |
| `src/extract/deep.test.ts` | Modify | Tests for new `parseBatchResponse` format, `buildDeepRules` danger output |
| `src/deliver/output.ts` | Modify | Include assertions in `test-map.json` serialization |
| `src/mcp/test-map.ts` | Modify | Include assertions in MCP tool output |
| `src/deliver/hooks.ts` | Modify | Include assertion lines in UserPromptSubmit hook test injection |

---

### Task 1: extractTestAssertions — failing tests

**Files:**
- Create: `src/extract/tests.test.ts`

- [ ] **Step 1: Write tests for extractTestAssertions**

```typescript
import { describe, it, expect } from "vitest";
import { extractTestAssertions } from "./tests.js";

describe("extractTestAssertions", () => {
  it("extracts expect() lines from JS/TS test blocks", () => {
    const content = `
describe("Color", () => {
  it("parses hsl with decimals", () => {
    const c = new Color();
    c.setStyle("hsl(120, 50.5%, 30.2%)");
    expect(c.r).toBeCloseTo(0.151);
    expect(c.g).toBeCloseTo(0.453);
  });

  it("returns black for invalid input", () => {
    const c = new Color();
    c.setStyle("garbage");
    expect(c.r).toBe(0);
    expect(c.g).toBe(0);
    expect(c.b).toBe(0);
  });
});`;
    const result = extractTestAssertions(content, ".ts");
    expect(result.get("parses hsl with decimals")).toEqual([
      "expect(c.r).toBeCloseTo(0.151);",
      "expect(c.g).toBeCloseTo(0.453);",
    ]);
    expect(result.get("returns black for invalid input")).toEqual([
      "expect(c.r).toBe(0);",
      "expect(c.g).toBe(0);",
      "expect(c.b).toBe(0);",
    ]);
  });

  it("extracts assert lines from Python test functions", () => {
    const content = `
def test_parse_color():
    c = Color.from_hsl(120, 0.5, 0.3)
    assert c.r == pytest.approx(0.151)
    assert c.g == pytest.approx(0.453)

def test_invalid_color():
    c = Color.from_string("garbage")
    assert c.r == 0
`;
    const result = extractTestAssertions(content, ".py");
    expect(result.get("test_parse_color")).toEqual([
      "assert c.r == pytest.approx(0.151)",
      "assert c.g == pytest.approx(0.453)",
    ]);
    expect(result.get("test_invalid_color")).toEqual([
      "assert c.r == 0",
    ]);
  });

  it("caps assertions at 5 per test", () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      `    expect(result[${i}]).toBe(${i});`
    ).join("\n");
    const content = `it("many asserts", () => {\n${lines}\n});`;
    const result = extractTestAssertions(content, ".ts");
    expect(result.get("many asserts")!.length).toBe(5);
  });

  it("truncates long assertion lines to 120 chars", () => {
    const longExpect = `    expect(someVeryLongVariableName.withChainedProperty.andAnotherOne).toEqual({ key: "a very long value that pushes this well beyond the truncation limit for assertion lines" });`;
    const content = `it("long assert", () => {\n${longExpect}\n});`;
    const result = extractTestAssertions(content, ".ts");
    expect(result.get("long assert")![0].length).toBeLessThanOrEqual(120);
  });

  it("returns empty map when no tests found", () => {
    const result = extractTestAssertions("const x = 1;", ".ts");
    expect(result.size).toBe(0);
  });

  it("handles nested describe blocks", () => {
    const content = `
describe("outer", () => {
  describe("inner", () => {
    it("deep test", () => {
      expect(true).toBe(true);
    });
  });
});`;
    const result = extractTestAssertions(content, ".ts");
    expect(result.get("deep test")).toEqual(["expect(true).toBe(true);"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/extract/tests.test.ts`
Expected: FAIL — `extractTestAssertions` is not exported from `./tests.js`

- [ ] **Step 3: Commit test file**

```bash
git add src/extract/tests.test.ts
git commit -m "test: add tests for extractTestAssertions"
```

---

### Task 2: extractTestAssertions — implementation

**Files:**
- Modify: `src/extract/tests.ts:184-213` (after `extractTestNames`)

- [ ] **Step 1: Add extractTestAssertions function**

Add after line 213 in `src/extract/tests.ts`:

```typescript
/**
 * Extract assertion lines from test blocks, mapped by test name.
 * Used to feed danger-zone context into deep analysis prompts and
 * surface in path-scoped rules so the model knows what tests verify.
 */
export function extractTestAssertions(
  content: string,
  ext: string,
): Map<string, string[]> {
  const result = new Map<string, string[]>();

  if ([".ts", ".tsx", ".js", ".jsx", ".mjs"].includes(ext)) {
    // JS/TS: find it("name", ...) or test("name", ...) blocks and extract expect() lines
    const lines = content.split("\n");
    let currentTest: string | null = null;
    let braceDepth = 0;
    let testStartDepth = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      // Detect test block start
      const testMatch = trimmed.match(/^(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/);
      if (testMatch && currentTest === null) {
        currentTest = testMatch[1];
        testStartDepth = braceDepth;
        result.set(currentTest, []);
      }

      // Track brace depth
      for (const ch of trimmed) {
        if (ch === "{") braceDepth++;
        if (ch === "}") braceDepth--;
      }

      // Extract assertion lines inside current test
      if (currentTest && /(?:expect\(|assert\(|assert\.)/.test(trimmed)) {
        const assertions = result.get(currentTest)!;
        if (assertions.length < 5) {
          const truncated = trimmed.length > 120 ? trimmed.slice(0, 117) + "..." : trimmed;
          assertions.push(truncated);
        }
      }

      // Detect test block end
      if (currentTest && braceDepth <= testStartDepth) {
        currentTest = null;
      }
    }
  } else if (ext === ".py") {
    // Python: find def test_name blocks and extract assert lines
    const lines = content.split("\n");
    let currentTest: string | null = null;
    let testIndent = 0;

    for (const line of lines) {
      const fnMatch = line.match(/^(\s*)def\s+(test_\w+)/);
      if (fnMatch) {
        currentTest = fnMatch[2];
        testIndent = fnMatch[1].length;
        result.set(currentTest, []);
        continue;
      }

      // End of test: non-empty line at same or lesser indent
      if (currentTest && line.trim() && !/^\s/.test(line)) {
        currentTest = null;
        continue;
      }
      if (currentTest && line.trim()) {
        const lineIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
        if (lineIndent <= testIndent && line.trim()) {
          currentTest = null;
          continue;
        }
      }

      if (currentTest && /\bassert\b/.test(line.trim())) {
        const assertions = result.get(currentTest)!;
        if (assertions.length < 5) {
          const trimmed = line.trim();
          const truncated = trimmed.length > 120 ? trimmed.slice(0, 117) + "..." : trimmed;
          assertions.push(truncated);
        }
      }
    }
  }
  // Go and Rust: skip for now — JS/TS and Python cover the bench task languages

  return result;
}
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/extract/tests.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/extract/tests.ts src/extract/tests.test.ts
git commit -m "feat: add extractTestAssertions for danger-zone context"
```

---

### Task 3: Wire assertions into TestMapping and test-map.json

**Files:**
- Modify: `src/extract/tests.ts:11-18` (TestMapping interface)
- Modify: `src/extract/tests.ts:70-80` (findTestMappings — call extractTestAssertions)
- Modify: `src/deliver/output.ts:41-44` (test-map.json serialization)

- [ ] **Step 1: Extend TestMapping interface**

In `src/extract/tests.ts`, add `assertions` field to the `TestMapping` interface (after line 15):

```typescript
export interface TestMapping {
  sourceFile: string;
  testFile: string;
  testNames: string[];
  testCount: number;
  confidence: number;
  candidates: TestCandidate[];
  assertions: Map<string, string[]>;  // testName → assertion lines
}
```

- [ ] **Step 2: Call extractTestAssertions in findTestMappings**

In `src/extract/tests.ts`, modify the block at lines 73-80 inside `findTestMappings` to also extract assertions:

Replace:
```typescript
    try {
      const content = readFileSync(testPath, "utf-8");
      const extracted = extractTestNames(content, extname(best.file));
      testNames = extracted.names;
      testCount = extracted.count;
    } catch {
      // Can't read test file — still map it
    }
```

With:
```typescript
    let assertions = new Map<string, string[]>();
    try {
      const content = readFileSync(testPath, "utf-8");
      const extracted = extractTestNames(content, extname(best.file));
      testNames = extracted.names;
      testCount = extracted.count;
      assertions = extractTestAssertions(content, extname(best.file));
    } catch {
      // Can't read test file — still map it
    }
```

- [ ] **Step 3: Include assertions in the mapping object**

In `src/extract/tests.ts`, modify the push at lines 85-92 to include `assertions`:

Replace:
```typescript
    mappings.push({
      sourceFile,
      testFile: best.file,
      testNames,
      testCount,
      confidence,
      candidates: candidates.slice(0, 3),
    });
```

With:
```typescript
    mappings.push({
      sourceFile,
      testFile: best.file,
      testNames,
      testCount,
      confidence,
      candidates: candidates.slice(0, 3),
      assertions,
    });
```

- [ ] **Step 4: Serialize assertions into test-map.json**

In `src/deliver/output.ts`, modify line 43 to include assertions:

Replace:
```typescript
      Object.fromEntries(result.testMappings.map((t) => [t.sourceFile, { test: t.testFile, count: t.testCount, names: t.testNames.slice(0, 10) }])),
```

With:
```typescript
      Object.fromEntries(result.testMappings.map((t) => [t.sourceFile, {
        test: t.testFile,
        count: t.testCount,
        names: t.testNames.slice(0, 10),
        assertions: Object.fromEntries(
          [...t.assertions.entries()].slice(0, 10).map(([name, lines]) => [name, lines])
        ),
      }])),
```

- [ ] **Step 5: Run existing tests to check nothing is broken**

Run: `npx vitest run`
Expected: All existing tests PASS (assertions field is additive)

- [ ] **Step 6: Commit**

```bash
git add src/extract/tests.ts src/deliver/output.ts
git commit -m "feat: wire test assertions into TestMapping and test-map.json"
```

---

### Task 4: parseBatchResponse — handle {description, danger} format

**Files:**
- Modify: `src/extract/deep.ts:734-767` (parseBatchResponse)
- Modify: `src/extract/deep.test.ts:52-98` (add tests)

- [ ] **Step 1: Write failing tests for new response format**

Add to `src/extract/deep.test.ts` inside the `describe("parseBatchResponse")` block, after line 98:

```typescript
  it("parses {description, danger} object values for critical-tier symbols", () => {
    const raw = JSON.stringify({
      "src/a.ts::foo": {
        description: "does foo things",
        danger: "callers depend on return value being non-null",
      },
      "src/a.ts::bar": "does bar things",
    });
    const result = parseBatchResponse(raw);
    expect(result.get("src/a.ts")!.get("foo")).toBe("does foo things");
    expect(result.get("src/a.ts")!.get("bar")).toBe("does bar things");
  });

  it("returns danger zones via second return value", () => {
    const raw = JSON.stringify({
      "src/a.ts::foo": {
        description: "does foo things",
        danger: "callers depend on return value",
      },
      "src/a.ts::bar": "simple description",
    });
    const { descriptions, dangerZones } = parseBatchResponse(raw);
    expect(descriptions.get("src/a.ts")!.get("foo")).toBe("does foo things");
    expect(dangerZones.get("src/a.ts")!.get("foo")).toBe("callers depend on return value");
    expect(dangerZones.get("src/a.ts")?.has("bar")).toBeFalsy();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/extract/deep.test.ts`
Expected: FAIL — `parseBatchResponse` returns `Map` not `{descriptions, dangerZones}`

- [ ] **Step 3: Update parseBatchResponse to handle both formats**

In `src/extract/deep.ts`, replace the `parseBatchResponse` function (lines 734-767):

```typescript
interface BatchParseResult {
  descriptions: Map<string, Map<string, string>>;
  dangerZones: Map<string, Map<string, string>>;
}

function parseBatchResponse(raw: string): BatchParseResult {
  const descriptions = new Map<string, Map<string, string>>();
  const dangerZones = new Map<string, Map<string, string>>();

  // Claude sometimes wraps JSON in ```json ... ``` fences. Strip them.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return { descriptions, dangerZones };
    try {
      obj = JSON.parse(match[0]);
    } catch {
      return { descriptions, dangerZones };
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    const sep = key.indexOf("::");
    if (sep === -1) continue;
    const file = key.slice(0, sep);
    const name = key.slice(sep + 2);

    let desc: string;
    let danger: string | undefined;

    if (typeof value === "string") {
      desc = value.trim();
    } else if (typeof value === "object" && value !== null && "description" in value) {
      desc = String((value as Record<string, unknown>).description).trim();
      const d = (value as Record<string, unknown>).danger;
      if (typeof d === "string" && d.trim()) {
        danger = d.trim();
      }
    } else {
      continue;
    }

    if (!descriptions.has(file)) descriptions.set(file, new Map());
    descriptions.get(file)!.set(name, desc);

    if (danger) {
      if (!dangerZones.has(file)) dangerZones.set(file, new Map());
      dangerZones.get(file)!.set(name, danger);
    }
  }
  return { descriptions, dangerZones };
}
```

- [ ] **Step 4: Update all callers of parseBatchResponse**

In `src/extract/deep.ts`, find the call to `parseBatchResponse` (around line 241). Replace:

```typescript
    const parsed = parseBatchResponse(raw);
    for (const ext of batch) {
      const fileAnnotations = parsed.get(ext.path) || new Map<string, string>();
```

With:

```typescript
    const { descriptions: parsed, dangerZones: batchDangers } = parseBatchResponse(raw);
    for (const ext of batch) {
      const fileAnnotations = parsed.get(ext.path) || new Map<string, string>();
```

(The `batchDangers` variable is used in Task 5 when we wire up the cache.)

- [ ] **Step 5: Update existing tests for new return type**

In `src/extract/deep.test.ts`, update existing `parseBatchResponse` tests to destructure the new return type. Replace every occurrence of:

```typescript
    const result = parseBatchResponse(raw);
    expect(result.get(
```

With:

```typescript
    const { descriptions: result } = parseBatchResponse(raw);
    expect(result.get(
```

And for `result.size` and `result.has()` calls, similarly use `descriptions`:

```typescript
    const { descriptions: result } = parseBatchResponse(raw);
```

This applies to all 6 existing tests in the `parseBatchResponse` describe block.

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/extract/deep.test.ts`
Expected: All tests PASS (existing + new)

- [ ] **Step 7: Commit**

```bash
git add src/extract/deep.ts src/extract/deep.test.ts
git commit -m "feat: parseBatchResponse handles {description, danger} format"
```

---

### Task 5: DeepCacheEntry — store danger zones

**Files:**
- Modify: `src/extract/deep.ts:48-53` (DeepCacheEntry interface)
- Modify: `src/extract/deep.ts:240-263` (batch annotation loop — store dangers in cache)
- Modify: `src/extract/deep.ts:198-214` (cache-hit path — restore dangers)

- [ ] **Step 1: Extend DeepCacheEntry**

In `src/extract/deep.ts`, modify the `DeepCacheEntry` interface (lines 48-53):

```typescript
interface DeepCacheEntry {
  hash: string;
  annotations: Record<string, string>;
  dangerZones?: Record<string, string>;
}
```

- [ ] **Step 2: Add dangerZones to DeepResult**

The `DeepResult` interface (line 29) needs a new field. Add after `annotations`:

```typescript
export interface DeepResult {
  annotations: Map<string, Map<string, string>>;
  dangerZones: Map<string, Map<string, string>>;
  systemOverview: string | null;
  directoryBoundaries: Map<string, string>;
  freshAnnotations: number;
  cachedAnnotations: number;
  ran: boolean;
}
```

- [ ] **Step 3: Initialize dangerZones in runDeepAnalysis**

In `runDeepAnalysis` (around line 131), update the `empty` return value:

```typescript
  const empty: DeepResult = {
    annotations: new Map(),
    dangerZones: new Map(),
    systemOverview: null,
    directoryBoundaries: new Map(),
    freshAnnotations: 0,
    cachedAnnotations: 0,
    ran: false,
  };
```

And initialize a local accumulator after `annotations` (around line 147):

```typescript
  const annotations = new Map<string, Map<string, string>>();
  const allDangerZones = new Map<string, Map<string, string>>();
```

- [ ] **Step 4: Restore danger zones from cache hits**

In the cache-hit loop (around lines 204-211), add danger zone restoration:

```typescript
    if (cached && cached.hash === hash) {
      const map = new Map<string, string>();
      for (const [name, desc] of Object.entries(cached.annotations)) {
        map.set(name, desc);
        cachedAnnotations++;
      }
      annotations.set(ext.path, map);
      // Restore cached danger zones
      if (cached.dangerZones) {
        const dangerMap = new Map<string, string>();
        for (const [name, danger] of Object.entries(cached.dangerZones)) {
          dangerMap.set(name, danger);
        }
        allDangerZones.set(ext.path, dangerMap);
      }
    } else {
```

- [ ] **Step 5: Store danger zones from fresh annotations**

In the batch annotation loop (around lines 241-263), after the existing annotation merge logic, add danger zone handling. After the `batchDangers` variable from Task 4, add inside the `for (const ext of batch)` loop:

```typescript
      // Store danger zones
      const fileDangers = batchDangers.get(ext.path);
      if (fileDangers && fileDangers.size > 0) {
        const existingDangers = allDangerZones.get(ext.path) || new Map();
        for (const [name, danger] of fileDangers) {
          existingDangers.set(name, danger);
        }
        allDangerZones.set(ext.path, existingDangers);

        // Update cache entry with dangers
        if (cache.files[ext.path]) {
          cache.files[ext.path].dangerZones = Object.fromEntries(existingDangers);
        }
      }
```

- [ ] **Step 6: Include dangerZones in return value**

In the return statement (around line 309), add `dangerZones: allDangerZones`:

```typescript
  return {
    annotations,
    dangerZones: allDangerZones,
    systemOverview,
    directoryBoundaries,
    freshAnnotations,
    cachedAnnotations,
    ran: true,
  };
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run`
Expected: All tests PASS. Existing code that destructures `DeepResult` (init.ts, etc.) doesn't use `dangerZones` yet, so no breakage.

- [ ] **Step 8: Commit**

```bash
git add src/extract/deep.ts
git commit -m "feat: store danger zones in deep cache and DeepResult"
```

---

### Task 6: buildBatchPrompt — caller context + test assertions

**Files:**
- Modify: `src/extract/deep.ts:613-669` (buildBatchPrompt)
- Modify: `src/extract/deep.ts:124-130` (runDeepAnalysis signature — thread testMappings + depGraph into prompt builder)

- [ ] **Step 1: Build a caller-context helper**

Add before `buildBatchPrompt` in `src/extract/deep.ts` (around line 610):

```typescript
/**
 * Extract call-site context for a symbol: the 3 lines surrounding each
 * usage in importer files (1 before, the call, 1 after). Returns top 3.
 */
function getCallerContext(
  symbolName: string,
  filePath: string,
  depGraph: DepGraph,
  root: string,
): string[] {
  const key = `${filePath}#${symbolName}`;
  const importers = depGraph.symbolRefs?.get(key);
  if (!importers || importers.length === 0) return [];

  const contexts: string[] = [];
  for (const importerPath of importers.slice(0, 3)) {
    const content = safeRead(join(root, importerPath));
    if (!content) continue;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && contexts.length < 3; i++) {
      if (lines[i].includes(symbolName) && !lines[i].match(/^import\s/)) {
        const before = i > 0 ? lines[i - 1].trim() : "";
        const call = lines[i].trim();
        const after = i < lines.length - 1 ? lines[i + 1].trim() : "";
        const fname = importerPath.split("/").pop() || importerPath;
        contexts.push(`  ${fname}:${i + 1}: ${before ? before + " → " : ""}${call}${after ? " → " + after : ""}`);
        break; // one context per importer file
      }
    }
  }
  return contexts;
}
```

- [ ] **Step 2: Modify buildBatchPrompt signature to accept new data**

Change the `buildBatchPrompt` function signature (line 613) to accept extra parameters:

```typescript
function buildBatchPrompt(
  batch: FileExtraction[],
  root: string,
  scoreMap?: Map<string, number>,
  criticalCutoff?: number,
  peripheralCutoff?: number,
  depGraph?: DepGraph,
  testMappings?: TestMapping[],
): string | null {
```

- [ ] **Step 3: Build a test assertion lookup inside buildBatchPrompt**

At the top of `buildBatchPrompt`, after the `const sections` line, add:

```typescript
  // Build test assertion lookup: sourceFile → Map<testName, assertions[]>
  const testAssertionsByFile = new Map<string, Map<string, string[]>>();
  if (testMappings) {
    for (const tm of testMappings) {
      if (tm.assertions && tm.assertions.size > 0) {
        testAssertionsByFile.set(tm.sourceFile, tm.assertions);
      }
    }
  }
```

- [ ] **Step 4: Add caller + test context for critical-tier sections**

In the `for (const ext of batch)` loop inside `buildBatchPrompt`, after the `depthHint` assignment and before the `sections.push(...)` call, add context for critical-tier files:

```typescript
    let extraContext = "";
    if (criticalCutoff !== undefined && score >= criticalCutoff && depGraph) {
      // Caller context for each symbol
      const callerLines: string[] = [];
      for (const s of needsDesc) {
        const ctx = getCallerContext(s.name, ext.path, depGraph, root);
        if (ctx.length > 0) {
          callerLines.push(`CALLERS of ${s.name}:`);
          callerLines.push(...ctx);
        }
      }
      // Test assertion context
      const testAssertions = testAssertionsByFile.get(ext.path);
      if (testAssertions && testAssertions.size > 0) {
        callerLines.push("");
        for (const [testName, assertions] of [...testAssertions.entries()].slice(0, 5)) {
          callerLines.push(`TEST "${testName}":`);
          for (const a of assertions.slice(0, 3)) {
            callerLines.push(`  ${a}`);
          }
        }
      }
      if (callerLines.length > 0) {
        extraContext = "\n" + callerLines.join("\n");
      }
    }

    sections.push(
      `FILE: ${ext.path} ${depthHint}\nSYMBOLS: ${needsDesc.map((s) => s.name).join(", ")}\nCODE:\n${relevant}${extraContext}`,
    );
```

Replace the existing `sections.push(...)` line with the one above (which appends `extraContext`).

- [ ] **Step 5: Update the prompt template for critical-tier danger fields**

In the return statement of `buildBatchPrompt` (around line 654), update the prompt text:

```typescript
  return `Analyze these source files. For each listed symbol, write ONE behavioral description matching its file's DEPTH hint.

DEPTH:thorough — up to 22 words. Include: what it does, side effects (DB writes/events/mutations), failure modes, required state.
  If CALLERS and TEST sections are provided, also produce a "danger" field (max 30 words): what callers depend on, what invariants tests check, what breaks if this function's behavior changes.
  Good: {"description": "creates draft invoice, validates project active, emits InvoiceCreated, throws if quota exceeded", "danger": "billing handler depends on InvoiceCreated event shape; test asserts non-null id"}
DEPTH:normal — up to 13 words. Include: what it does and key behaviors.
  Good: "hashes password with bcrypt 12 rounds, throws on empty input"
DEPTH:brief — up to 7 words. Terse one-liner only.
  Good: "formats currency with locale rounding"
Bad (any tier): "handles invoice logic" / "main service function" (too vague)

For DEPTH:thorough with CALLERS/TEST context, respond with an object {"description": "...", "danger": "..."}. For all other tiers, respond with a plain string.

Respond with a JSON object mapping "filepath::symbolName" to the description (string or object). No prose, no markdown, just the JSON object on a single line or pretty-printed. Example:

{"src/foo.ts::createInvoice": {"description": "creates draft invoice, validates project active, emits InvoiceCreated", "danger": "billing handler depends on event shape"}, "src/util.ts::hash": "hashes with bcrypt 12 rounds"}

${sections.join("\n---\n")}`;
```

- [ ] **Step 6: Thread depGraph and testMappings through to buildBatchPrompt**

In `runDeepAnalysis`, find the call to `buildBatchPrompt` (around line 228):

Replace:
```typescript
    const prompt = buildBatchPrompt(batch, root, scoreMap, criticalCutoff, peripheralCutoff);
```

With:
```typescript
    const prompt = buildBatchPrompt(batch, root, scoreMap, criticalCutoff, peripheralCutoff, depGraph, testMappings);
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/extract/deep.ts
git commit -m "feat: buildBatchPrompt injects caller + test context for critical-tier files"
```

---

### Task 7: buildDeepRules — emit danger zones and assertion lines

**Files:**
- Modify: `src/extract/deep.ts:327-456` (buildDeepRules)
- Modify: `src/extract/deep.test.ts` (add test)

- [ ] **Step 1: Write a test for danger zone output in rules**

Add to `src/extract/deep.test.ts`:

```typescript
describe("buildDeepRules", () => {
  it("includes danger zone lines for symbols with danger annotations", () => {
    const ext = makeExt("src/auth/session.ts", [
      makeSym("createSession", 10, { exported: true, calls: ["validate"] }),
    ]);
    const annotations = new Map([
      ["src/auth/session.ts", new Map([["createSession", "creates user session with JWT"]])],
    ]);
    const dangerZones = new Map([
      ["src/auth/session.ts", new Map([["createSession", "middleware depends on JWT shape; test asserts expiry"]])],
    ]);
    const rules = buildDeepRules([ext], annotations, new Map(), [], undefined, dangerZones);
    const ruleContent = [...rules.values()].find(v => v.includes("session.ts"));
    expect(ruleContent).toBeDefined();
    expect(ruleContent).toContain("DANGER:");
    expect(ruleContent).toContain("middleware depends on JWT shape");
  });

  it("omits danger line when no danger annotation exists", () => {
    const ext = makeExt("src/utils/hash.ts", [
      makeSym("hashPassword", 5, { exported: true }),
    ]);
    const annotations = new Map([
      ["src/utils/hash.ts", new Map([["hashPassword", "hashes with bcrypt"]])],
    ]);
    const rules = buildDeepRules([ext], annotations, new Map(), [], undefined, new Map());
    const ruleContent = [...rules.values()].find(v => v.includes("hash.ts"));
    expect(ruleContent).toBeDefined();
    expect(ruleContent).not.toContain("DANGER:");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/extract/deep.test.ts`
Expected: FAIL — `buildDeepRules` doesn't accept `dangerZones` parameter

- [ ] **Step 3: Add dangerZones parameter to buildDeepRules**

Modify the `buildDeepRules` signature (line 327):

```typescript
export function buildDeepRules(
  extractions: FileExtraction[],
  annotations: Map<string, Map<string, string>>,
  directoryBoundaries: Map<string, string> = new Map(),
  testMappings: TestMapping[] = [],
  depGraph?: DepGraph,
  dangerZones: Map<string, Map<string, string>> = new Map(),
): Map<string, string> {
```

- [ ] **Step 4: Add danger field to FileEntry symbols**

In the `FileEntry` type inside `buildDeepRules` (around line 353), add `danger`:

```typescript
  type FileEntry = {
    file: string;
    symbols: Array<{
      name: string;
      sig: string;
      desc: string;
      danger?: string;
      calls?: string[];
      throws?: string[];
      callers?: string[];
    }>;
  };
```

- [ ] **Step 5: Populate danger from dangerZones map**

In the loop that builds `syms` (around line 373), add danger zone lookup after the `desc` assignment:

```typescript
      const desc = fileAnns.get(sym.name);
      if (desc) {
        const callerKey = `${ext.path}#${sym.name}`;
        const callers = callersBySymbol.get(callerKey);
        const danger = dangerZones.get(ext.path)?.get(sym.name);
        syms.push({
          name: sym.name,
          sig: sym.signature,
          desc,
          danger,
          calls: sym.calls?.slice(0, 5),
          throws: sym.throws?.slice(0, 5),
          callers: callers?.map(c => c.split("/").pop() || c),
        });
      }
```

- [ ] **Step 6: Emit danger line in rules output**

In the rule formatting loop (around line 415), after the `callers` line and before the test names, add:

```typescript
        if (sym.danger) {
          lines.push(`  - \u26A0 DANGER: ${sym.danger}`);
        }
```

- [ ] **Step 7: Add test assertion summaries under test names**

In the same formatting loop, after the existing test names line (around line 427-429), add assertion output. First build a test assertions lookup at the top of `buildDeepRules` (after `testNamesByFile`):

```typescript
  // Map source file path → Map<testName, assertion lines>
  const testAssertionsByFile = new Map<string, Map<string, string[]>>();
  for (const tm of testMappings) {
    if (tm.assertions && tm.assertions.size > 0) {
      testAssertionsByFile.set(tm.sourceFile, tm.assertions);
    }
  }
```

Then after the test names line:

```typescript
      const testNames = testNamesByFile.get(entry.file);
      if (testNames && testNames.length > 0) {
        lines.push(`- Tests: ${testNames.map(n => `"${n}"`).join(", ")}`);
        // Add assertion summaries
        const fileAssertions = testAssertionsByFile.get(entry.file);
        if (fileAssertions) {
          const assertionSummary: string[] = [];
          for (const tName of testNames.slice(0, 3)) {
            const asserts = fileAssertions.get(tName);
            if (asserts && asserts.length > 0) {
              assertionSummary.push(...asserts.slice(0, 2));
            }
          }
          if (assertionSummary.length > 0) {
            lines.push(`  - expects: ${assertionSummary.join("; ")}`);
          }
        }
      }
```

- [ ] **Step 8: Update the caller in init.ts to pass dangerZones**

In `src/commands/init.ts`, find the `buildDeepRules` call (line 70):

Replace:
```typescript
      deepRules = buildDeepRules(result.extractions, deepResult.annotations, deepResult.directoryBoundaries, result.testMappings, result.depGraph);
```

With:
```typescript
      deepRules = buildDeepRules(result.extractions, deepResult.annotations, deepResult.directoryBoundaries, result.testMappings, result.depGraph, deepResult.dangerZones);
```

- [ ] **Step 9: Run tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 10: Commit**

```bash
git add src/extract/deep.ts src/extract/deep.test.ts src/commands/init.ts
git commit -m "feat: buildDeepRules emits danger zones and test assertion summaries"
```

---

### Task 8: MCP test-map tool — include assertions

**Files:**
- Modify: `src/mcp/test-map.ts:16,38`

- [ ] **Step 1: Update the type to include assertions**

In `src/mcp/test-map.ts`, modify the type on line 16:

```typescript
  let map: Record<string, { test: string; count: number; names: string[]; assertions?: Record<string, string[]> }>;
```

- [ ] **Step 2: Include assertions in single-file output**

In `src/mcp/test-map.ts`, modify the single-file response (around line 38):

Replace:
```typescript
    const names = entry.names.length ? `\n\nTest names:\n${entry.names.map((n) => `- ${n}`).join("\n")}` : "";
```

With:
```typescript
    let names = entry.names.length ? `\n\nTest names:\n${entry.names.map((n) => `- ${n}`).join("\n")}` : "";
    if (entry.assertions && Object.keys(entry.assertions).length > 0) {
      names += "\n\nAssertions:";
      for (const [testName, asserts] of Object.entries(entry.assertions).slice(0, 5)) {
        names += `\n- "${testName}":`;
        for (const a of asserts.slice(0, 3)) {
          names += `\n  ${a}`;
        }
      }
    }
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/mcp/test-map.ts
git commit -m "feat: briefed_test_map MCP tool surfaces assertion lines"
```

---

### Task 9: UserPromptSubmit hook — assertion lines in test injection

**Files:**
- Modify: `src/deliver/hooks.ts:349-365` (test injection block in promptSubmitScript)

- [ ] **Step 1: Update the test injection block**

In `src/deliver/hooks.ts`, find the test injection block inside the `promptSubmitScript` template string (around line 349). Replace:

```javascript
      if (includeTests && safeExists(testMapPath) && used < budget) {
        try {
          const testMap = JSON.parse(safeRead(testMapPath) || "{}");
          for (const file of mod.files || []) {
            const testInfo = testMap[file];
            if (testInfo && used < budget) {
              const testLine = "# Tests for " + file + ": " + testInfo.test + " (" + testInfo.count + " tests)\\n" +
                (testInfo.names || []).slice(0, 5).map((n) => "  - " + n).join("\\n");
              if (used + testLine.length <= budget) {
                output.push(testLine);
                used += testLine.length;
              }
            }
          }
        } catch {}
      }
```

With:

```javascript
      if (includeTests && safeExists(testMapPath) && used < budget) {
        try {
          const testMap = JSON.parse(safeRead(testMapPath) || "{}");
          for (const file of mod.files || []) {
            const testInfo = testMap[file];
            if (testInfo && used < budget) {
              const lines = ["# Tests for " + file + ": " + testInfo.test + " (" + testInfo.count + " tests)"];
              for (const n of (testInfo.names || []).slice(0, 5)) {
                lines.push("  - " + n);
                const asserts = testInfo.assertions && testInfo.assertions[n];
                if (asserts) {
                  for (const a of asserts.slice(0, 2)) {
                    lines.push("    " + a);
                  }
                }
              }
              const testLine = lines.join("\\n");
              if (used + testLine.length <= budget) {
                output.push(testLine);
                used += testLine.length;
              }
            }
          }
        } catch {}
      }
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/deliver/hooks.ts
git commit -m "feat: UserPromptSubmit hook includes test assertion lines"
```

---

### Task 10: Integration verification

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: Clean compile, no errors

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 4: Smoke test on briefed's own repo**

```bash
node dist/cli.js init --deep --repo .
```

Expected:
- Deep rules contain `⚠ DANGER:` lines for some critical-tier symbols
- `test-map.json` contains `assertions` field with extracted assertion lines
- `cat .claude/rules/briefed-deep-*.md | grep "DANGER"` returns results

- [ ] **Step 5: Verify test-map.json has assertions**

```bash
node -e "const m = require('./.briefed/test-map.json'); const first = Object.entries(m).find(([,v]) => v.assertions && Object.keys(v.assertions).length > 0); console.log(first ? first[0] + ': ' + JSON.stringify(first[1].assertions).slice(0,200) : 'NO ASSERTIONS FOUND')"
```

Expected: At least one file has populated assertion data

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "chore: integration verification pass"
```
