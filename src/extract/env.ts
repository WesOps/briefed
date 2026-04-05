import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { glob } from "glob";

export interface EnvVar {
  name: string;
  source: string;        // where it was found
  hasDefault: boolean;
  required: boolean;
  description: string | null;
  category: string;       // "database" | "auth" | "api" | "config" | "other"
}

/**
 * Extract environment variables the project expects.
 * Sources: .env.example, .env.sample, process.env references, config files.
 */
export function extractEnvVars(root: string): EnvVar[] {
  const vars = new Map<string, EnvVar>();

  // 1. Parse .env.example / .env.sample
  const envFiles = [".env.example", ".env.sample", ".env.template", ".env.defaults"];
  for (const ef of envFiles) {
    const path = join(root, ef);
    if (existsSync(path)) {
      parseEnvFile(readFileSync(path, "utf-8"), ef, vars);
    }
  }

  // 2. Scan source files for process.env / os.environ references
  const sourceFiles = glob.sync("**/*.{ts,tsx,js,jsx,py}", {
    cwd: root,
    ignore: ["node_modules/**", "dist/**", "venv/**", ".venv/**", "test/**", "*.test.*"],
  });

  for (const f of sourceFiles) {
    let content: string;
    try {
      content = readFileSync(join(root, f), "utf-8");
    } catch {
      continue;
    }

    // JavaScript/TypeScript: process.env.VAR_NAME
    const jsEnvRegex = /process\.env\.(\w+)/g;
    for (const match of content.matchAll(jsEnvRegex)) {
      addVar(vars, match[1], f, false);
    }

    // JavaScript/TypeScript: process.env['VAR_NAME'] or process.env["VAR_NAME"]
    const jsEnvBracket = /process\.env\[['"](\w+)['"]\]/g;
    for (const match of content.matchAll(jsEnvBracket)) {
      addVar(vars, match[1], f, false);
    }

    // Python: os.environ['VAR'] or os.environ.get('VAR') or os.getenv('VAR')
    const pyEnvRegex = /(?:os\.environ\[['"](\w+)['"]\]|os\.environ\.get\(\s*['"](\w+)['"]|os\.getenv\(\s*['"](\w+)['"])/g;
    for (const match of content.matchAll(pyEnvRegex)) {
      const name = match[1] || match[2] || match[3];
      addVar(vars, name, f, match[0].includes(".get(") || match[0].includes("getenv"));
    }
  }

  // 3. Check config files (next.config, vite.config, etc.)
  const configFiles = glob.sync("{next,vite,nuxt,astro}.config.{ts,js,mjs}", { cwd: root });
  for (const f of configFiles) {
    try {
      const content = readFileSync(join(root, f), "utf-8");
      const envRefs = content.matchAll(/process\.env\.(\w+)/g);
      for (const match of envRefs) {
        addVar(vars, match[1], f, false);
      }
    } catch { /* skip */ }
  }

  return [...vars.values()];
}

function parseEnvFile(content: string, source: string, vars: Map<string, EnvVar>) {
  let lastComment = "";
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      lastComment = trimmed.slice(1).trim();
      continue;
    }
    const match = trimmed.match(/^(\w+)\s*=\s*(.*)/);
    if (match) {
      const name = match[1];
      const value = match[2].trim();
      const hasDefault = value.length > 0 && value !== '""' && value !== "''";

      vars.set(name, {
        name,
        source,
        hasDefault,
        required: !hasDefault,
        description: lastComment || null,
        category: categorizeEnvVar(name),
      });
      lastComment = "";
    }
  }
}

function addVar(vars: Map<string, EnvVar>, name: string, source: string, hasDefault: boolean) {
  if (vars.has(name)) return; // .env.example takes precedence
  // Skip common Node/system vars
  if (["NODE_ENV", "PATH", "HOME", "USER", "PWD", "SHELL", "TERM"].includes(name)) return;

  vars.set(name, {
    name,
    source,
    hasDefault,
    required: !hasDefault,
    description: null,
    category: categorizeEnvVar(name),
  });
}

function categorizeEnvVar(name: string): string {
  const n = name.toUpperCase();
  if (n.includes("DATABASE") || n.includes("DB_") || n.includes("POSTGRES") ||
      n.includes("MYSQL") || n.includes("MONGO") || n.includes("REDIS")) return "database";
  if (n.includes("AUTH") || n.includes("JWT") || n.includes("SESSION") ||
      n.includes("SECRET") || n.includes("OAUTH") || n.includes("TOKEN")) return "auth";
  if (n.includes("API") || n.includes("URL") || n.includes("ENDPOINT") ||
      n.includes("HOST") || n.includes("PORT")) return "api";
  if (n.includes("AWS") || n.includes("S3") || n.includes("CLOUD") ||
      n.includes("STRIPE") || n.includes("SENDGRID") || n.includes("TWILIO")) return "services";
  return "config";
}

/**
 * Format env vars for skeleton inclusion.
 */
export function formatEnvVars(vars: EnvVar[]): string {
  if (vars.length === 0) return "";

  // Only show required vars without defaults — things that will break if missing
  const critical = vars.filter(v => v.required && !v.hasDefault);
  if (critical.length === 0) return "";

  const byCategory = new Map<string, string[]>();
  for (const v of critical) {
    if (!byCategory.has(v.category)) byCategory.set(v.category, []);
    byCategory.get(v.category)!.push(v.name);
  }

  const parts = [...byCategory].map(([cat, names]) => `${cat}: ${names.join(", ")}`);
  return `Required env: ${parts.join(" | ")}`;
}
