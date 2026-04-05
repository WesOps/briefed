import { extractSchemas } from "../extract/schema.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Look up database schema models. Can list all models or drill into a specific one.
 */
export function schemaLookup(root: string, model?: string): CallToolResult {
  const schemas = extractSchemas(root);

  if (schemas.length === 0) {
    return {
      content: [{ type: "text", text: "No database schemas found. Supported ORMs: Prisma, Drizzle, TypeORM, Django, SQLAlchemy." }],
    };
  }

  // List all models
  if (!model) {
    const lines: string[] = [];
    lines.push(`## Database schema (${schemas.length} models)`);
    lines.push("");
    for (const m of schemas) {
      const pk = m.fields.find((f) => f.isPk);
      const relCount = m.relations.length;
      lines.push(`- **${m.name}** — ${m.fields.length} fields${pk ? `, PK: ${pk.name}` : ""}${relCount > 0 ? `, ${relCount} relations` : ""} → \`${m.source}\``);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Find specific model (case-insensitive)
  const match = schemas.find((m) => m.name.toLowerCase() === model.toLowerCase());
  if (!match) {
    const available = schemas.map((m) => m.name).join(", ");
    return {
      content: [{ type: "text", text: `Model "${model}" not found. Available models: ${available}` }],
      isError: true,
    };
  }

  const lines: string[] = [];
  lines.push(`## Model: ${match.name}`);
  lines.push(`Source: \`${match.source}\``);
  lines.push("");

  lines.push("### Fields");
  for (const f of match.fields) {
    const flags: string[] = [];
    if (f.isPk) flags.push("PK");
    if (f.unique) flags.push("unique");
    if (f.optional) flags.push("optional");
    if (f.default !== null) flags.push(`default: ${f.default}`);
    lines.push(`- **${f.name}**: \`${f.type}\`${flags.length > 0 ? ` (${flags.join(", ")})` : ""}`);
  }

  if (match.relations.length > 0) {
    lines.push("");
    lines.push("### Relations");
    for (const r of match.relations) {
      lines.push(`- **${r.field}** → ${r.target} (${r.type})`);
    }
  }

  // Find models that reference this one
  const referencedBy = schemas.filter((m) =>
    m.name !== match.name && m.relations.some((r) => r.target === match.name)
  );
  if (referencedBy.length > 0) {
    lines.push("");
    lines.push("### Referenced by");
    for (const m of referencedBy) {
      const rel = m.relations.find((r) => r.target === match.name)!;
      lines.push(`- **${m.name}**.${rel.field} (${rel.type})`);
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
