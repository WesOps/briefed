import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { computeComplexity } from "./complexity.js";
import type { FileExtraction } from "./signatures.js";
import type { DepGraph } from "./depgraph.js";

function makeDepGraph(
  inEdges: string[] = [],
  filePath: string = ""
): DepGraph {
  const nodes = new Map();
  nodes.set(filePath, {
    id: filePath,
    outEdges: [],
    inEdges,
  });
  return {
    nodes,
    pageRank: new Map(),
    refCounts: new Map(),
    symbolRefs: new Map(),
  };
}

describe("computeComplexity", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "briefed-test-complexity-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a score between 0 and 10", () => {
    const filePath = join(tmpDir, "simple.ts");
    writeFileSync(filePath, `export function add(a: number, b: number) { return a + b; }\n`);
    const extraction: FileExtraction = {
      path: filePath,
      symbols: [{ name: "add", kind: "function", signature: "add(a, b)", description: null, exported: true, line: 1 }],
      imports: [],
      lineCount: 1,
    };
    const result = computeComplexity(extraction, makeDepGraph([], filePath));
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(10);
  });

  it("scores higher for files with many branches", () => {
    const simplePath = join(tmpDir, "simple.ts");
    writeFileSync(simplePath, `const x = 1;\n`);

    const complexPath = join(tmpDir, "complex.ts");
    const branchyCode = Array(20)
      .fill(`if (x) { y(); } else if (z) { w(); }`)
      .join("\n");
    writeFileSync(complexPath, branchyCode);

    const simpleExtraction: FileExtraction = {
      path: simplePath,
      symbols: [],
      imports: [],
      lineCount: 1,
    };
    const complexExtraction: FileExtraction = {
      path: complexPath,
      symbols: [],
      imports: [],
      lineCount: 20,
    };

    const simpleScore = computeComplexity(simpleExtraction, makeDepGraph([], simplePath));
    const complexScore = computeComplexity(complexExtraction, makeDepGraph([], complexPath));

    expect(complexScore.score).toBeGreaterThan(simpleScore.score);
    expect(complexScore.branchCount).toBeGreaterThan(simpleScore.branchCount);
  });

  it("scores higher for files with more fan-in", () => {
    const filePath = join(tmpDir, "popular.ts");
    writeFileSync(filePath, `export const shared = 1;\n`);

    const extraction: FileExtraction = {
      path: filePath,
      symbols: [],
      imports: [],
      lineCount: 1,
    };

    const lowFanIn = computeComplexity(extraction, makeDepGraph([], filePath));
    const highFanIn = computeComplexity(
      extraction,
      makeDepGraph(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"], filePath)
    );

    expect(highFanIn.score).toBeGreaterThan(lowFanIn.score);
    expect(highFanIn.fanIn).toBe(6);
    expect(lowFanIn.fanIn).toBe(0);
  });

  it("scores higher for files with more relative imports (fan-out)", () => {
    const filePath = join(tmpDir, "importer.ts");
    writeFileSync(filePath, `const x = 1;\n`);

    const lowFanOut: FileExtraction = {
      path: filePath,
      symbols: [],
      imports: [],
      lineCount: 1,
    };
    const highFanOut: FileExtraction = {
      path: filePath,
      symbols: [],
      imports: Array(10).fill(null).map((_, i) => ({
        source: `./mod${i}.js`,
        names: ["default"],
        isRelative: true,
      })),
      lineCount: 1,
    };

    const low = computeComplexity(lowFanOut, makeDepGraph([], filePath));
    const high = computeComplexity(highFanOut, makeDepGraph([], filePath));
    expect(high.score).toBeGreaterThan(low.score);
    expect(high.fanOut).toBe(10);
  });

  it("includes correct metadata in the result", () => {
    const filePath = join(tmpDir, "meta.ts");
    writeFileSync(filePath, `if (x) { y(); }\nswitch (a) { case 1: break; }\n`);

    const extraction: FileExtraction = {
      path: filePath,
      symbols: [
        { name: "a", kind: "variable", signature: "a", description: null, exported: true, line: 1 },
        { name: "b", kind: "variable", signature: "b", description: null, exported: true, line: 2 },
      ],
      imports: [{ source: "./x.js", names: ["x"], isRelative: true }],
      lineCount: 2,
    };

    const result = computeComplexity(extraction, makeDepGraph([], filePath));
    expect(result.file).toBe(filePath);
    expect(result.lineCount).toBe(2);
    expect(result.symbolCount).toBe(2);
    expect(result.fanOut).toBe(1);
    expect(result.branchCount).toBeGreaterThan(0);
  });

  it("does not count external imports in fanOut", () => {
    const filePath = join(tmpDir, "ext.ts");
    writeFileSync(filePath, `const x = 1;\n`);
    const extraction: FileExtraction = {
      path: filePath,
      symbols: [],
      imports: [
        { source: "react", names: ["React"], isRelative: false },
        { source: "fs", names: ["readFile"], isRelative: false },
        { source: "./local.js", names: ["local"], isRelative: true },
      ],
      lineCount: 1,
    };
    const result = computeComplexity(extraction, makeDepGraph([], filePath));
    expect(result.fanOut).toBe(1); // only the relative import
  });
});
