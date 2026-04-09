/**
 * Simple PageRank implementation for dependency graph ranking.
 * Identifies which files are most central to the codebase.
 */

export interface GraphNode {
  id: string;
  outEdges: string[]; // files this node imports
  inEdges: string[];  // files that import this node
  /** Edge weights: target file → number of symbols imported (higher = stronger coupling) */
  edgeWeights?: Map<string, number>;
  /** Subset of outEdges where at least one import is runtime (non-type-only). */
  runtimeOutEdges?: Set<string>;
}

/**
 * Compute PageRank scores for a file dependency graph.
 * Returns map of file path → score (higher = more central).
 *
 * Fixes dangling-node mass leak: nodes with no outEdges redistribute
 * their score uniformly rather than dropping it.
 */
export function computePageRank(
  nodes: Map<string, GraphNode>,
  iterations: number = 20,
  damping: number = 0.85
): Map<string, number> {
  return _pageRankCore(nodes, null, iterations, damping);
}

/**
 * Personalized PageRank seeded from a set of entry-point nodes.
 * Instead of teleporting uniformly, the random surfer teleports to
 * seed nodes weighted by their provided scores. This concentrates rank
 * on files reachable from routes, CLI entrypoints, and public API roots —
 * the files that matter most to users of the codebase.
 *
 * @param seeds  map of file path → seed weight (need not sum to 1; normalized internally)
 */
export function computePersonalizedPageRank(
  nodes: Map<string, GraphNode>,
  seeds: Map<string, number>,
  iterations: number = 20,
  damping: number = 0.85
): Map<string, number> {
  return _pageRankCore(nodes, seeds, iterations, damping);
}

function _pageRankCore(
  nodes: Map<string, GraphNode>,
  seeds: Map<string, number> | null,
  iterations: number,
  damping: number,
): Map<string, number> {
  const n = nodes.size;
  if (n === 0) return new Map();

  // Build normalized teleport distribution
  const teleport = new Map<string, number>();
  if (seeds && seeds.size > 0) {
    const total = [...seeds.values()].reduce((s, v) => s + v, 0);
    if (total > 0) {
      for (const [k, v] of seeds) teleport.set(k, v / total);
    }
  }
  const uniformTeleport = teleport.size === 0 ? 1 / n : 0;

  // Initialize scores
  const scores = new Map<string, number>();
  for (const id of nodes.keys()) {
    scores.set(id, teleport.get(id) ?? uniformTeleport);
  }

  // Identify dangling nodes (no outEdges — mass would be lost without redistribution)
  const danglingIds = new Set<string>();
  for (const [id, node] of nodes) {
    if (node.outEdges.length === 0) danglingIds.add(id);
  }

  for (let i = 0; i < iterations; i++) {
    const newScores = new Map<string, number>();

    // Collect dangling mass and redistribute via teleport distribution
    let danglingMass = 0;
    for (const id of danglingIds) danglingMass += scores.get(id) || 0;
    const danglingRedist = damping * danglingMass;

    for (const [id, node] of nodes) {
      const tp = teleport.get(id) ?? uniformTeleport;
      let incoming = 0;

      for (const sourceId of node.inEdges) {
        const sourceNode = nodes.get(sourceId);
        if (!sourceNode || sourceNode.outEdges.length === 0) continue;
        const sourceScore = scores.get(sourceId) || 0;
        const weights = sourceNode.edgeWeights;
        if (weights && weights.size > 0) {
          const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0);
          const edgeWeight = weights.get(id) || 1;
          incoming += sourceScore * (edgeWeight / totalWeight);
        } else {
          incoming += sourceScore / sourceNode.outEdges.length;
        }
      }

      // (1 - d) * teleport + d * (link_score + dangling_share)
      newScores.set(id, (1 - damping) * tp + damping * incoming + danglingRedist * tp);
    }

    for (const [id, score] of newScores) scores.set(id, score);
  }

  return scores;
}

/**
 * Get reference count (in-degree) for each node.
 * Simpler than PageRank but still useful for ranking.
 */
export function computeRefCounts(nodes: Map<string, GraphNode>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [id, node] of nodes) {
    counts.set(id, node.inEdges.length);
  }
  return counts;
}
