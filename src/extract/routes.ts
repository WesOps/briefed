import { readFileSync } from "fs";
import { glob } from "glob";
import { join } from "path";

export interface Route {
  method: string;
  path: string;
  handler: string;
  file: string;
  middleware: string[];
}

/**
 * Extract API routes from the codebase.
 * Supports: Express, Fastify, Hono, Next.js, Remix, SvelteKit, FastAPI, Flask, Django,
 * Gin, Echo, Fiber, Chi, Rails, Actix-web, Axum.
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
    // Skip [...nextauth] and similar catch-all auth handlers — they're implementation details
    const cleanPath = f.replace(/\\/g, "/").replace(/^pages\/api\//, "").replace(/\.\w+$/, "").replace(/\/index$/, "");
    const path = "/api/" + cleanPath;
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

  // Remix loader/action (app/routes/**/*.ts)
  const remixRoutes = glob.sync("app/routes/**/*.{ts,tsx,js,jsx}", {
    cwd: root,
    ignore: ["node_modules/**"],
  });
  for (const f of remixRoutes) {
    const content = readFileSync(join(root, f), "utf-8");
    const routePath = "/" + f.replace(/^app\/routes\//, "").replace(/\.\w+$/, "")
      .replace(/\$/g, ":").replace(/\./g, "/").replace(/_index$/, "").replace(/\(.*?\)\//g, "");
    if (content.match(/export\s+(?:async\s+)?function\s+loader/)) {
      routes.push({ method: "GET", path: routePath, handler: "loader", file: f, middleware: [] });
    }
    if (content.match(/export\s+(?:async\s+)?function\s+action/)) {
      routes.push({ method: "POST", path: routePath, handler: "action", file: f, middleware: [] });
    }
  }

  // SvelteKit (+server.ts / +page.server.ts)
  const svelteRoutes = glob.sync("src/routes/**/{+server,+page.server}.{ts,js}", {
    cwd: root,
    ignore: ["node_modules/**"],
  });
  for (const f of svelteRoutes) {
    const content = readFileSync(join(root, f), "utf-8");
    const routePath = "/" + f.replace(/^src\/routes\//, "").replace(/\/\+(?:server|page\.server)\.\w+$/, "")
      .replace(/\[([^\]]+)\]/g, ":$1").replace(/\(.*?\)\//g, "");
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      if (content.includes(`export async function ${method}`) || content.includes(`export function ${method}`) ||
          content.includes(`export const ${method}`)) {
        routes.push({ method, path: routePath, handler: method, file: f, middleware: [] });
      }
    }
  }

  // FastAPI / Flask / Django (Python)
  const pyFiles = glob.sync("**/*.py", {
    cwd: root,
    ignore: ["venv/**", ".venv/**", "__pycache__/**", "migrations/**"],
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
      routes.push({ method: match[1].toUpperCase(), path: match[2], handler: f, file: f, middleware: [] });
    }

    // Flask: @app.route("/path", methods=["GET"])
    const flaskRegex = /@(?:app|bp|blueprint)\.route\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*methods\s*=\s*\[([^\]]+)\])?\s*\)/gi;
    for (const match of content.matchAll(flaskRegex)) {
      const methods = match[2] ? match[2].replace(/['"]/g, "").split(",").map((m) => m.trim().toUpperCase()) : ["GET"];
      for (const m of methods) {
        routes.push({ method: m, path: match[1], handler: f, file: f, middleware: [] });
      }
    }

    // Django: path('url', view)
    const djangoRegex = /path\s*\(\s*['"]([^'"]*)['"]\s*,\s*(\w+)/g;
    for (const match of content.matchAll(djangoRegex)) {
      routes.push({ method: "ALL", path: "/" + match[1], handler: match[2], file: f, middleware: [] });
    }
  }

  // Go (Gin, Echo, Fiber, Chi)
  const goFiles = glob.sync("**/*.go", {
    cwd: root,
    ignore: ["vendor/**"],
  });

  for (const f of goFiles) {
    let content: string;
    try {
      content = readFileSync(join(root, f), "utf-8");
    } catch {
      continue;
    }

    // Gin: r.GET("/path", handler) or group.POST("/path", handler)
    const ginRegex = /\w+\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(\s*"([^"]+)"/g;
    for (const match of content.matchAll(ginRegex)) {
      routes.push({ method: match[1], path: match[2], handler: f, file: f, middleware: [] });
    }

    // Echo: e.GET("/path", handler)
    const echoRegex = /\w+\.(GET|POST|PUT|PATCH|DELETE)\s*\(\s*"([^"]+)"/g;
    if (content.includes('"github.com/labstack/echo')) {
      for (const match of content.matchAll(echoRegex)) {
        if (!routes.some((r) => r.method === match[1] && r.path === match[2] && r.file === f)) {
          routes.push({ method: match[1], path: match[2], handler: f, file: f, middleware: [] });
        }
      }
    }

    // Fiber: app.Get("/path", handler)
    const fiberRegex = /\w+\.(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"/g;
    if (content.includes('"github.com/gofiber/fiber')) {
      for (const match of content.matchAll(fiberRegex)) {
        routes.push({ method: match[1].toUpperCase(), path: match[2], handler: f, file: f, middleware: [] });
      }
    }

    // Chi: r.Get("/path", handler) or r.Route("/prefix", func)
    const chiRegex = /\w+\.(Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*"([^"]+)"/g;
    if (content.includes('"github.com/go-chi/chi')) {
      for (const match of content.matchAll(chiRegex)) {
        if (!routes.some((r) => r.method === match[1].toUpperCase() && r.path === match[2] && r.file === f)) {
          routes.push({ method: match[1].toUpperCase(), path: match[2], handler: f, file: f, middleware: [] });
        }
      }
    }
  }

  // Ruby (Rails routes.rb)
  const railsRoutesFile = glob.sync("config/routes.rb", { cwd: root });
  if (railsRoutesFile.length > 0) {
    try {
      const content = readFileSync(join(root, railsRoutesFile[0]), "utf-8");
      // get '/path', to: 'controller#action'
      const railsRegex = /(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gi;
      for (const match of content.matchAll(railsRegex)) {
        routes.push({ method: match[1].toUpperCase(), path: match[2], handler: railsRoutesFile[0], file: railsRoutesFile[0], middleware: [] });
      }
      // resources :users (generates RESTful routes)
      const resourcesRegex = /resources?\s+:(\w+)/g;
      for (const match of content.matchAll(resourcesRegex)) {
        const base = "/" + match[1];
        for (const m of ["GET", "POST", "PUT", "DELETE"]) {
          routes.push({ method: m, path: base, handler: `${match[1]}#resource`, file: railsRoutesFile[0], middleware: [] });
        }
      }
    } catch { /* skip */ }
  }

  // Rust (Actix-web, Axum)
  const rsFiles = glob.sync("**/*.rs", {
    cwd: root,
    ignore: ["target/**"],
  });

  for (const f of rsFiles) {
    let content: string;
    try {
      content = readFileSync(join(root, f), "utf-8");
    } catch {
      continue;
    }

    // Actix: #[get("/path")] or web::resource("/path").route(web::get())
    const actixRegex = /#\[(get|post|put|patch|delete)\s*\(\s*"([^"]+)"\s*\)\]/gi;
    for (const match of content.matchAll(actixRegex)) {
      routes.push({ method: match[1].toUpperCase(), path: match[2], handler: f, file: f, middleware: [] });
    }

    // Axum: .route("/path", get(handler))
    const axumRegex = /\.route\s*\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)\s*\(/gi;
    for (const match of content.matchAll(axumRegex)) {
      routes.push({ method: match[2].toUpperCase(), path: match[1], handler: f, file: f, middleware: [] });
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

  const lines: string[] = ["API:"];

  // Deduplicate and group by path
  const grouped = new Map<string, Set<string>>();
  const mwByPath = new Map<string, string[]>();
  for (const r of routes) {
    // Normalize path separators
    const path = r.path.replace(/\\/g, "/");
    if (!grouped.has(path)) grouped.set(path, new Set());
    grouped.get(path)!.add(r.method);
    if (r.middleware.length > 0) {
      mwByPath.set(path, [...new Set([...(mwByPath.get(path) || []), ...r.middleware])]);
    }
  }

  for (const [path, methods] of grouped) {
    const methodStr = [...methods].join(",");
    const mw = mwByPath.get(path);
    let line = `  ${methodStr} ${path}`;
    if (mw && mw.length > 0) line += ` [${mw.join(", ")}]`;
    lines.push(line);
  }

  return lines.join("\n");
}
