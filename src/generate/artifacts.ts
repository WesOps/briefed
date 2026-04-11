import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { glob } from "glob";
import type { FileExtraction } from "../extract/signatures.js";
import type { Route } from "../extract/routes.js";
import type { EnvVar } from "../extract/env.js";
import type { SchemaModel } from "../extract/schema.js";
import type { DepGraph } from "../extract/depgraph.js";
import type { TestMapping } from "../extract/tests.js";

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
  depGraph?: DepGraph,
  testMappings?: TestMapping[],
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

  // Cross-join artifacts — require the dep graph + test mappings
  if (depGraph && testMappings) {
    const routeGraphMd = buildRouteGraph(routes, extractions, schemas, testMappings);
    if (routeGraphMd) {
      writeFileSync(join(artifactsDir, "route-graph.md"), routeGraphMd);
    }

    const impactMd = buildImpactMap(extractions, depGraph, routes, schemas, testMappings);
    if (impactMd) {
      writeFileSync(join(artifactsDir, "impact-map.md"), impactMd);
    }
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

// Word-boundary-ish: require the auth keyword to NOT be followed by another
// letter, so "tokens.ts" (tokenizer utilities), "user-agent.ts" (HTTP plumbing),
// and similar don't get swept in. Still matches "auth.ts", "authService.ts" (the
// "auth" prefix is followed by a capital, which /i treats the same but the
// boundary rule here uses [^a-z] under case-insensitive matching to exclude
// only same-word continuations).
const AUTH_FILE_RE = /(?:auth|session|login|password|oauth|credential)(?![a-z])/i;

/**
 * Build an auth context artifact: auth-related files and session/auth tables.
 *
 * Auth routes and their handler call traces are deliberately NOT included
 * here — route-graph.md covers every route (including auth-tagged ones) with
 * the same call trace + body schema + tests. Duplicating here would make the
 * model see every auth route twice when both artifacts load in the same turn.
 */
function buildAuthContext(
  _routes: Route[],
  extractions: FileExtraction[],
  schemas: SchemaModel[],
): string | null {
  const authFiles = extractions.filter(
    (e) => AUTH_FILE_RE.test(e.path),
  );

  const authTables = schemas.filter(
    (s) => AUTH_FILE_RE.test(s.name),
  );

  if (authFiles.length === 0 && authTables.length === 0) return null;

  const lines: string[] = ["# Authentication Context"];

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

// ─── route graph ──────────────────────────────────────────────────────────────

/**
 * Build the route → handler → call-chain → schema → tests join.
 *
 * For every route, emits one block with the handler's 2-level static call
 * trace, the detected body schema expanded to its fields, and the test file
 * that most likely exercises the handler. Answers "what does POST /api/users
 * actually touch?" in one lookup instead of four.
 */
function buildRouteGraph(
  routes: Route[],
  extractions: FileExtraction[],
  schemas: SchemaModel[],
  testMappings: TestMapping[],
): string | null {
  if (routes.length === 0) return null;

  // Build lookup indices
  const symByName = new Map<string, { file: string; desc: string | null }>();
  const symCalls = new Map<string, string[]>();
  for (const e of extractions) {
    for (const s of e.symbols) {
      if (!s.exported) continue;
      const short = s.name.split(".").pop()!;
      symByName.set(short, { file: e.path, desc: s.description ?? null });
      if (s.calls && s.calls.length > 0) {
        symCalls.set(short, s.calls.map((c) => c.split(".").pop()!));
      }
    }
  }

  const schemaByName = new Map<string, SchemaModel>();
  for (const m of schemas) schemaByName.set(m.name, m);

  // Test mappings indexed by source file — routes' handler file → test file
  const testsByFile = new Map<string, TestMapping>();
  for (const tm of testMappings) testsByFile.set(tm.sourceFile, tm);

  function traceCalls(root: string, depth: number, seen: Set<string>): string[] {
    if (depth === 0) return [];
    if (seen.has(root)) return [];
    seen.add(root);
    const out: string[] = [];
    const calls = symCalls.get(root) ?? [];
    for (const callee of calls.slice(0, 5)) {
      const info = symByName.get(callee);
      const loc = info ? ` \`${info.file}\`` : "";
      const desc = info?.desc ? ` — ${info.desc}` : "";
      const indent = "  ".repeat(3 - depth);
      out.push(`  ${indent}→ \`${callee}\`${loc}${desc}`);
      out.push(...traceCalls(callee, depth - 1, seen));
    }
    return out;
  }

  // Deduplicate routes by (method, path) to avoid emitting the same chain twice
  // when regex overlap catches a route under multiple frameworks.
  const seenKey = new Set<string>();
  const lines: string[] = [
    "# Route Graph",
    "",
    "Every route, its handler chain (2 levels deep, static), request schema fields, and matching test file. One lookup answers \"what does this route touch?\".",
    "",
  ];

  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);

    const tags: string[] = [];
    if (r.auth) tags.push(r.auth);
    if (r.bodySchema) tags.push(`body:${r.bodySchema}`);
    const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";

    lines.push(`## ${r.method} ${r.path}${tagStr}`);
    lines.push(`- file: \`${r.file}\``);
    if (r.handler && r.handler !== r.file && r.handler !== "default") {
      lines.push(`- handler: \`${r.handler}\``);
      const trace = traceCalls(r.handler, 2, new Set());
      if (trace.length > 0) {
        lines.push("- call chain:");
        lines.push(...trace);
      }
    }

    // Body schema → model fields (if detected and known)
    if (r.bodySchema) {
      const stripped = r.bodySchema.replace(/Schema$|Input$|Dto$/i, "");
      const model = schemaByName.get(r.bodySchema) ?? schemaByName.get(stripped);
      if (model) {
        const fields = model.fields
          .slice(0, 6)
          .map((f) => `${f.name}:${f.type}${f.optional ? "?" : ""}`)
          .join(", ");
        lines.push(`- schema fields: ${fields}`);
      }
    }

    // Test mapping: prefer the route's own file, fall back to handler file
    const tm = testsByFile.get(r.file);
    if (tm && tm.testCount > 0) {
      lines.push(`- tests: \`${tm.testFile}\` (${tm.testCount} tests, confidence ${(tm.confidence).toFixed(2)})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── impact map ───────────────────────────────────────────────────────────────

/**
 * Build the changed-file → impacted-surfaces join.
 *
 * For every file with non-trivial fan-in, project its transitive dependents
 * onto (routes, schemas, tests). Answers "if I edit X, which routes and
 * tests are in scope?" without running a second BFS at query time.
 *
 * Capped at top-N files by dependent count to stay under a token budget.
 */
function buildImpactMap(
  extractions: FileExtraction[],
  depGraph: DepGraph,
  routes: Route[],
  schemas: SchemaModel[],
  testMappings: TestMapping[],
): string | null {
  if (extractions.length === 0) return null;

  // Build fast lookups: file → routes defined in it, file → schemas, file → test mapping
  const routesByFile = new Map<string, Route[]>();
  for (const r of routes) {
    const arr = routesByFile.get(r.file) ?? [];
    arr.push(r);
    routesByFile.set(r.file, arr);
  }

  const schemasByFile = new Map<string, SchemaModel[]>();
  for (const s of schemas) {
    const arr = schemasByFile.get(s.source) ?? [];
    arr.push(s);
    schemasByFile.set(s.source, arr);
  }

  const testMapByFile = new Map<string, TestMapping>();
  for (const tm of testMappings) testMapByFile.set(tm.sourceFile, tm);

  // BFS transitive dependents up to a bounded depth. Depgraph's inEdges give
  // direct importers; we walk them breadth-first, capping at MAX_DEPTH. Depth
  // 2 is the sweet spot — deeper bleeds low-level utilities into every test.
  const MAX_DEPTH = 2;
  function transitiveDependents(file: string): Set<string> {
    const visited = new Set<string>([file]);
    const queue: Array<[string, number]> = [[file, 0]];
    while (queue.length > 0) {
      const [cur, depth] = queue.shift()!;
      if (depth >= MAX_DEPTH) continue;
      const node = depGraph.nodes.get(cur);
      if (!node) continue;
      for (const dep of node.inEdges) {
        if (visited.has(dep)) continue;
        visited.add(dep);
        queue.push([dep, depth + 1]);
      }
    }
    visited.delete(file);
    return visited;
  }

  // Rank files by fan-in (how many things transitively depend on them).
  // Cheap proxy: in-edge count. The real transitive count is expensive; this
  // is close enough for "show me the top 30 most-impactful files".
  const ranked = extractions
    .map((e) => {
      const node = depGraph.nodes.get(e.path);
      return { file: e.path, fanIn: node?.inEdges.length ?? 0 };
    })
    .filter((r) => r.fanIn > 0 || routesByFile.has(r.file) || schemasByFile.has(r.file))
    .sort((a, b) => b.fanIn - a.fanIn)
    .slice(0, 30);

  if (ranked.length === 0) return null;

  const lines: string[] = [
    "# Impact Map",
    "",
    "For each high-fan-in file, the routes, schemas, and tests transitively affected by editing it. Answers \"if I change X, what's in scope?\".",
    "",
  ];

  for (const { file, fanIn } of ranked) {
    const deps = transitiveDependents(file);
    // Include the file itself for direct hits
    const scope = new Set([file, ...deps]);

    const hitRoutes: string[] = [];
    const hitSchemas: string[] = [];
    const hitTests = new Set<string>();

    for (const f of scope) {
      const rs = routesByFile.get(f);
      if (rs) for (const r of rs) hitRoutes.push(`${r.method} ${r.path}`);
      const ss = schemasByFile.get(f);
      if (ss) for (const s of ss) hitSchemas.push(s.name);
      const tm = testMapByFile.get(f);
      if (tm) hitTests.add(tm.testFile);
    }

    // Skip files whose impact is just themselves — nothing to report.
    if (hitRoutes.length === 0 && hitSchemas.length === 0 && hitTests.size === 0 && fanIn === 0) {
      continue;
    }

    lines.push(`## \`${file}\``);
    lines.push(`- fan-in: ${fanIn}`);
    if (hitRoutes.length > 0) {
      const uniq = [...new Set(hitRoutes)].slice(0, 10);
      lines.push(`- routes: ${uniq.join(", ")}`);
    }
    if (hitSchemas.length > 0) {
      const uniq = [...new Set(hitSchemas)].slice(0, 10);
      lines.push(`- schemas: ${uniq.join(", ")}`);
    }
    if (hitTests.size > 0) {
      const uniq = [...hitTests].slice(0, 10);
      lines.push(`- tests: ${uniq.join(", ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
