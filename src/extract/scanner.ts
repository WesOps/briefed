import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { join, relative, extname } from "path";
import { PARSEABLE_EXTENSIONS, SKIP_DIRS } from "../utils/detect.js";
import { debug } from "../utils/log.js";

export interface DiscoveredFile {
  path: string;       // relative to root
  absolutePath: string;
  extension: string;
  sizeBytes: number;
}

export interface ScanResult {
  root: string;
  files: DiscoveredFile[];
  totalFiles: number;
  totalBytes: number;
  filesByExtension: Map<string, number>;
}

/**
 * Discover all parseable source files in a project.
 * Respects .gitignore patterns and skips known non-source directories.
 */
export function scanFiles(root: string): ScanResult {
  const files: DiscoveredFile[] = [];
  const filesByExtension = new Map<string, number>();

  // Load .gitignore + .briefedignore patterns
  const ignorePatterns = [
    ...loadIgnoreFile(join(root, ".gitignore")),
    ...loadIgnoreFile(join(root, ".briefedignore")),
  ];

  function walk(dir: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      debug(`cannot read directory ${dir}: ${(e as Error).message}`);
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".") continue;
        if (isIgnored(relPath, ignorePatterns)) continue;
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if (!PARSEABLE_EXTENSIONS.has(ext)) continue;
        if (isIgnored(relPath, ignorePatterns)) continue;

        let size: number;
        try {
          size = statSync(fullPath).size;
        } catch (e) {
          debug(`cannot stat ${fullPath}: ${(e as Error).message}`);
          continue;
        }

        // Skip very large files (>500KB — likely generated)
        if (size > 500_000) continue;

        files.push({
          path: relPath,
          absolutePath: fullPath,
          extension: ext,
          sizeBytes: size,
        });

        filesByExtension.set(ext, (filesByExtension.get(ext) || 0) + 1);
      }
    }
  }

  walk(root);

  return {
    root,
    files,
    totalFiles: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
    filesByExtension,
  };
}

function loadIgnoreFile(filePath: string): string[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function isIgnored(relPath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Simple pattern matching — covers most .gitignore patterns
    if (pattern.endsWith("/")) {
      // Directory pattern
      const dir = pattern.slice(0, -1);
      if (relPath.startsWith(dir + "/") || relPath === dir) return true;
    } else if (pattern.startsWith("*")) {
      // Wildcard suffix
      const suffix = pattern.slice(1);
      if (relPath.endsWith(suffix)) return true;
    } else if (pattern.includes("*")) {
      // Basic glob — convert to regex
      const regex = new RegExp(
        "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"
      );
      if (regex.test(relPath)) return true;
    } else {
      // Exact match or prefix
      if (relPath === pattern || relPath.startsWith(pattern + "/"))
        return true;
    }
  }
  return false;
}
