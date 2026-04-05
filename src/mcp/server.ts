import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "path";
import { blastRadius } from "./blast-radius.js";
import { schemaLookup } from "./schema-lookup.js";
import { routeDetail } from "./route-detail.js";
import { symbolLookup } from "./symbol-lookup.js";

export async function startMcpServer(repoPath: string) {
  const root = resolve(repoPath);

  const server = new McpServer({
    name: "briefed",
    version: "0.3.0",
  });

  server.tool(
    "briefed_blast_radius",
    "Show what files, routes, and models are affected by changing a file. Uses BFS over the dependency graph to find all transitive dependents.",
    { file: z.string().describe("File path relative to repo root (e.g. src/auth/session.ts)") },
    async ({ file }) => blastRadius(root, file),
  );

  server.tool(
    "briefed_schema",
    "Look up database models, their fields, types, relations, and constraints. Query by model name or list all models.",
    { model: z.string().optional().describe("Model name to look up (omit to list all models)") },
    async ({ model }) => schemaLookup(root, model),
  );

  server.tool(
    "briefed_routes",
    "Look up API routes with their handlers, middleware, and file locations. Filter by method or path pattern.",
    {
      method: z.string().optional().describe("HTTP method filter (GET, POST, PUT, DELETE)"),
      path: z.string().optional().describe("Path pattern to match (e.g. /api/users, /auth)"),
    },
    async ({ method, path }) => routeDetail(root, method, path),
  );

  server.tool(
    "briefed_symbol",
    "Look up a function, class, type, or interface by name. Shows signature, description, which files import it, dependencies, test coverage, and importance ranking.",
    { name: z.string().describe("Symbol name to look up (e.g. extractFile, DepGraph, buildDepGraph)") },
    async ({ name }) => symbolLookup(root, name),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
