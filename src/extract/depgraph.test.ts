import { describe, it, expect } from "vitest";
import { buildDepGraph } from "./depgraph.js";
import type { FileExtraction } from "./signatures.js";

function makeExtraction(path: string, imports: Array<{ source: string; isRelative: boolean }>): FileExtraction {
  return {
    path,
    symbols: [],
    imports: imports.map((imp) => ({
      source: imp.source,
      names: ["default"],
      isRelative: imp.isRelative,
    })),
    lineCount: 10,
  };
}

describe("buildDepGraph", () => {
  it("builds nodes for all extractions", () => {
    const extractions = [
      makeExtraction("src/a.ts", []),
      makeExtraction("src/b.ts", []),
      makeExtraction("src/c.ts", []),
    ];
    const graph = buildDepGraph(extractions, "/project");
    expect(graph.nodes.size).toBe(3);
    expect(graph.nodes.has("src/a.ts")).toBe(true);
    expect(graph.nodes.has("src/b.ts")).toBe(true);
    expect(graph.nodes.has("src/c.ts")).toBe(true);
  });

  it("resolves relative imports to create edges", () => {
    const extractions = [
      makeExtraction("src/a.ts", [{ source: "./b", isRelative: true }]),
      makeExtraction("src/b.ts", []),
    ];
    const graph = buildDepGraph(extractions, "/project");
    const nodeA = graph.nodes.get("src/a.ts")!;
    const nodeB = graph.nodes.get("src/b.ts")!;
    expect(nodeA.outEdges).toContain("src/b.ts");
    expect(nodeB.inEdges).toContain("src/a.ts");
  });

  it("ignores external (non-relative) imports", () => {
    const extractions = [
      makeExtraction("src/a.ts", [{ source: "react", isRelative: false }]),
    ];
    const graph = buildDepGraph(extractions, "/project");
    const nodeA = graph.nodes.get("src/a.ts")!;
    expect(nodeA.outEdges).toHaveLength(0);
  });

  it("computes pageRank scores", () => {
    const extractions = [
      makeExtraction("src/a.ts", [{ source: "./b", isRelative: true }]),
      makeExtraction("src/b.ts", []),
    ];
    const graph = buildDepGraph(extractions, "/project");
    expect(graph.pageRank.size).toBe(2);
    // b should have higher rank since a depends on it
    expect(graph.pageRank.get("src/b.ts")!).toBeGreaterThan(graph.pageRank.get("src/a.ts")!);
  });

  it("computes refCounts (in-degree)", () => {
    const extractions = [
      makeExtraction("src/a.ts", [{ source: "./c", isRelative: true }]),
      makeExtraction("src/b.ts", [{ source: "./c", isRelative: true }]),
      makeExtraction("src/c.ts", []),
    ];
    const graph = buildDepGraph(extractions, "/project");
    expect(graph.refCounts.get("src/c.ts")).toBe(2);
    expect(graph.refCounts.get("src/a.ts")).toBe(0);
    expect(graph.refCounts.get("src/b.ts")).toBe(0);
  });

  it("handles empty extractions", () => {
    const graph = buildDepGraph([], "/project");
    expect(graph.nodes.size).toBe(0);
    expect(graph.pageRank.size).toBe(0);
    expect(graph.refCounts.size).toBe(0);
  });

  it("does not create duplicate edges", () => {
    const extractions = [
      makeExtraction("src/a.ts", [
        { source: "./b", isRelative: true },
        { source: "./b", isRelative: true },
      ]),
      makeExtraction("src/b.ts", []),
    ];
    const graph = buildDepGraph(extractions, "/project");
    const nodeA = graph.nodes.get("src/a.ts")!;
    const nodeB = graph.nodes.get("src/b.ts")!;
    expect(nodeA.outEdges.filter((e) => e === "src/b.ts")).toHaveLength(1);
    expect(nodeB.inEdges.filter((e) => e === "src/a.ts")).toHaveLength(1);
  });

  it("handles unresolvable imports gracefully", () => {
    const extractions = [
      makeExtraction("src/a.ts", [{ source: "./nonexistent.js", isRelative: true }]),
    ];
    const graph = buildDepGraph(extractions, "/project");
    const nodeA = graph.nodes.get("src/a.ts")!;
    expect(nodeA.outEdges).toHaveLength(0);
  });
});
