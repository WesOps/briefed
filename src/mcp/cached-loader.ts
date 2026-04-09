import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { scanFiles } from "../extract/scanner.js";
import { extractFile } from "../extract/signatures.js";
import { buildDepGraph } from "../extract/depgraph.js";
import { debug } from "../utils/log.js";
import type { FileExtraction } from "../extract/signatures.js";
import type { DepGraph } from "../extract/depgraph.js";

interface CachedData {
  extractions: FileExtraction[];
  depGraph: DepGraph;
}

interface MemoEntry {
  data: CachedData;
  cacheMtime: number;
}

// Module-level memo: keyed by repo root path, invalidated when cache file mtime changes.
const memo = new Map<string, MemoEntry>();

/**
 * Load extractions from the SHA256 cache if available, otherwise extract live.
 * This makes MCP tool calls near-instant after `briefed init` has been run.
 * Results are memoized in-process and only reloaded when the cache file changes.
 */
export function loadCachedExtractions(root: string): CachedData {
  const cachePath = join(root, ".briefed", "extract-cache.json");

  // Try loading from cache first (populated by `briefed init`)
  if (existsSync(cachePath)) {
    try {
      const mtime = statSync(cachePath).mtimeMs;
      const entry = memo.get(root);
      if (entry && entry.cacheMtime === mtime) {
        debug(`MCP: returning memoized extractions for ${root}`);
        return entry.data;
      }

      const cache: Record<string, { hash: string; extraction: FileExtraction }> =
        JSON.parse(readFileSync(cachePath, "utf-8"));

      const extractions = Object.values(cache).map((entry) => entry.extraction);
      if (extractions.length > 0) {
        debug(`MCP: loaded ${extractions.length} cached extractions`);
        const depGraph = buildDepGraph(extractions, root);
        const data: CachedData = { extractions, depGraph };
        memo.set(root, { data, cacheMtime: mtime });
        return data;
      }
    } catch (e) {
      debug(`MCP: cache load failed, falling back to live extraction: ${(e as Error).message}`);
    }
  }

  // Fallback: live extraction (slow but works without prior init)
  debug("MCP: no cache found, extracting live");
  const scan = scanFiles(root);
  const extractions = scan.files.map((f) => {
    try {
      const ext = extractFile(f.absolutePath, root);
      ext.path = f.path;
      return ext;
    } catch (e) {
      debug(`extraction failed for ${f.path}: ${(e as Error).message}`);
      return null;
    }
  }).filter((e): e is FileExtraction => e !== null);

  const depGraph = buildDepGraph(extractions, root);
  return { extractions, depGraph };
}
