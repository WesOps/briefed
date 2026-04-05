import { readFileSync } from "fs";
import { glob } from "glob";
import { join } from "path";

export interface CachePattern {
  type: string;        // "redis" | "in-memory" | "http" | "cdn" | "framework"
  strategy: string;    // what kind of caching
  file: string;
  detail: string;
}

export function extractCaching(root: string): CachePattern[] {
  const patterns: CachePattern[] = [];

  const sourceFiles = glob.sync("**/*.{ts,tsx,js,jsx,py}", {
    cwd: root,
    ignore: ["node_modules/**", "dist/**", "venv/**", ".venv/**", "test/**"],
  });

  for (const f of sourceFiles) {
    let content: string;
    try { content = readFileSync(join(root, f), "utf-8"); } catch { continue; }

    // Redis caching
    if (content.includes("redis") || content.includes("ioredis")) {
      if (content.match(/\.set\s*\(|\.get\s*\(|\.setex\s*\(/)) {
        const ttlMatch = content.match(/\.setex\s*\([^,]+,\s*(\d+)/);
        patterns.push({
          type: "redis",
          strategy: "key-value cache",
          file: f,
          detail: ttlMatch ? `TTL: ${ttlMatch[1]}s` : "manual TTL",
        });
      }
    }

    // Next.js caching: revalidate, unstable_cache, cache()
    if (content.includes("revalidate")) {
      const revalidateMatch = content.match(/revalidate\s*[:=]\s*(\d+)/);
      if (revalidateMatch) {
        patterns.push({
          type: "framework",
          strategy: "ISR/revalidate",
          file: f,
          detail: `${revalidateMatch[1]}s`,
        });
      }
    }
    if (content.includes("unstable_cache") || content.match(/\bcache\s*\(/)) {
      if (content.includes("next/cache") || content.includes("react")) {
        patterns.push({
          type: "framework",
          strategy: "React/Next cache()",
          file: f,
          detail: "request-scoped",
        });
      }
    }

    // HTTP cache headers
    if (content.match(/cache-control|Cache-Control|s-maxage|max-age|stale-while-revalidate/i)) {
      const headerMatch = content.match(/['"](?:cache-control|Cache-Control)['"]\s*[:=,]\s*['"]([^'"]+)['"]/);
      if (headerMatch) {
        patterns.push({
          type: "http",
          strategy: "Cache-Control header",
          file: f,
          detail: headerMatch[1],
        });
      }
    }

    // LRU cache / in-memory
    if (content.includes("lru-cache") || content.includes("node-cache") || content.includes("Map()") && content.includes("cache")) {
      if (content.includes("lru-cache") || content.includes("node-cache")) {
        patterns.push({
          type: "in-memory",
          strategy: "LRU cache",
          file: f,
          detail: "in-process",
        });
      }
    }

    // Python: @cache, @lru_cache, django.core.cache
    if (content.includes("@lru_cache") || content.includes("@cache")) {
      patterns.push({
        type: "in-memory",
        strategy: "functools cache",
        file: f,
        detail: "in-process",
      });
    }
    if (content.includes("django.core.cache")) {
      patterns.push({
        type: "framework",
        strategy: "Django cache",
        file: f,
        detail: "configured in settings",
      });
    }
  }

  // Deduplicate by type + file
  const seen = new Set<string>();
  return patterns.filter(p => {
    const key = `${p.type}:${p.file}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function formatCaching(patterns: CachePattern[]): string {
  if (patterns.length === 0) return "";

  // Deduplicate by type+strategy, keep only distinct patterns
  const seen = new Map<string, CachePattern>();
  for (const p of patterns) {
    const key = `${p.type}:${p.strategy}`;
    if (!seen.has(key)) seen.set(key, p);
  }

  const unique = [...seen.values()];
  if (unique.length === 0) return "";

  const parts = unique.slice(0, 5).map(p => `${p.type}/${p.strategy}(${p.detail})`);
  return `Caching: ${parts.join(", ")}`;
}
