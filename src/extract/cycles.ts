import type { DepGraph } from "./depgraph.js";

/**
 * Detect import cycles in the dependency graph using iterative DFS.
 * Returns each cycle as an ordered list of files starting from the
 * smallest member (so equivalent cycles deduplicate).
 */
export function detectCycles(depGraph: DepGraph): string[][] {
  const cycles: string[][] = [];
  const seen = new Set<string>();

  // Iterative DFS with explicit stack so we don't blow the call stack
  // on large graphs.
  const WHITE = 0; // unvisited
  const GRAY = 1;  // on current stack
  const BLACK = 2; // fully explored
  const color = new Map<string, number>();
  for (const id of depGraph.nodes.keys()) color.set(id, WHITE);

  for (const start of depGraph.nodes.keys()) {
    if (color.get(start) !== WHITE) continue;
    // path tracks the current DFS chain so we can extract a cycle when we
    // hit a GRAY node
    const path: string[] = [];
    const iterStack: { id: string; childIdx: number }[] = [{ id: start, childIdx: 0 }];
    color.set(start, GRAY);
    path.push(start);

    while (iterStack.length > 0) {
      const frame = iterStack[iterStack.length - 1];
      const node = depGraph.nodes.get(frame.id);
      if (!node || frame.childIdx >= node.outEdges.length) {
        color.set(frame.id, BLACK);
        path.pop();
        iterStack.pop();
        continue;
      }
      const child = node.outEdges[frame.childIdx++];
      const c = color.get(child) ?? WHITE;
      if (c === GRAY) {
        // Cycle: extract from where the child appears in path
        const idx = path.indexOf(child);
        if (idx >= 0) {
          const cycle = path.slice(idx).concat(child);
          const key = canonicalize(cycle);
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push(rotateToSmallest(cycle.slice(0, -1)));
          }
        }
      } else if (c === WHITE) {
        color.set(child, GRAY);
        path.push(child);
        iterStack.push({ id: child, childIdx: 0 });
      }
    }
  }

  // Sort cycles by length (smallest first), then alphabetically
  cycles.sort((a, b) => a.length - b.length || a[0].localeCompare(b[0]));
  return cycles;
}

function rotateToSmallest(cycle: string[]): string[] {
  if (cycle.length === 0) return cycle;
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIdx]) minIdx = i;
  }
  return cycle.slice(minIdx).concat(cycle.slice(0, minIdx));
}

function canonicalize(cycle: string[]): string {
  // Cycles equivalent under rotation share a key
  return rotateToSmallest(cycle.slice(0, -1)).join(" -> ");
}

/**
 * Format detected cycles as a skeleton section.
 * Returns empty string if there are no cycles (don't pollute output).
 */
export function formatCycles(cycles: string[][]): string {
  if (cycles.length === 0) return "";
  const lines: string[] = [];
  lines.push(`Import cycles: ${cycles.length} detected (refactor footgun)`);
  for (const cycle of cycles.slice(0, 8)) {
    lines.push(`  - ${cycle.join(" → ")} → ${cycle[0]}`);
  }
  if (cycles.length > 8) lines.push(`  - ... and ${cycles.length - 8} more`);
  return lines.join("\n");
}
