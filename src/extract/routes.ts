import { readFileSync } from "fs";
import { glob } from "glob";
import { join } from "path";

export interface Route {
  method: string;
  path: string;
  handler: string;
  file: string;
  middleware: string[];
  /** Auth requirement detected from middleware or handler body. */
  auth?: "public" | "required" | string | null;
  /** Name of the request body schema, if detected (e.g. "CreateUserSchema"). */
  bodySchema?: string | null;
  /**
   * Match position in the source file (when multiple routes share a file).
   * Used internally to scope auth/schema detection to the right handler chain.
   * Stripped before the routes leave the extractor.
   */
  _matchPos?: number;
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
    ignore: ["node_modules/**", "dist/**", "test/**", "**/*.test.*", "**/*.spec.*"],
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
        _matchPos: match.index,
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
        _matchPos: match.index,
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
            _matchPos: match.index,
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
      routes.push({ method: match[1].toUpperCase(), path: match[2], handler: f, file: f, middleware: [], _matchPos: match.index });
    }

    // Flask: @app.route("/path", methods=["GET"])
    const flaskRegex = /@(?:app|bp|blueprint)\.route\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*methods\s*=\s*\[([^\]]+)\])?\s*\)/gi;
    for (const match of content.matchAll(flaskRegex)) {
      const methods = match[2] ? match[2].replace(/['"]/g, "").split(",").map((m) => m.trim().toUpperCase()) : ["GET"];
      for (const m of methods) {
        routes.push({ method: m, path: match[1], handler: f, file: f, middleware: [], _matchPos: match.index });
      }
    }

    // Django: path('url', view)
    const djangoRegex = /path\s*\(\s*['"]([^'"]*)['"]\s*,\s*(\w+)/g;
    for (const match of content.matchAll(djangoRegex)) {
      routes.push({ method: "ALL", path: "/" + match[1], handler: match[2], file: f, middleware: [], _matchPos: match.index });
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

  // Enrichment pass: detect auth + body schema for each route by inspecting
  // its handler chain. We cache file reads so a file with N routes is only
  // read once. When _matchPos is set (multi-route-per-file frameworks like
  // Express), scope detection to a window starting at the route's match
  // position. Otherwise (single-route-per-file like Next.js route handlers,
  // Remix loaders, SvelteKit endpoints), scan the whole file.
  const ROUTE_WINDOW = 600;
  const fileCache = new Map<string, string>();
  for (const route of routes) {
    let content = fileCache.get(route.file);
    if (content === undefined) {
      try {
        content = readFileSync(join(root, route.file), "utf-8");
      } catch {
        content = "";
      }
      fileCache.set(route.file, content);
    }
    if (!content) continue;
    const scope = route._matchPos !== undefined
      ? content.slice(route._matchPos, route._matchPos + ROUTE_WINDOW)
      : content;
    route.auth = detectAuth(route, scope);
    route.bodySchema = detectBodySchema(scope);
  }

  // Strip internal _matchPos before returning
  for (const r of routes) delete r._matchPos;

  return routes;
}

/**
 * Detect auth requirement for a route. Returns:
 *   "required" — clearly behind auth (middleware or handler body check)
 *   "role:NAME" — gated on a specific role
 *   "public" — explicit public marker (rare)
 *   null — couldn't determine
 */
function detectAuth(route: Route, content: string): string | null {
  // Check the route's own middleware list first
  const authMwPattern = /\b(requireAuth|isAuthenticated|protect|authenticate|withAuth|verifyJWT|verifyToken|jwtAuth|authMiddleware|requireUser|ensureAuthenticated)\b/i;
  for (const mw of route.middleware) {
    if (authMwPattern.test(mw)) return "required";
  }

  // Role-based middleware: requireRole('admin'), hasRole("admin"), authorize('admin')
  const roleMatch = content.match(/\b(?:requireRole|hasRole|authorize|requirePermission|checkRole)\s*\(\s*['"]([^'"]+)['"]/);
  if (roleMatch) return `role:${roleMatch[1]}`;

  // In-body auth checks (for Next.js route handlers, server actions, etc.)
  const inBodyPatterns = [
    /\bawait\s+getServerSession\b/,
    /\bawait\s+auth\s*\(\s*\)/,
    /\bgetToken\s*\(/,
    /\brequireAuth\s*\(/,
    /\bgetCurrentUser\s*\(/,
    /\bsession\.user\b/,
    /\bDepends\s*\(\s*get_current_user\b/, // FastAPI
    /@login_required\b/,                    // Flask/Django
  ];
  for (const p of inBodyPatterns) {
    if (p.test(content)) return "required";
  }

  return null;
}

/**
 * Detect the request body schema name. Looks for common validation patterns:
 *   zValidator(SchemaName)
 *   validate(SchemaName)
 *   validateBody(SchemaName)
 *   SchemaName.parse(...)  / SchemaName.safeParse(...)
 *   body: SchemaName
 */
function detectBodySchema(content: string): string | null {
  const patterns = [
    /\bzValidator\s*\(\s*['"]?(?:json|body|form)['"]?\s*,\s*(\w+Schema|\w+Input|\w+Dto)\b/,
    /\bvalidateBody\s*\(\s*(\w+Schema|\w+Input|\w+Dto)\b/,
    /\bvalidate\s*\(\s*(\w+Schema|\w+Input|\w+Dto)\b/,
    /\b(\w+Schema)\.(?:parse|safeParse)\s*\(/,
    /\bbody\s*:\s*(\w+Schema|\w+Input|\w+Dto)\b/,
    /\bschema\s*:\s*(\w+Schema|\w+Input|\w+Dto)\b/,
  ];
  for (const p of patterns) {
    const m = content.match(p);
    if (m) return m[1];
  }
  return null;
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

  // Deduplicate and group by path; merge auth/schema/middleware across same-path routes.
  interface Agg {
    methods: Set<string>;
    middleware: Set<string>;
    auth: string | null;
    bodySchema: string | null;
  }
  const grouped = new Map<string, Agg>();
  for (const r of routes) {
    const path = r.path.replace(/\\/g, "/");
    let agg = grouped.get(path);
    if (!agg) {
      agg = { methods: new Set(), middleware: new Set(), auth: null, bodySchema: null };
      grouped.set(path, agg);
    }
    agg.methods.add(r.method);
    for (const mw of r.middleware) agg.middleware.add(mw);
    if (r.auth && !agg.auth) agg.auth = r.auth;
    if (r.bodySchema && !agg.bodySchema) agg.bodySchema = r.bodySchema;
  }

  for (const [path, agg] of grouped) {
    const methodStr = [...agg.methods].join(",");
    const tags: string[] = [];
    if (agg.auth) tags.push(agg.auth);
    if (agg.bodySchema) tags.push(`body:${agg.bodySchema}`);
    if (agg.middleware.size > 0) tags.push(...agg.middleware);
    let line = `  ${methodStr} ${path}`;
    if (tags.length > 0) line += ` [${tags.join(", ")}]`;
    lines.push(line);
  }

  return lines.join("\n");
}
