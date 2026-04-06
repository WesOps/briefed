import { dirname, join, relative } from "path";
import type { FileExtraction } from "./signatures.js";
import { GraphNode, computePageRank, computeRefCounts } from "../utils/pagerank.js";

export interface DepGraph {
  nodes: Map<string, GraphNode>;
  pageRank: Map<string, number>;
  refCounts: Map<string, number>;
  /** Symbol cross-references: "file#symbolName" → list of files that import it */
  symbolRefs: Map<string, string[]>;
}

/**
 * Build a dependency graph from file extractions.
 * Resolves relative imports to actual file paths.
 */
export function buildDepGraph(
  extractions: FileExtraction[],
  root: string
): DepGraph {
  const fileSet = new Set(extractions.map((e) => e.path));
  const nodes = new Map<string, GraphNode>();

  // Initialize all nodes
  for (const ext of extractions) {
    nodes.set(ext.path, {
      id: ext.path,
      outEdges: [],
      inEdges: [],
    });
  }

  // Symbol cross-reference map: "file#symbolName" → importing files
  const symbolRefs = new Map<string, string[]>();

  // Resolve imports and build edges
  for (const ext of extractions) {
    const node = nodes.get(ext.path)!;
    if (!node.edgeWeights) node.edgeWeights = new Map();
    if (!node.runtimeOutEdges) node.runtimeOutEdges = new Set();

    for (const imp of ext.imports) {
      if (!imp.isRelative) continue; // skip external packages

      const resolved = resolveImport(ext.path, imp.source, root, fileSet);
      if (resolved && nodes.has(resolved)) {
        if (!node.outEdges.includes(resolved)) {
          node.outEdges.push(resolved);
        }
        // Track edge weight: number of symbols imported
        const symbolCount = Math.max(imp.names.length, 1);
        node.edgeWeights.set(resolved, (node.edgeWeights.get(resolved) || 0) + symbolCount);
        // Mark runtime if at least one import statement on this edge isn't type-only
        if (!imp.isTypeOnly) {
          node.runtimeOutEdges.add(resolved);
        }

        const targetNode = nodes.get(resolved)!;
        if (!targetNode.inEdges.includes(ext.path)) {
          targetNode.inEdges.push(ext.path);
        }

        // Track symbol-level cross-references
        for (const name of imp.names) {
          const key = `${resolved}#${name}`;
          const refs = symbolRefs.get(key);
          if (refs) {
            if (!refs.includes(ext.path)) refs.push(ext.path);
          } else {
            symbolRefs.set(key, [ext.path]);
          }
        }
      }
    }
  }

  // Compute rankings
  const pageRank = computePageRank(nodes);
  const refCounts = computeRefCounts(nodes);

  return { nodes, pageRank, refCounts, symbolRefs };
}

/**
 * Resolve a relative import to a file path.
 * Handles TypeScript/JS resolution with extension inference.
 */
function resolveImport(
  fromFile: string,
  importPath: string,
  root: string,
  fileSet: Set<string>
): string | null {
  const fromDir = dirname(join(root, fromFile));
  const basePath = relative(root, join(fromDir, importPath)).replace(/\\/g, "/");

  // Security: prevent path traversal outside project root
  if (basePath.startsWith("..") || basePath.startsWith("/")) return null;

  // Try exact match first
  if (fileSet.has(basePath)) return basePath;

  // ESM: strip .js/.mjs extension before trying .ts (TypeScript ESM uses .js in imports)
  const esmMap: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".mjs": [".mts"], ".jsx": [".tsx"] };
  const ext = basePath.match(/\.\w+$/)?.[0] || "";
  if (esmMap[ext]) {
    const stem = basePath.slice(0, -ext.length);
    for (const tsExt of esmMap[ext]) {
      if (fileSet.has(stem + tsExt)) return stem + tsExt;
    }
  }

  // Try with extensions
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".go", ".rs"];
  for (const ext of extensions) {
    const withExt = basePath + ext;
    if (fileSet.has(withExt)) return withExt;
  }

  // Try index files
  const indexFiles = ["index.ts", "index.tsx", "index.js", "index.jsx", "mod.rs", "__init__.py"];
  for (const idx of indexFiles) {
    const indexPath = basePath + "/" + idx;
    if (fileSet.has(indexPath)) return indexPath;
  }

  return null;
}
