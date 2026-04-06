import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { FileExtraction } from "./signatures.js";

export interface DepInfo {
  /** Package name as imported (e.g. "stripe", "@stripe/stripe-js"). */
  name: string;
  /** Resolved version from package.json/lockfile, or null if unknown. */
  version: string | null;
  /** Number of files in the project that import this package. */
  importCount: number;
  /** True if this looks like a private/internal scope. */
  isPrivate: boolean;
}

export interface DepsResult {
  packages: DepInfo[];
  /** True if Context7 MCP server is configured — affects how we present output. */
  hasContext7: boolean;
}

const STDLIB_PREFIXES = new Set([
  "node:", "fs", "path", "os", "url", "crypto", "child_process", "util",
  "stream", "events", "http", "https", "net", "tls", "buffer", "querystring",
  "zlib", "readline", "assert", "process", "vm", "string_decoder",
]);

/**
 * Extract external dependency context. Surfaces the installed version and
 * import frequency of each external package the project actually uses, so
 * AI agents know which version they're targeting.
 *
 * Pairs naturally with Context7 (which serves public package docs): briefed
 * tells the agent "you're on stripe@10.17.0 with 12 imports", Context7 then
 * serves the version-pinned docs.
 *
 * For private/workspace packages where Context7 has zero coverage, the
 * version + import count is the most useful thing we can give without
 * deeply parsing every d.ts file.
 */
export function extractDeps(root: string, extractions: FileExtraction[]): DepsResult {
  // Count imports per external package across the codebase
  const counts = new Map<string, number>();
  for (const ext of extractions) {
    const seen = new Set<string>();
    for (const imp of ext.imports) {
      if (imp.isRelative) continue;
      const pkgName = packageNameFromImport(imp.source);
      if (!pkgName) continue;
      if (STDLIB_PREFIXES.has(pkgName) || pkgName.startsWith("node:")) continue;
      // Count once per file per package, not once per import statement
      if (seen.has(pkgName)) continue;
      seen.add(pkgName);
      counts.set(pkgName, (counts.get(pkgName) || 0) + 1);
    }
  }

  // Resolve versions from root package.json (deps + devDeps + peerDeps)
  const versionMap = readPackageJsonVersions(root);

  const packages: DepInfo[] = [];
  for (const [name, importCount] of counts) {
    const declared = versionMap.get(name) || null;
    // Prefer the lockfile-resolved version if we can find it
    const installed = readInstalledVersion(root, name) || declared;
    packages.push({
      name,
      version: installed,
      importCount,
      isPrivate: looksPrivate(name),
    });
  }

  // Sort: private first (most valuable, least covered by Context7), then by import count
  packages.sort((a, b) => {
    if (a.isPrivate !== b.isPrivate) return a.isPrivate ? -1 : 1;
    return b.importCount - a.importCount;
  });

  const hasContext7 = detectContext7(root);

  return { packages, hasContext7 };
}

/**
 * Format the top dependencies for the skeleton. When Context7 is present,
 * we annotate the heading so the agent knows it can ask Context7 for the
 * version-pinned docs of any non-private package.
 */
export function formatDeps(deps: DepsResult, top: number = 12): string {
  if (deps.packages.length === 0) return "";
  const heading = deps.hasContext7
    ? "External deps (Context7 detected — ask Context7 for public docs by version):"
    : "External deps:";

  const lines: string[] = [heading];
  for (const pkg of deps.packages.slice(0, top)) {
    const versionTag = pkg.version ? `@${pkg.version}` : "";
    const privateTag = pkg.isPrivate ? " [private]" : "";
    lines.push(`  - ${pkg.name}${versionTag} — ${pkg.importCount} imports${privateTag}`);
  }
  return lines.join("\n");
}

/**
 * Extract the package name from an import path.
 *   "stripe"                  → "stripe"
 *   "stripe/lib/billing"      → "stripe"
 *   "@stripe/stripe-js"       → "@stripe/stripe-js"
 *   "@stripe/stripe-js/utils" → "@stripe/stripe-js"
 */
function packageNameFromImport(source: string): string | null {
  if (!source) return null;
  if (source.startsWith(".") || source.startsWith("/")) return null;
  if (source.startsWith("@")) {
    const parts = source.split("/");
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return source.split("/")[0];
}

function readPackageJsonVersions(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return map;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const obj = pkg[field];
      if (!obj) continue;
      for (const [name, version] of Object.entries(obj)) {
        if (typeof version === "string") {
          // Strip semver range prefix so we present a clean version
          map.set(name, version.replace(/^[\^~>=<]+/, ""));
        }
      }
    }
  } catch { /* ignore */ }
  return map;
}

/**
 * Try to read the actually-installed version from node_modules. This is
 * more accurate than the semver range in package.json (which might say
 * "^10.0.0" while you actually have 10.17.4 locked).
 */
function readInstalledVersion(root: string, pkgName: string): string | null {
  const installedPkg = join(root, "node_modules", pkgName, "package.json");
  if (!existsSync(installedPkg)) return null;
  try {
    const pkg = JSON.parse(readFileSync(installedPkg, "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Heuristic for "this is probably a private/internal package": scoped
 * package whose scope isn't a known public org. We could check the npm
 * registry but that requires a network call and adds latency. Better to
 * be permissive (mark anything scoped as potentially private) and let
 * Context7 sort it out at query time.
 */
function looksPrivate(name: string): boolean {
  if (!name.startsWith("@")) return false;
  // Known public scopes that are NOT private even though they're scoped
  const publicScopes = new Set([
    "@types", "@babel", "@typescript-eslint", "@eslint", "@vitest",
    "@stripe", "@aws-sdk", "@google-cloud", "@azure", "@sentry",
    "@radix-ui", "@tanstack", "@tailwindcss", "@vercel", "@nestjs",
    "@nuxt", "@nuxtjs", "@vue", "@react-native", "@reduxjs",
    "@modelcontextprotocol", "@anthropic-ai", "@openai",
    "@hookform", "@floating-ui", "@supabase", "@auth0", "@clerk",
    "@upstash", "@trpc", "@prisma", "@drizzle-orm", "@planetscale",
  ]);
  const scope = name.split("/")[0];
  return !publicScopes.has(scope);
}

/**
 * Detect Context7 by scanning common MCP config locations for the string
 * "context7". This is intentionally string-based so we don't have to
 * understand every config schema variant.
 */
function detectContext7(root: string): boolean {
  const candidates = [
    join(root, ".mcp.json"),
    join(root, ".claude", "settings.json"),
    join(root, ".claude", "settings.local.json"),
    join(root, ".cursor", "mcp.json"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, "utf-8");
      if (/context7/i.test(content)) return true;
    } catch { /* ignore */ }
  }
  // Also check ~/.claude/settings.json (user-level config)
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    const userSettings = join(home, ".claude", "settings.json");
    if (existsSync(userSettings)) {
      try {
        const content = readFileSync(userSettings, "utf-8");
        if (/context7/i.test(content)) return true;
      } catch { /* ignore */ }
    }
  }
  return false;
}

/** Exposed for tests. */
export const __test = { packageNameFromImport, looksPrivate };
