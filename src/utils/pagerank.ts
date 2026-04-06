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
}

/**
 * Compute PageRank scores for a file dependency graph.
 * Returns map of file path → score (higher = more central).
 */
export function computePageRank(
  nodes: Map<string, GraphNode>,
  iterations: number = 20,
  damping: number = 0.85
): Map<string, number> {
  const n = nodes.size;
  if (n === 0) return new Map();

  // Initialize scores
  const scores = new Map<string, number>();
  const initialScore = 1 / n;
  for (const id of nodes.keys()) {
    scores.set(id, initialScore);
  }

  // Iterate
  for (let i = 0; i < iterations; i++) {
    const newScores = new Map<string, number>();
    const base = (1 - damping) / n;

    for (const [id, node] of nodes) {
      let incomingScore = 0;
      for (const sourceId of node.inEdges) {
        const sourceNode = nodes.get(sourceId);
        if (sourceNode && sourceNode.outEdges.length > 0) {
          const sourceScore = scores.get(sourceId) || 0;
          // Use edge weights if available: distribute score proportional to symbol count
          const weights = sourceNode.edgeWeights;
          if (weights && weights.size > 0) {
            const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0);
            const edgeWeight = weights.get(id) || 1;
            incomingScore += sourceScore * (edgeWeight / totalWeight);
          } else {
            incomingScore += sourceScore / sourceNode.outEdges.length;
          }
        }
      }
      newScores.set(id, base + damping * incomingScore);
    }

    // Update scores
    for (const [id, score] of newScores) {
      scores.set(id, score);
    }
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
