import { dirname, basename } from "path";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import type { FileExtraction } from "../extract/signatures.js";
import type { DepGraph } from "../extract/depgraph.js";
import type { ComplexityScore } from "../extract/complexity.js";

export interface ModuleEntry {
  name: string;      // module name (directory-based)
  dir: string;       // directory path
  files: string[];   // file paths in this module
  keywords: string[]; // keywords for prompt matching
  complexity: number; // average complexity of files
  file: string;      // contract filename
}

export interface ModuleIndex {
  modules: ModuleEntry[];
  generated: string;
}

/**
 * Group files into logical modules and generate an index for prompt matching.
 * Modules are primarily directory-based with keyword extraction.
 */
export function generateModuleIndex(
  extractions: FileExtraction[],
  _depGraph: DepGraph,
  complexity: ComplexityScore[],
  _root: string
): ModuleIndex {
  // Group files by directory
  const dirGroups = new Map<string, FileExtraction[]>();
  for (const ext of extractions) {
    const dir = dirname(ext.path);
    if (!dirGroups.has(dir)) dirGroups.set(dir, []);
    dirGroups.get(dir)!.push(ext);
  }

  const modules: ModuleEntry[] = [];

  for (const [dir, files] of dirGroups) {
    if (files.length === 0) continue;

    // Extract keywords from:
    // 1. Directory name parts
    // 2. File names
    // 3. Exported symbol names
    const keywords = new Set<string>();

    // Directory parts
    for (const part of dir.split("/")) {
      if (part && part.length > 2) {
        keywords.add(part.toLowerCase());
        // Split camelCase/PascalCase
        for (const word of splitIdentifier(part)) {
          if (word.length > 2) keywords.add(word.toLowerCase());
        }
      }
    }

    // File names (without extension, skip test files)
    for (const f of files) {
      const name = basename(f.path).replace(/\.[^.]+$/, "");
      if (/\.(test|spec|stories)$/.test(name)) continue; // skip test file keywords
      keywords.add(name.toLowerCase());
    }

    // Exported symbol names (full names only — fragments are low-signal noise)
    for (const f of files) {
      for (const sym of f.symbols.filter((s) => s.exported)) {
        const name = sym.name.split(".").pop()!;
        if (name.length > 3) keywords.add(name.toLowerCase());
      }
    }

    // Keywords from LLM-generated descriptions on exported symbols only.
    // Restricted to exported symbols (the public API) to avoid noise from
    // internal helpers. Min length 5 + extended stop list keeps keywords
    // specific enough to signal real topic overlap without false-positive
    // matches on generic English words.
    const descStopWords = new Set([
      "and", "the", "for", "from", "with", "that", "this", "when",
      "are", "has", "its", "not", "can", "will", "all", "any", "via",
      "used", "uses", "each", "into", "over", "per", "was", "been",
      "than", "also", "only", "then", "both", "more", "some", "such",
      "given", "based", "build", "built", "call", "calls", "load",
      "loads", "read", "reads", "write", "writes", "gets", "sets",
      "runs", "returns", "result", "results", "value", "values",
      "data", "file", "files", "path", "paths", "name", "names",
      "list", "array", "object", "string", "number", "boolean",
      "type", "types", "true", "false", "null", "node", "line",
      "text", "code", "item", "items", "entry", "entries", "field",
      "fields", "found", "find", "finds", "check", "checks", "pass",
      "fail", "fails", "make", "makes", "take", "takes", "like",
      "after", "before", "where", "which", "their", "there", "have",
    ]);
    for (const f of files) {
      for (const sym of f.symbols.filter((s) => s.exported)) {
        if (!sym.description) continue;
        for (const word of sym.description.split(/[^a-zA-Z]+/)) {
          const w = word.toLowerCase();
          if (w.length >= 5 && !descStopWords.has(w)) keywords.add(w);
        }
      }
    }

    // Remove very common/generic keywords
    const genericWords = new Set([
      "src", "lib", "app", "index", "utils", "helpers", "types",
      "const", "config", "common", "shared", "core", "main",
    ]);
    for (const gw of genericWords) keywords.delete(gw);

    // Compute average complexity
    const fileComplexities = files
      .map((f) => complexity.find((c) => c.file === f.path)?.score || 0);
    const avgComplexity = fileComplexities.length > 0
      ? fileComplexities.reduce((s, v) => s + v, 0) / fileComplexities.length
      : 0;

    const safeName = dir.replace(/[\/\\]/g, "-").replace(/^-/, "") || "root";

    modules.push({
      name: safeName,
      dir,
      files: files.map((f) => f.path),
      keywords: [...keywords],
      complexity: Math.round(avgComplexity * 10) / 10,
      file: `${safeName}.yaml`,
    });
  }

  // Sort by complexity (most complex first — they need context most)
  modules.sort((a, b) => b.complexity - a.complexity);

  return {
    modules,
    generated: new Date().toISOString(),
  };
}

/**
 * Write the module index to .briefed/index.json
 */
export function writeModuleIndex(root: string, index: ModuleIndex) {
  const briefedDir = join(root, ".briefed");
  if (!existsSync(briefedDir)) mkdirSync(briefedDir, { recursive: true });
  writeFileSync(
    join(briefedDir, "index.json"),
    JSON.stringify(index, null, 2)
  );
}

/**
 * Generate simple contract files for each module (non-LLM version).
 * Extracts structural info: purpose, exports, deps, complexity.
 */
export function generateSimpleContracts(
  index: ModuleIndex,
  extractions: FileExtraction[],
  depGraph: DepGraph,
  root: string
) {
  const contractsDir = join(root, ".briefed", "contracts");
  if (!existsSync(contractsDir)) mkdirSync(contractsDir, { recursive: true });

  // Build file→module lookup for fast dependency resolution
  const fileToModule = new Map<string, string>();
  for (const mod of index.modules) {
    for (const f of mod.files) {
      fileToModule.set(f, mod.name);
    }
  }

  for (const mod of index.modules) {
    const modExtractions = extractions.filter((e) =>
      mod.files.includes(e.path)
    );

    const exports = modExtractions.flatMap((e) =>
      e.symbols.filter((s) => s.exported)
    );

    // Use actual depGraph edges for accurate dependency resolution
    const deps = new Set<string>();
    const dependents = new Set<string>();
    for (const filePath of mod.files) {
      const node = depGraph.nodes.get(filePath);
      if (!node) continue;
      // outEdges = files this module imports from
      for (const target of node.outEdges) {
        const targetMod = fileToModule.get(target);
        if (targetMod && targetMod !== mod.name) deps.add(targetMod);
      }
      // inEdges = files that import from this module
      for (const source of node.inEdges) {
        const sourceMod = fileToModule.get(source);
        if (sourceMod && sourceMod !== mod.name) dependents.add(sourceMod);
      }
    }

    const contract: Record<string, unknown> = {
      module: mod.dir,
      files: mod.files.length,
      complexity: mod.complexity,
    };

    // Enriched exports: signature + description + symbol-level caller count
    if (exports.length > 0) {
      contract.exports = exports.slice(0, 15).map((s) => {
        // Symbol-level cross-refs: how many files import this specific symbol
        const filePath = modExtractions.find((e) => e.symbols.includes(s))?.path || "";
        const symRefs = depGraph.symbolRefs.get(`${filePath}#${s.name}`);
        const callerCount = symRefs ? symRefs.length : 0;

        let entry = s.signature;
        if (s.description) entry += ` — ${s.description}`;
        if (callerCount > 0) entry += ` [${callerCount} callers]`;
        return entry;
      });
    }

    // Function-level call graph: which imported symbols each function calls
    const callEntries: string[] = [];
    for (const ext of modExtractions) {
      for (const sym of ext.symbols) {
        if (sym.calls && sym.calls.length > 0 && sym.exported) {
          callEntries.push(`${sym.name} → ${sym.calls.join(", ")}`);
        }
      }
    }
    if (callEntries.length > 0) {
      contract.call_graph = callEntries.slice(0, 20);
    }

    if (deps.size > 0) {
      contract.dependencies = [...deps];
    }

    if (dependents.size > 0) {
      contract.dependents = [...dependents];
    }

    const yamlContent = yaml.dump(contract, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
    });

    writeFileSync(join(contractsDir, mod.file), yamlContent);
  }
}

/** Split camelCase/PascalCase/snake_case identifiers into words */
function splitIdentifier(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}
