import { extractRoutes } from "../extract/routes.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Look up API routes with optional method and path filtering.
 */
export function routeDetail(root: string, method?: string, path?: string): CallToolResult {
  const routes = extractRoutes(root);

  if (routes.length === 0) {
    return {
      content: [{ type: "text", text: "No API routes found. Supported: Express, Fastify, Next.js, Hono, FastAPI, Django." }],
    };
  }

  let filtered = routes;

  if (method) {
    const m = method.toUpperCase();
    filtered = filtered.filter((r) => r.method === m || r.method === "ALL");
  }

  if (path) {
    const pattern = path.toLowerCase();
    filtered = filtered.filter((r) => r.path.toLowerCase().includes(pattern));
  }

  if (filtered.length === 0) {
    const lines = [`No routes match${method ? ` method=${method}` : ""}${path ? ` path=${path}` : ""}.`];
    lines.push("");
    lines.push("Available routes:");
    for (const r of routes.slice(0, 15)) {
      lines.push(`  ${r.method} ${r.path}`);
    }
    if (routes.length > 15) lines.push(`  ... and ${routes.length - 15} more`);
    return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
  }

  const lines: string[] = [];
  const title = method || path
    ? `Routes matching${method ? ` ${method}` : ""}${path ? ` "${path}"` : ""}`
    : `All routes`;
  lines.push(`## ${title} (${filtered.length})`);
  lines.push("");

  // Group by path prefix
  const grouped = new Map<string, typeof filtered>();
  for (const r of filtered) {
    const prefix = "/" + (r.path.split("/")[1] || "");
    if (!grouped.has(prefix)) grouped.set(prefix, []);
    grouped.get(prefix)!.push(r);
  }

  for (const [prefix, groupRoutes] of grouped) {
    lines.push(`### ${prefix}`);
    for (const r of groupRoutes) {
      const tags: string[] = [];
      if (r.auth) tags.push(r.auth);
      if (r.bodySchema) tags.push(`body:${r.bodySchema}`);
      if (r.middleware.length > 0) tags.push(...r.middleware);
      const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
      const handler = r.handler !== "default" ? ` → ${r.handler}` : "";
      lines.push(`- **${r.method}** \`${r.path}\`${handler}${tagStr} — \`${r.file}\``);
    }
    lines.push("");
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
