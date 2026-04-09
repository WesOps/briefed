import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "path";
import { blastRadius } from "./blast-radius.js";
import { schemaLookup } from "./schema-lookup.js";
import { routeDetail } from "./route-detail.js";
import { symbolLookup } from "./symbol-lookup.js";
import { findUsages } from "./find-usages.js";
import { issueCandidates } from "./issue-candidates.js";
import { testMap } from "./test-map.js";

export async function startMcpServer(repoPath: string) {
  const root = resolve(repoPath);

  const server = new McpServer({
    name: "briefed",
    version: "1.0.0",
  });

  server.tool(
    "briefed_issue_candidates",
    "Given a bug report or task description, returns the top candidate files using keyword matching against pre-indexed symbol names, signatures, and descriptions. Useful for narrowing down where to look before exploring.",
    { issue: z.string().describe("The issue, bug report, or task description") },
    async ({ issue }) => issueCandidates(root, issue),
  );

  server.tool(
    "briefed_symbol",
    "Look up any function, class, type, or interface by name. Returns signature, behavioral description, callers, dependencies, and test coverage. Use instead of Grep when you know the symbol name.",
    { name: z.string().describe("Symbol name (e.g. createUserSession, DepGraph, buildDepGraph)") },
    async ({ name }) => symbolLookup(root, name),
  );

  server.tool(
    "briefed_routes",
    "List all API routes with handlers, middleware, and file locations. Use instead of reading route files — returns all routes instantly from the pre-built index.",
    {
      method: z.string().optional().describe("HTTP method filter (GET, POST, PUT, DELETE)"),
      path: z.string().optional().describe("Path pattern to match (e.g. /api/users, /auth)"),
    },
    async ({ method, path }) => routeDetail(root, method, path),
  );

  server.tool(
    "briefed_schema",
    "List all database models with fields, types, relations, and constraints. Use instead of reading the schema file.",
    { model: z.string().optional().describe("Model name (omit to list all)") },
    async ({ model }) => schemaLookup(root, model),
  );

  server.tool(
    "briefed_find_usages",
    "Find every call site of a symbol with file and line number. Scoped to importing files — much faster and higher-signal than Grep. Use before changing a function to see who calls it.",
    { name: z.string().describe("Exact symbol name (case-sensitive)") },
    async ({ name }) => findUsages(root, name),
  );

  server.tool(
    "briefed_blast_radius",
    "Show all files transitively affected by changing a file, using BFS over the dependency graph. Use before a refactor to understand the full impact.",
    { file: z.string().describe("File path relative to repo root (e.g. src/auth/session.ts)") },
    async ({ file }) => blastRadius(root, file),
  );

  server.tool(
    "briefed_test_map",
    "Look up which test file covers a source file, with test names and count. Use instead of Glob when you need to find or run tests for a file.",
    { file: z.string().optional().describe("Source file path (omit to list all mappings)") },
    async ({ file }) => testMap(root, file),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
