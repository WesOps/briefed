import { readFileSync, existsSync } from "fs";
import { join } from "path";

export interface ProjectScripts {
  build: string | null;
  dev: string | null;
  test: string | null;
  lint: string | null;
  start: string | null;
  deploy: string | null;
  other: Record<string, string>;
}

/**
 * Extract build/test/dev commands from package.json, Makefile, etc.
 * Claude needs to know how to run things.
 */
export function extractScripts(root: string): ProjectScripts {
  const scripts: ProjectScripts = {
    build: null,
    dev: null,
    test: null,
    lint: null,
    start: null,
    deploy: null,
    other: {},
  };

  // package.json
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const s = pkg.scripts || {};

      scripts.build = s.build || null;
      scripts.dev = s.dev || s.serve || s.start?.includes("--watch") ? (s.dev || s.serve) : null;
      scripts.test = s.test || s["test:unit"] || null;
      scripts.lint = s.lint || s["lint:fix"] || null;
      scripts.start = s.start || null;
      scripts.deploy = s.deploy || s.release || null;

      // Collect other interesting scripts
      for (const [name, cmd] of Object.entries(s)) {
        if (["build", "dev", "test", "lint", "start", "deploy", "serve", "postinstall", "prepare", "precommit"].includes(name)) continue;
        if (typeof cmd === "string" && name.length < 20) {
          scripts.other[name] = cmd as string;
        }
      }
    } catch { /* skip */ }
  }

  // Makefile
  const makefilePath = join(root, "Makefile");
  if (existsSync(makefilePath)) {
    try {
      const content = readFileSync(makefilePath, "utf-8");
      const targets = content.matchAll(/^(\w[\w-]*)\s*:/gm);
      for (const match of targets) {
        const target = match[1];
        if (target === "build" && !scripts.build) scripts.build = `make build`;
        if (target === "test" && !scripts.test) scripts.test = `make test`;
        if (target === "dev" && !scripts.dev) scripts.dev = `make dev`;
        if (target === "lint" && !scripts.lint) scripts.lint = `make lint`;
        if (target === "deploy" && !scripts.deploy) scripts.deploy = `make deploy`;
      }
    } catch { /* skip */ }
  }

  // Go
  if (existsSync(join(root, "go.mod"))) {
    if (!scripts.build) scripts.build = "go build ./...";
    if (!scripts.test) scripts.test = "go test ./...";
  }

  // Rust
  if (existsSync(join(root, "Cargo.toml"))) {
    if (!scripts.build) scripts.build = "cargo build";
    if (!scripts.test) scripts.test = "cargo test";
  }

  // Python
  if (existsSync(join(root, "pyproject.toml"))) {
    if (!scripts.test) scripts.test = "pytest";
  }

  return scripts;
}

/**
 * Format scripts for skeleton inclusion.
 */
export function formatScripts(scripts: ProjectScripts): string {
  const lines: string[] = ["Commands:"];
  if (scripts.build) lines.push(`  build: ${scripts.build}`);
  if (scripts.dev) lines.push(`  dev: ${scripts.dev}`);
  if (scripts.test) lines.push(`  test: ${scripts.test}`);
  if (scripts.lint) lines.push(`  lint: ${scripts.lint}`);
  if (scripts.start) lines.push(`  start: ${scripts.start}`);
  if (scripts.deploy) lines.push(`  deploy: ${scripts.deploy}`);

  if (lines.length === 1) return ""; // no scripts found
  return lines.join("\n");
}
