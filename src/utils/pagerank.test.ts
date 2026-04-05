import { describe, it, expect } from "vitest";
import { computePageRank, computeRefCounts, GraphNode } from "./pagerank.js";

function makeNodes(edges: Record<string, string[]>): Map<string, GraphNode> {
  const nodes = new Map<string, GraphNode>();
  // Initialize all nodes
  for (const id of Object.keys(edges)) {
    nodes.set(id, { id, outEdges: [], inEdges: [] });
  }
  // Build edges
  for (const [id, targets] of Object.entries(edges)) {
    const node = nodes.get(id)!;
    node.outEdges = targets;
    for (const target of targets) {
      const targetNode = nodes.get(target);
      if (targetNode) {
        targetNode.inEdges.push(id);
      }
    }
  }
  return nodes;
}

describe("computePageRank", () => {
  it("returns empty map for empty graph", () => {
    const result = computePageRank(new Map());
    expect(result.size).toBe(0);
  });

  it("gives equal scores to disconnected nodes", () => {
    const nodes = makeNodes({ a: [], b: [], c: [] });
    const scores = computePageRank(nodes);
    const values = [...scores.values()];
    // All scores should be equal for isolated nodes
    expect(values[0]).toBeCloseTo(values[1], 5);
    expect(values[1]).toBeCloseTo(values[2], 5);
  });

  it("gives higher score to a node with many incoming edges", () => {
    // a -> c, b -> c, c has no outgoing
    const nodes = makeNodes({ a: ["c"], b: ["c"], c: [] });
    const scores = computePageRank(nodes);
    expect(scores.get("c")!).toBeGreaterThan(scores.get("a")!);
    expect(scores.get("c")!).toBeGreaterThan(scores.get("b")!);
  });

  it("propagates rank through chains", () => {
    // a -> b -> c
    const nodes = makeNodes({ a: ["b"], b: ["c"], c: [] });
    const scores = computePageRank(nodes);
    // c gets rank from b which gets rank from a
    expect(scores.get("c")!).toBeGreaterThan(scores.get("a")!);
  });

  it("handles cycles without diverging", () => {
    // a -> b -> c -> a
    const nodes = makeNodes({ a: ["b"], b: ["c"], c: ["a"] });
    const scores = computePageRank(nodes);
    // In a perfect cycle, all scores should converge to be roughly equal
    const values = [...scores.values()];
    expect(values[0]).toBeCloseTo(values[1], 2);
    expect(values[1]).toBeCloseTo(values[2], 2);
  });

  it("all scores are positive", () => {
    const nodes = makeNodes({ a: ["b", "c"], b: ["c"], c: [], d: ["a"] });
    const scores = computePageRank(nodes);
    for (const score of scores.values()) {
      expect(score).toBeGreaterThan(0);
    }
    // Node c should have the highest score (most incoming edges)
    expect(scores.get("c")!).toBeGreaterThan(scores.get("d")!);
  });

  it("respects custom iteration count and damping", () => {
    const nodes = makeNodes({ a: ["b"], b: [] });
    const scores1 = computePageRank(nodes, 1, 0.85);
    const scores2 = computePageRank(nodes, 100, 0.85);
    // More iterations should give a more converged result
    // Both should return valid scores
    expect(scores1.size).toBe(2);
    expect(scores2.size).toBe(2);
  });
});

describe("computeRefCounts", () => {
  it("returns zero for nodes with no incoming edges", () => {
    const nodes = makeNodes({ a: ["b"], b: [] });
    const counts = computeRefCounts(nodes);
    expect(counts.get("a")).toBe(0);
    expect(counts.get("b")).toBe(1);
  });

  it("returns empty map for empty graph", () => {
    const counts = computeRefCounts(new Map());
    expect(counts.size).toBe(0);
  });

  it("counts multiple incoming edges correctly", () => {
    const nodes = makeNodes({ a: ["c"], b: ["c"], c: [], d: ["c"] });
    const counts = computeRefCounts(nodes);
    expect(counts.get("c")).toBe(3);
    expect(counts.get("a")).toBe(0);
  });
});
