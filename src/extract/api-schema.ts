import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { glob } from "glob";

export interface ApiSchemaInfo {
  type: "openapi" | "graphql";
  file: string;
  version?: string;
  endpoints: ApiSchemaEndpoint[];
  types: string[];
}

export interface ApiSchemaEndpoint {
  method: string;
  path: string;
  summary?: string;
}

/**
 * Extract OpenAPI/Swagger and GraphQL schema information.
 */
export function extractApiSchema(root: string): ApiSchemaInfo[] {
  const schemas: ApiSchemaInfo[] = [];

  // OpenAPI / Swagger
  const openapiFiles = glob.sync("{openapi,swagger,api-spec,api}.{json,yml,yaml}", { cwd: root });
  // Also check docs/ and spec/ directories
  openapiFiles.push(...glob.sync("{docs,spec,api}/**/{openapi,swagger,api-spec}.{json,yml,yaml}", { cwd: root }));

  for (const f of openapiFiles) {
    const fullPath = join(root, f);
    if (!existsSync(fullPath)) continue;
    try {
      const content = readFileSync(fullPath, "utf-8");
      const schema = parseOpenApi(content, f);
      if (schema) schemas.push(schema);
    } catch { /* skip unparseable */ }
  }

  // GraphQL
  const gqlFiles = glob.sync("**/*.{graphql,gql}", {
    cwd: root,
    ignore: ["node_modules/**", "dist/**"],
  });
  // Also check for schema defined in code
  const gqlSchemaFiles = glob.sync("**/schema.{ts,js}", {
    cwd: root,
    ignore: ["node_modules/**", "dist/**", "prisma/**"],
  });

  for (const f of gqlFiles) {
    try {
      const content = readFileSync(join(root, f), "utf-8");
      const schema = parseGraphQL(content, f);
      if (schema) schemas.push(schema);
    } catch { /* skip */ }
  }

  for (const f of gqlSchemaFiles) {
    try {
      const content = readFileSync(join(root, f), "utf-8");
      if (content.includes("gql`") || content.includes("typeDefs") || content.includes("buildSchema")) {
        const schema = parseGraphQLFromCode(content, f);
        if (schema) schemas.push(schema);
      }
    } catch { /* skip */ }
  }

  return schemas;
}

function parseOpenApi(content: string, file: string): ApiSchemaInfo | null {
  const endpoints: ApiSchemaEndpoint[] = [];
  let version: string | undefined;

  // Detect version
  const versionMatch = content.match(/(?:openapi|swagger)\s*[:=]\s*['"]?(\d+\.\d+)/i);
  if (versionMatch) version = versionMatch[1];
  else if (!content.includes("paths") && !content.includes("openapi") && !content.includes("swagger")) return null;

  // Simple extraction: find path-like keys followed by method keys
  const lines = content.split("\n");
  let currentPath = "";
  for (const line of lines) {
    const pathMatch = line.match(/^\s{2,4}['"]?(\/[^'":\s{]+?)['"]?\s*:/);
    if (pathMatch) {
      currentPath = pathMatch[1];
    }
    if (currentPath) {
      const methodMatch = line.match(/^\s{4,8}['"]?(get|post|put|patch|delete)['"]?\s*:/i);
      if (methodMatch) {
        const summaryLine = lines[lines.indexOf(line) + 1] || "";
        const summaryMatch = summaryLine.match(/summary\s*:\s*['"]?(.+?)['"]?\s*$/);
        endpoints.push({
          method: methodMatch[1].toUpperCase(),
          path: currentPath,
          summary: summaryMatch?.[1],
        });
      }
    }
  }

  if (endpoints.length === 0 && !version) return null;

  return { type: "openapi", file, version, endpoints, types: [] };
}

function parseGraphQL(content: string, file: string): ApiSchemaInfo | null {
  const types: string[] = [];
  const endpoints: ApiSchemaEndpoint[] = [];

  // Extract type names
  const typeRegex = /type\s+(\w+)\s*(?:implements\s+\w+)?\s*\{/g;
  for (const m of content.matchAll(typeRegex)) {
    if (!["Query", "Mutation", "Subscription"].includes(m[1])) {
      types.push(m[1]);
    }
  }

  // Extract Query/Mutation fields
  const queryBlockRegex = /type\s+(Query|Mutation)\s*\{([\s\S]*?)\}/g;
  for (const block of content.matchAll(queryBlockRegex)) {
    const kind = block[1];
    const fieldRegex = /(\w+)\s*(?:\([^)]*\))?\s*:\s*(\[?\w+\]?)/g;
    for (const field of block[2].matchAll(fieldRegex)) {
      endpoints.push({
        method: kind === "Query" ? "QUERY" : "MUTATION",
        path: field[1],
        summary: `→ ${field[2]}`,
      });
    }
  }

  if (types.length === 0 && endpoints.length === 0) return null;
  return { type: "graphql", file, endpoints, types };
}

function parseGraphQLFromCode(content: string, file: string): ApiSchemaInfo | null {
  // Extract types from template literals
  const gqlMatch = content.match(/gql\s*`([\s\S]*?)`/);
  if (gqlMatch) return parseGraphQL(gqlMatch[1], file);

  const typeDefsMatch = content.match(/typeDefs\s*=\s*`([\s\S]*?)`/);
  if (typeDefsMatch) return parseGraphQL(typeDefsMatch[1], file);

  return null;
}

export function formatApiSchema(schemas: ApiSchemaInfo[]): string {
  if (schemas.length === 0) return "";

  const lines: string[] = [];
  for (const s of schemas) {
    if (s.type === "openapi") {
      lines.push(`OpenAPI${s.version ? ` v${s.version}` : ""} (${s.file}):`);
      for (const e of s.endpoints.slice(0, 30)) {
        let line = `  ${e.method} ${e.path}`;
        if (e.summary) line += ` — ${e.summary}`;
        lines.push(line);
      }
      if (s.endpoints.length > 30) lines.push(`  ... +${s.endpoints.length - 30} more`);
    } else {
      lines.push(`GraphQL (${s.file}):`);
      if (s.types.length > 0) {
        lines.push(`  Types: ${s.types.join(", ")}`);
      }
      for (const e of s.endpoints.slice(0, 20)) {
        lines.push(`  ${e.method} ${e.path} ${e.summary || ""}`);
      }
    }
  }
  return lines.join("\n");
}
