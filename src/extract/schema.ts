import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { glob } from "glob";

export interface SchemaModel {
  name: string;
  fields: SchemaField[];
  relations: SchemaRelation[];
  source: string; // file it came from
}

export interface SchemaField {
  name: string;
  type: string;
  optional: boolean;
  unique: boolean;
  default: string | null;
  isPk: boolean;
}

export interface SchemaRelation {
  field: string;
  target: string;
  type: string; // "one-to-one" | "one-to-many" | "many-to-many"
}

/**
 * Extract database schema from ORM definition files.
 * Supports: Prisma, Drizzle, Django models, SQLAlchemy, TypeORM entities.
 */
export function extractSchemas(root: string): SchemaModel[] {
  const models: SchemaModel[] = [];

  // Prisma
  const prismaFiles = glob.sync("**/schema.prisma", { cwd: root, ignore: ["node_modules/**"] });
  for (const f of prismaFiles) {
    models.push(...parsePrisma(readFileSync(join(root, f), "utf-8"), f));
  }

  // Drizzle
  const drizzleFiles = glob.sync("**/{schema,db}.{ts,js}", { cwd: root, ignore: ["node_modules/**", "dist/**"] });
  for (const f of drizzleFiles) {
    const content = readFileSync(join(root, f), "utf-8");
    if (content.includes("pgTable") || content.includes("mysqlTable") || content.includes("sqliteTable")) {
      models.push(...parseDrizzle(content, f));
    }
  }

  // Django models
  const djangoFiles = glob.sync("**/models.py", { cwd: root, ignore: ["venv/**", ".venv/**"] });
  for (const f of djangoFiles) {
    const content = readFileSync(join(root, f), "utf-8");
    if (content.includes("models.Model")) {
      models.push(...parseDjango(content, f));
    }
  }

  // TypeORM entities
  const typeormFiles = glob.sync("**/*.entity.{ts,js}", { cwd: root, ignore: ["node_modules/**", "dist/**"] });
  for (const f of typeormFiles) {
    models.push(...parseTypeORM(readFileSync(join(root, f), "utf-8"), f));
  }

  return models;
}

function parsePrisma(content: string, source: string): SchemaModel[] {
  const models: SchemaModel[] = [];
  const modelRegex = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;

  for (const match of content.matchAll(modelRegex)) {
    const name = match[1];
    const body = match[2];
    const fields: SchemaField[] = [];
    const relations: SchemaRelation[] = [];

    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("@@")) continue;

      const fieldMatch = trimmed.match(/^(\w+)\s+(\w+)(\[\])?([\?!]?)\s*(.*)/);
      if (fieldMatch) {
        const [, fname, ftype, isArray, optional, rest] = fieldMatch;
        const isRelation = /^[A-Z]/.test(ftype) && ftype !== "String" && ftype !== "Int" &&
          ftype !== "Float" && ftype !== "Boolean" && ftype !== "DateTime" &&
          ftype !== "Json" && ftype !== "Bytes" && ftype !== "BigInt" && ftype !== "Decimal";

        if (isRelation) {
          relations.push({
            field: fname,
            target: ftype,
            type: isArray ? "one-to-many" : "one-to-one",
          });
        } else {
          fields.push({
            name: fname,
            type: isArray ? `${ftype}[]` : ftype,
            optional: optional === "?",
            unique: rest.includes("@unique"),
            default: rest.match(/@default\((.+?)\)/)?.[1] || null,
            isPk: rest.includes("@id"),
          });
        }
      }
    }

    models.push({ name, fields, relations, source });
  }

  return models;
}

function parseDrizzle(content: string, source: string): SchemaModel[] {
  const models: SchemaModel[] = [];
  const tableRegex = /(?:export\s+const\s+)?(\w+)\s*=\s*(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"](\w+)['"]\s*,\s*\{([\s\S]*?)\}\s*\)/g;

  for (const match of content.matchAll(tableRegex)) {
    const varName = match[1];
    const tableName = match[2];
    const body = match[3];
    const fields: SchemaField[] = [];

    const fieldRegex = /(\w+)\s*:\s*(\w+)\s*\(\s*['"]?(\w+)?['"]?\s*\)/g;
    for (const fm of body.matchAll(fieldRegex)) {
      fields.push({
        name: fm[1],
        type: fm[2],
        optional: body.includes(`${fm[1]}`) && body.includes(".default("),
        unique: false,
        default: null,
        isPk: fm[2] === "serial" || body.includes(`${fm[1]}`) && body.includes(".primaryKey()"),
      });
    }

    models.push({ name: tableName, fields, relations: [], source });
  }

  return models;
}

function parseDjango(content: string, source: string): SchemaModel[] {
  const models: SchemaModel[] = [];
  const classRegex = /class\s+(\w+)\s*\(.*?models\.Model.*?\)\s*:([\s\S]*?)(?=\nclass\s|\n\S|$)/g;

  for (const match of content.matchAll(classRegex)) {
    const name = match[1];
    const body = match[2];
    const fields: SchemaField[] = [];
    const relations: SchemaRelation[] = [];

    const fieldRegex = /(\w+)\s*=\s*models\.(\w+)\s*\(/g;
    for (const fm of body.matchAll(fieldRegex)) {
      const fieldType = fm[2];
      if (["ForeignKey", "OneToOneField", "ManyToManyField"].includes(fieldType)) {
        const targetMatch = body.slice(fm.index).match(/models\.\w+\(\s*['"]?(\w+)/);
        relations.push({
          field: fm[1],
          target: targetMatch?.[1] || "unknown",
          type: fieldType === "ManyToManyField" ? "many-to-many" : fieldType === "OneToOneField" ? "one-to-one" : "one-to-many",
        });
      } else {
        fields.push({
          name: fm[1],
          type: fieldType,
          optional: body.includes("null=True") || body.includes("blank=True"),
          unique: body.includes("unique=True"),
          default: null,
          isPk: fieldType === "AutoField" || fm[1] === "id",
        });
      }
    }

    models.push({ name, fields, relations, source });
  }

  return models;
}

function parseTypeORM(content: string, source: string): SchemaModel[] {
  const models: SchemaModel[] = [];
  const classMatch = content.match(/class\s+(\w+)/);
  if (!classMatch) return models;

  const name = classMatch[1];
  const fields: SchemaField[] = [];
  const relations: SchemaRelation[] = [];

  const colRegex = /@(?:Column|PrimaryGeneratedColumn|PrimaryColumn)\s*\(([^)]*)\)\s*\n\s*(\w+)\s*[!?]?\s*:\s*(\w+)/g;
  for (const m of content.matchAll(colRegex)) {
    fields.push({
      name: m[2],
      type: m[3],
      optional: m[0].includes("nullable: true"),
      unique: m[0].includes("unique: true"),
      default: null,
      isPk: m[0].includes("PrimaryGeneratedColumn") || m[0].includes("PrimaryColumn"),
    });
  }

  const relRegex = /@(?:ManyToOne|OneToMany|OneToOne|ManyToMany)\s*\([^)]*\)\s*\n\s*(\w+)\s*[!?]?\s*:\s*(\w+)/g;
  for (const m of content.matchAll(relRegex)) {
    const relType = m[0].includes("ManyToMany") ? "many-to-many" : m[0].includes("OneToMany") ? "one-to-many" : "one-to-one";
    relations.push({ field: m[1], target: m[2], type: relType });
  }

  models.push({ name, fields, relations, source });
  return models;
}

/**
 * Format schemas for skeleton inclusion.
 */
export function formatSchemas(models: SchemaModel[]): string {
  if (models.length === 0) return "";

  const lines: string[] = ["Database schema:"];
  for (const m of models) {
    const fieldList = m.fields
      .map((f) => {
        let s = `${f.name}: ${f.type}`;
        if (f.isPk) s += " (pk)";
        if (f.unique) s += " (unique)";
        if (f.optional) s += "?";
        if (f.default) s += ` = ${f.default}`;
        return s;
      })
      .join(", ");

    const relList = m.relations
      .map((r) => `${r.field} → ${r.target} (${r.type})`)
      .join(", ");

    lines.push(`  ${m.name}: ${fieldList}${relList ? ` | ${relList}` : ""}`);
  }
  return lines.join("\n");
}
