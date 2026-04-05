import { readFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { glob } from "glob";

export interface Migration {
  name: string;
  file: string;
  timestamp: number;  // ms since epoch, for sorting
  summary: string;    // what the migration does (extracted from content)
}

export function extractMigrations(root: string): Migration[] {
  const migrations: Migration[] = [];

  // Prisma migrations
  const prismaDirs = glob.sync("prisma/migrations/*/", { cwd: root });
  for (const d of prismaDirs) {
    const sqlFile = join(root, d, "migration.sql");
    try {
      const content = readFileSync(sqlFile, "utf-8");
      const dirName = basename(d);
      const timestamp = parseMigrationTimestamp(dirName);
      migrations.push({
        name: dirName,
        file: join(d, "migration.sql"),
        timestamp,
        summary: summarizeSql(content),
      });
    } catch { /* skip */ }
  }

  // Drizzle migrations
  const drizzleMigrations = glob.sync("{drizzle,migrations}/*.sql", { cwd: root });
  for (const f of drizzleMigrations) {
    try {
      const content = readFileSync(join(root, f), "utf-8");
      const name = basename(f, ".sql");
      migrations.push({
        name,
        file: f,
        timestamp: parseMigrationTimestamp(name),
        summary: summarizeSql(content),
      });
    } catch { /* skip */ }
  }

  // Knex / generic migrations
  const knexMigrations = glob.sync("{migrations,db/migrate}/*.{ts,js,sql}", {
    cwd: root,
    ignore: ["node_modules/**"],
  });
  for (const f of knexMigrations) {
    if (migrations.some(m => m.file === f)) continue;
    try {
      const content = readFileSync(join(root, f), "utf-8");
      const name = basename(f).replace(/\.\w+$/, "");
      migrations.push({
        name,
        file: f,
        timestamp: parseMigrationTimestamp(name),
        summary: content.includes("CREATE TABLE") || content.includes("ALTER TABLE")
          ? summarizeSql(content)
          : summarizeJsMigration(content),
      });
    } catch { /* skip */ }
  }

  // Django migrations
  const djangoMigrations = glob.sync("**/migrations/0*.py", {
    cwd: root,
    ignore: ["venv/**", ".venv/**"],
  });
  for (const f of djangoMigrations) {
    try {
      const content = readFileSync(join(root, f), "utf-8");
      const name = basename(f, ".py");
      migrations.push({
        name,
        file: f,
        timestamp: parseMigrationTimestamp(name),
        summary: summarizeDjangoMigration(content),
      });
    } catch { /* skip */ }
  }

  // Sort by timestamp, return only the most recent 5
  migrations.sort((a, b) => b.timestamp - a.timestamp);
  return migrations.slice(0, 5);
}

function parseMigrationTimestamp(name: string): number {
  // Try common patterns: 20240101120000, 2024-01-01, etc.
  const tsMatch = name.match(/(\d{14})/);
  if (tsMatch) {
    const s = tsMatch[1];
    const d = new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(8,10)}:${s.slice(10,12)}:${s.slice(12,14)}Z`);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  const dateMatch = name.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
  if (dateMatch) return new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`).getTime();
  // Sequence number
  const seqMatch = name.match(/^(\d+)/);
  if (seqMatch) return parseInt(seqMatch[1]);
  return 0;
}

function summarizeSql(sql: string): string {
  const actions: string[] = [];
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)/gi)) {
    actions.push(`+${m[1]}`);
  }
  for (const m of sql.matchAll(/ALTER\s+TABLE\s+["'`]?(\w+)["'`]?\s+(ADD|DROP|RENAME|MODIFY)\s+(?:COLUMN\s+)?["'`]?(\w+)/gi)) {
    const op = m[2].toLowerCase() === "add" ? "+" : m[2].toLowerCase() === "drop" ? "-" : "~";
    actions.push(`${m[1]}.${op}${m[3]}`);
  }
  for (const m of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)/gi)) {
    actions.push(`-${m[1]}`);
  }
  for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+["'`]?(\w+)/gi)) {
    actions.push(`idx:${m[1]}`);
  }
  return actions.join(", ") || "schema change";
}

function summarizeJsMigration(content: string): string {
  const actions: string[] = [];
  for (const m of content.matchAll(/createTable\s*\(\s*['"](\w+)['"]/g)) {
    actions.push(`+${m[1]}`);
  }
  for (const m of content.matchAll(/table\.\w+\s*\(\s*['"](\w+)['"]/g)) {
    if (!actions.includes(`+${m[1]}`)) actions.push(`col:${m[1]}`);
  }
  for (const m of content.matchAll(/dropTable\s*\(\s*['"](\w+)['"]/g)) {
    actions.push(`-${m[1]}`);
  }
  return actions.join(", ") || "schema change";
}

function summarizeDjangoMigration(content: string): string {
  const actions: string[] = [];
  for (const m of content.matchAll(/CreateModel\s*\(\s*name\s*=\s*['"](\w+)['"]/g)) {
    actions.push(`+${m[1]}`);
  }
  for (const m of content.matchAll(/AddField\s*\(\s*model_name\s*=\s*['"](\w+)['"].*?name\s*=\s*['"](\w+)['"]/gs)) {
    actions.push(`${m[1]}.+${m[2]}`);
  }
  for (const m of content.matchAll(/RemoveField\s*\(\s*model_name\s*=\s*['"](\w+)['"].*?name\s*=\s*['"](\w+)['"]/gs)) {
    actions.push(`${m[1]}.-${m[2]}`);
  }
  return actions.join(", ") || "schema change";
}

export function formatMigrations(migrations: Migration[]): string {
  if (migrations.length === 0) return "";

  const lines: string[] = ["Recent migrations:"];
  for (const m of migrations) {
    lines.push(`  ${m.name}: ${m.summary}`);
  }
  return lines.join("\n");
}
