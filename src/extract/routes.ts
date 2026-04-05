import { readFileSync } from "fs";
import { glob } from "glob";
import { join, relative } from "path";

export interface Route {
  method: string;
  path: string;
  handler: string;
  file: string;
  middleware: string[];
}

/**
 * Extract API routes from the codebase.
 * Supports: Express, Fastify, Next.js App Router, Next.js Pages API, FastAPI, Django, Hono.
 */
export function extractRoutes(root: string): Route[] {
  const routes: Route[] = [];

  // Next.js App Router (src/app/**/route.ts)
  const nextAppRoutes = glob.sync("**/route.{ts,tsx,js,jsx}", {
    cwd: root,
    ignore: ["node_modules/**", "dist/**", ".next/**"],
  });
  for (const f of nextAppRoutes) {
    const content = readFileSync(join(root, f), "utf-8");
    const path = "/" + f.replace(/\/route\.\w+$/, "").replace(/^(?:src\/)?app\//, "").replace(/\(.*?\)\//g, "");

    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      if (content.includes(`export async function ${method}`) || content.includes(`export function ${method}`)) {
        routes.push({ method, path, handler: method, file: f, middleware: [] });
      }
    }
  }

  // Next.js Pages API (pages/api/**/*.ts)
  const nextPagesRoutes = glob.sync("pages/api/**/*.{ts,tsx,js,jsx}", {
    cwd: root,
    ignore: ["node_modules/**"],
  });
  for (const f of nextPagesRoutes) {
    const path = "/api/" + f.replace(/^pages\/api\//, "").replace(/\.\w+$/, "").replace(/\/index$/, "");
    routes.push({ method: "ALL", path, handler: "default", file: f, middleware: [] });
  }

  // Express / Fastify routes
  const jsFiles = glob.sync("**/*.{ts,js}", {
    cwd: root,
    ignore: ["node_modules/**", "dist/**", "test/**", "*.test.*", "*.spec.*"],
  });

  for (const f of jsFiles) {
    let content: string;
    try {
      content = readFileSync(join(root, f), "utf-8");
    } catch {
      continue;
    }

    // Express: app.get('/path', handler) or router.post('/path', ...middleware, handler)
    const expressRegex = /(?:app|router|server)\.(get|post|put|patch|delete|all)\s*\(\s*['"]([^'"]+)['"]/gi;
    for (const match of content.matchAll(expressRegex)) {
      routes.push({
        method: match[1].toUpperCase(),
        path: match[2],
        handler: f,
        file: f,
        middleware: extractMiddleware(content, match.index || 0),
      });
    }

    // Fastify: fastify.get('/path', handler) or fastify.route({ method, url })
    const fastifyRegex = /(?:fastify|app|server)\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi;
    for (const match of content.matchAll(fastifyRegex)) {
      if (routes.some((r) => r.method === match[1].toUpperCase() && r.path === match[2])) continue;
      routes.push({
        method: match[1].toUpperCase(),
        path: match[2],
        handler: f,
        file: f,
        middleware: [],
      });
    }

    // Hono: app.get('/path', handler)
    const honoRegex = /\.(?:get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi;
    if (content.includes("from 'hono'") || content.includes("from \"hono\"")) {
      for (const match of content.matchAll(honoRegex)) {
        const methodMatch = match[0].match(/\.(get|post|put|patch|delete)/i);
        if (methodMatch) {
          routes.push({
            method: methodMatch[1].toUpperCase(),
            path: match[1],
            handler: f,
            file: f,
            middleware: [],
          });
        }
      }
    }
  }

  // FastAPI (Python)
  const pyFiles = glob.sync("**/*.py", {
    cwd: root,
    ignore: ["venv/**", ".venv/**", "__pycache__/**"],
  });

  for (const f of pyFiles) {
    let content: string;
    try {
      content = readFileSync(join(root, f), "utf-8");
    } catch {
      continue;
    }

    // FastAPI: @app.get("/path") or @router.post("/path")
    const fastapiRegex = /@(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi;
    for (const match of content.matchAll(fastapiRegex)) {
      routes.push({
        method: match[1].toUpperCase(),
        path: match[2],
        handler: f,
        file: f,
        middleware: [],
      });
    }

    // Django: path('url', view)
    const djangoRegex = /path\s*\(\s*['"]([^'"]*)['"]\s*,\s*(\w+)/g;
    for (const match of content.matchAll(djangoRegex)) {
      routes.push({
        method: "ALL",
        path: "/" + match[1],
        handler: match[2],
        file: f,
        middleware: [],
      });
    }
  }

  return routes;
}

function extractMiddleware(content: string, matchIndex: number): string[] {
  // Look for middleware names in the route definition
  const after = content.slice(matchIndex, matchIndex + 300);
  const mwMatch = after.match(/,\s*(\w+(?:Middleware|Auth|validate|check)\w*)/gi);
  return mwMatch?.map((m) => m.replace(/^,\s*/, "")) || [];
}

/**
 * Format routes for skeleton inclusion.
 */
export function formatRoutes(routes: Route[]): string {
  if (routes.length === 0) return "";

  const lines: string[] = ["API endpoints:"];

  // Group by path prefix
  const grouped = new Map<string, Route[]>();
  for (const r of routes) {
    const prefix = r.path.split("/").slice(0, 3).join("/");
    if (!grouped.has(prefix)) grouped.set(prefix, []);
    grouped.get(prefix)!.push(r);
  }

  for (const [prefix, group] of grouped) {
    const methods = group.map((r) => r.method).join(", ");
    const mw = group.flatMap((r) => r.middleware).filter(Boolean);
    let line = `  ${methods} ${prefix}`;
    if (mw.length > 0) line += ` [${[...new Set(mw)].join(", ")}]`;
    lines.push(line);
  }

  return lines.join("\n");
}
