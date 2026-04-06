import { describe, it, expect } from "vitest";
import { detectCycles, formatCycles } from "./cycles.js";
import { buildDepGraph } from "./depgraph.js";
import type { FileExtraction } from "./signatures.js";

function makeExt(
  path: string,
  imports: Array<{ source: string; isRelative: boolean; isTypeOnly?: boolean }>
): FileExtraction {
  return {
    path,
    symbols: [],
    imports: imports.map((imp) => ({
      source: imp.source,
      names: ["default"],
      isRelative: imp.isRelative,
      isTypeOnly: imp.isTypeOnly,
    })),
    lineCount: 10,
  };
}

describe("detectCycles", () => {
  it("returns empty for an acyclic graph", () => {
    const graph = buildDepGraph(
      [
        makeExt("a.ts", [{ source: "./b", isRelative: true }]),
        makeExt("b.ts", [{ source: "./c", isRelative: true }]),
        makeExt("c.ts", []),
      ],
      "/project"
    );
    expect(detectCycles(graph)).toEqual([]);
  });

  it("detects a 2-node runtime cycle", () => {
    const graph = buildDepGraph(
      [
        makeExt("a.ts", [{ source: "./b", isRelative: true }]),
        makeExt("b.ts", [{ source: "./a", isRelative: true }]),
      ],
      "/project"
    );
    const cycles = detectCycles(graph);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual(["a.ts", "b.ts"]);
  });

  it("detects a 3-node runtime cycle", () => {
    const graph = buildDepGraph(
      [
        makeExt("a.ts", [{ source: "./b", isRelative: true }]),
        makeExt("b.ts", [{ source: "./c", isRelative: true }]),
        makeExt("c.ts", [{ source: "./a", isRelative: true }]),
      ],
      "/project"
    );
    const cycles = detectCycles(graph);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(3);
    // Rotation-canonicalized to start at the smallest member
    expect(cycles[0][0]).toBe("a.ts");
  });

  it("ignores type-only edges", () => {
    // a → b is type-only, b → a is runtime. Not a runtime cycle.
    const graph = buildDepGraph(
      [
        makeExt("a.ts", [{ source: "./b", isRelative: true, isTypeOnly: true }]),
        makeExt("b.ts", [{ source: "./a", isRelative: true }]),
      ],
      "/project"
    );
    expect(detectCycles(graph)).toEqual([]);
  });

  it("treats mixed type+runtime imports as runtime", () => {
    // Two import statements between a and b: one type-only, one runtime.
    // Combined with a runtime b → a, this IS a real cycle.
    const graph = buildDepGraph(
      [
        makeExt("a.ts", [
          { source: "./b", isRelative: true, isTypeOnly: true },
          { source: "./b", isRelative: true, isTypeOnly: false },
        ]),
        makeExt("b.ts", [{ source: "./a", isRelative: true }]),
      ],
      "/project"
    );
    const cycles = detectCycles(graph);
    expect(cycles).toHaveLength(1);
  });

  it("deduplicates equivalent cycles under rotation", () => {
    // a → b → c → a, discovered from any starting node, should produce one cycle.
    const graph = buildDepGraph(
      [
        makeExt("a.ts", [{ source: "./b", isRelative: true }]),
        makeExt("b.ts", [{ source: "./c", isRelative: true }]),
        makeExt("c.ts", [{ source: "./a", isRelative: true }]),
      ],
      "/project"
    );
    expect(detectCycles(graph)).toHaveLength(1);
  });
});

describe("formatCycles", () => {
  it("returns empty string when there are no cycles", () => {
    expect(formatCycles([])).toBe("");
  });

  it("formats cycles with arrow notation and a header", () => {
    const out = formatCycles([["a.ts", "b.ts"]]);
    expect(out).toContain("Import cycles: 1 detected");
    expect(out).toContain("a.ts → b.ts → a.ts");
  });

  it("truncates after 8 cycles", () => {
    const many = Array.from({ length: 12 }, (_, i) => [`a${i}.ts`, `b${i}.ts`]);
    const out = formatCycles(many);
    expect(out).toContain("12 detected");
    expect(out).toContain("... and 4 more");
  });
});
