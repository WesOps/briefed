import { readFileSync } from "fs";
import { join } from "path";
import type { Route } from "./routes.js";
import type { ScanResult } from "./scanner.js";

export interface RouteCall {
  /** Frontend file making the call */
  file: string;
  /** HTTP method (GET, POST, etc.) */
  method: string;
  /** URL path being called */
  path: string;
  /** Line number in the frontend file */
  line: number;
  /** Matched route, if found in extracted backend routes */
  matchedRoute: Route | null;
}

export interface CrossLayerGraph {
  /** Frontend → backend HTTP calls */
  routeCalls: RouteCall[];
  /** Backend route → list of frontend files that call it */
  routeCallers: Map<string, string[]>;
}

// Patterns for detecting HTTP client calls in frontend code
const CALL_PATTERNS = [
  // fetch("/api/users", { method: "POST" }) or fetch("/api/users")
  /\bfetch\s*\(\s*["'`]([^"'`]+)["'`](?:\s*,\s*\{[^}]*method\s*:\s*["'`](\w+)["'`])?/g,
  // axios.get("/api/users") / axios.post(...) etc
  /\baxios\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
  // axios("/api/users", { method: "POST" })
  /\baxios\s*\(\s*["'`]([^"'`]+)["'`](?:\s*,\s*\{[^}]*method\s*:\s*["'`](\w+)["'`])?/g,
  // $fetch("/api/users", { method: "POST" }) — Nuxt
  /\$fetch\s*\(\s*["'`]([^"'`]+)["'`](?:\s*,\s*\{[^}]*method\s*:\s*["'`](\w+)["'`])?/g,
  // useFetch("/api/users") — Nuxt/SWR style
  /\buseFetch\s*\(\s*["'`]([^"'`]+)["'`]/g,
  // useSWR("/api/users") — SWR
  /\buseSWR\s*\(\s*["'`]([^"'`]+)["'`]/g,
  // ky.get("/api/users")
  /\bky\s*\.\s*(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
];

/**
 * Extract HTTP calls from frontend files and link them to backend routes.
 * Builds the cross-layer dependency graph that file imports miss.
 */
export function extractRouteCalls(
  root: string,
  scan: ScanResult,
  routes: Route[]
): CrossLayerGraph {
  const routeCalls: RouteCall[] = [];
  const routeCallers = new Map<string, string[]>();

  // Only scan likely frontend files (skip server files, tests, configs)
  const frontendFiles = scan.files.filter((f) => {
    const p = f.path;
    if (!/\.(ts|tsx|js|jsx|vue|svelte)$/.test(p)) return false;
    if (/\.(test|spec)\./.test(p)) return false;
    if (/(^|\/)(server|api|backend|routes)\//.test(p)) return false;
    return true;
  });

  for (const file of frontendFiles) {
    let content: string;
    try {
      content = readFileSync(join(root, file.path), "utf-8");
    } catch {
      continue;
    }

    // Quick reject: skip files with no obvious HTTP client usage
    if (!/\b(fetch|axios|\$fetch|useFetch|useSWR|ky)\b/.test(content)) continue;

    for (const pattern of CALL_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const url = match[1] || match[2];
        const method = (match[2] && !match[2].startsWith("/") ? match[2] : match[1] && !match[1].startsWith("/") ? match[1] : "GET").toUpperCase();

        // Only track URLs that look like API paths
        if (!url || !url.startsWith("/")) continue;
        if (url.length < 2) continue;

        // Compute line number
        const line = content.slice(0, match.index).split("\n").length;

        // Try to match against extracted backend routes
        const matched = matchRoute(url, method, routes);

        const call: RouteCall = {
          file: file.path,
          method,
          path: url,
          line,
          matchedRoute: matched,
        };
        routeCalls.push(call);

        if (matched) {
          const key = `${matched.method} ${matched.path}`;
          const callers = routeCallers.get(key);
          if (callers) {
            if (!callers.includes(file.path)) callers.push(file.path);
          } else {
            routeCallers.set(key, [file.path]);
          }
        }
      }
    }
  }

  return { routeCalls, routeCallers };
}

/**
 * Match a frontend URL call to an extracted backend route.
 * Handles param interpolation: /api/users/123 matches /api/users/:id
 */
function matchRoute(url: string, method: string, routes: Route[]): Route | null {
  // Strip query string
  const cleanUrl = url.split("?")[0].replace(/\/$/, "");
  const urlSegments = cleanUrl.split("/").filter(Boolean);

  for (const route of routes) {
    if (route.method.toUpperCase() !== method.toUpperCase()) continue;

    const routeSegments = route.path.replace(/\/$/, "").split("/").filter(Boolean);
    if (routeSegments.length !== urlSegments.length) continue;

    let allMatch = true;
    for (let i = 0; i < routeSegments.length; i++) {
      const r = routeSegments[i];
      const u = urlSegments[i];
      // Param segment matches anything (`:id`, `{id}`, `[id]`)
      if (r.startsWith(":") || (r.startsWith("{") && r.endsWith("}")) || (r.startsWith("[") && r.endsWith("]"))) {
        continue;
      }
      if (r !== u) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return route;
  }
  return null;
}

/**
 * Format the cross-layer graph for skeleton inclusion.
 */
export function formatRouteCalls(graph: CrossLayerGraph): string {
  if (graph.routeCallers.size === 0) return "";

  const lines: string[] = [];
  lines.push("## Cross-layer (frontend → backend)");
  lines.push("");

  // Show top routes by caller count
  const sorted = [...graph.routeCallers.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 15);

  for (const [route, callers] of sorted) {
    const callerList = callers.length > 3
      ? `${callers.slice(0, 3).join(", ")} (+${callers.length - 3})`
      : callers.join(", ");
    lines.push(`- ${route} ← ${callerList}`);
  }

  // Show unmatched calls (potential bugs / external APIs)
  const unmatched = graph.routeCalls.filter((c) => !c.matchedRoute && c.path.startsWith("/api"));
  if (unmatched.length > 0) {
    lines.push("");
    lines.push(`Unmatched API calls (${unmatched.length}): may indicate missing routes or external APIs`);
  }

  return lines.join("\n");
}
