import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { glob } from "glob";
import type { FileExtraction } from "../extract/signatures.js";
import type { Route } from "../extract/routes.js";
import type { EnvVar } from "../extract/env.js";
import type { SchemaModel } from "../extract/schema.js";

/**
 * Generate pre-built task-native artifacts into .briefed/artifacts/.
 * These are injected by the hook classifier when the prompt matches
 * a known task type, letting the agent answer without file exploration.
 */
export function generateArtifacts(
  root: string,
  extractions: FileExtraction[],
  envVars: EnvVar[],
  routes: Route[],
  schemas: SchemaModel[],
): void {
  const artifactsDir = join(root, ".briefed", "artifacts");
  if (!existsSync(artifactsDir)) mkdirSync(artifactsDir, { recursive: true });

  if (envVars.length > 0) {
    writeFileSync(join(artifactsDir, "env-audit.md"), buildEnvAudit(root, envVars));
  }

  const authMd = buildAuthContext(routes, extractions, schemas);
  if (authMd) {
    writeFileSync(join(artifactsDir, "auth-context.md"), authMd);
  }
}

// ─── env audit ────────────────────────────────────────────────────────────────

/**
 * Build a full env audit: every var, required/optional, category, and which
 * files consume it. One call should answer "what env vars does this app need?"
 */
export function buildEnvAudit(root: string, vars: EnvVar[]): string {
  // Scan source files once to build varName → [consuming files] map
  const consumers = new Map<string, string[]>();
  for (const v of vars) consumers.set(v.name, []);

  const sourceFiles = glob.sync("**/*.{ts,tsx,js,jsx,py}", {
    cwd: root,
    ignore: ["node_modules/**", "dist/**", "build/**", "venv/**", ".venv/**"],
  });

  for (const f of sourceFiles) {
    let content: string;
    try { content = readFileSync(join(root, f), "utf-8"); } catch { continue; }
    for (const v of vars) {
      if (content.includes(v.name) && !consumers.get(v.name)!.includes(f)) {
        consumers.get(v.name)!.push(f);
      }
    }
  }

  const required = vars.filter((v) => v.required);
  const optional = vars.filter((v) => !v.required);

  const lines: string[] = ["# Environment Variables"];

  if (required.length > 0) {
    lines.push("", "## Required");
    lines.push("| Variable | Category | Consumer Files | Description |");
    lines.push("|---|---|---|---|");
    for (const v of required) {
      const files = consumers.get(v.name)?.slice(0, 3).join(", ") || v.source;
      const desc = v.description || "";
      lines.push(`| \`${v.name}\` | ${v.category} | ${files} | ${desc} |`);
    }
  }

  if (optional.length > 0) {
    lines.push("", "## Optional");
    lines.push("| Variable | Category | Consumer Files | Description |");
    lines.push("|---|---|---|---|");
    for (const v of optional) {
      const files = consumers.get(v.name)?.slice(0, 3).join(", ") || v.source;
      const desc = v.description || "";
      lines.push(`| \`${v.name}\` | ${v.category} | ${files} | ${desc} |`);
    }
  }

  return lines.join("\n") + "\n";
}

// ─── auth context ─────────────────────────────────────────────────────────────

const AUTH_PATH_RE = /auth|login|logout|session|signup|register|password|token|oauth/i;
const AUTH_FILE_RE = /(?:auth|session|login|password|user|token|oauth|credential)/i;

/**
 * Build an auth context artifact: auth routes, traced call chain 2 levels
 * deep from each handler, key auth files, session tables.
 *
 * The trace is static (based on sym.calls) so it's best-effort — dynamic
 * dispatch and framework magic won't show up, but direct function calls will.
 */
function buildAuthContext(
  routes: Route[],
  extractions: FileExtraction[],
  schemas: SchemaModel[],
): string | null {
  const authRoutes = routes.filter(
    (r) => r.auth !== undefined || AUTH_PATH_RE.test(r.path),
  );

  const authFiles = extractions.filter(
    (e) => AUTH_FILE_RE.test(e.path),
  );

  const authTables = schemas.filter(
    (s) => AUTH_FILE_RE.test(s.name),
  );

  if (authRoutes.length === 0 && authFiles.length === 0) return null;

  // Build a name → symbol lookup for call tracing
  const symByName = new Map<string, { file: string; desc: string | null }>();
  for (const e of extractions) {
    for (const s of e.symbols) {
      if (s.exported) {
        symByName.set(s.name.split(".").pop()!, { file: e.path, desc: s.description ?? null });
      }
    }
  }

  // Build a symbol → calls map for 2-level tracing
  const symCalls = new Map<string, string[]>();
  for (const e of extractions) {
    for (const s of e.symbols) {
      if (s.calls && s.calls.length > 0) {
        symCalls.set(s.name.split(".").pop()!, s.calls.map((c) => c.split(".").pop()!));
      }
    }
  }

  function traceHandler(handler: string, depth: number): string[] {
    if (depth === 0) return [];
    const calls = symCalls.get(handler) ?? [];
    const lines: string[] = [];
    for (const callee of calls.slice(0, 6)) {
      const info = symByName.get(callee);
      const loc = info ? ` (\`${info.file}\`)` : "";
      const desc = info?.desc ? ` — ${info.desc}` : "";
      lines.push(`  ${"  ".repeat(2 - depth)}→ \`${callee}\`${loc}${desc}`);
      lines.push(...traceHandler(callee, depth - 1));
    }
    return lines;
  }

  const lines: string[] = ["# Authentication Context"];

  if (authRoutes.length > 0) {
    lines.push("", "## Auth Routes & Call Traces");
    for (const r of authRoutes) {
      const auth = r.auth ? ` [${r.auth}]` : "";
      lines.push(`- **${r.method}** \`${r.path}\`${auth} — \`${r.file}\``);
      if (r.handler !== "default") {
        lines.push(`  handler: \`${r.handler}\``);
        lines.push(...traceHandler(r.handler, 2));
      }
    }
  }

  if (authFiles.length > 0) {
    lines.push("", "## Auth-Related Files");
    for (const e of authFiles.slice(0, 20)) {
      const exportedFns = e.symbols
        .filter((s) => s.exported && ["function", "method"].includes(s.kind))
        .slice(0, 5)
        .map((s) => {
          const name = s.name.split(".").pop()!;
          return s.description ? `\`${name}\` — ${s.description}` : `\`${name}\``;
        });
      const fnStr = exportedFns.length > 0 ? `: ${exportedFns.join(", ")}` : "";
      lines.push(`- \`${e.path}\`${fnStr}`);
    }
  }

  if (authTables.length > 0) {
    lines.push("", "## Session / Auth Tables");
    for (const t of authTables) {
      const keyFields = t.fields.slice(0, 5).map((f) => `${f.name}: ${f.type}`).join(", ");
      lines.push(`- **${t.name}**: ${keyFields}`);
    }
  }

  return lines.join("\n") + "\n";
}
