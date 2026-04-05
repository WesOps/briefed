import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface StackInfo {
  languages: string[];
  frameworks: string[];
  packageManager: string | null;
  entryPoints: string[];
  dbORM: string | null;
  testFramework: string | null;
}

/** Detect the project's tech stack from config files */
export function detectStack(root: string): StackInfo {
  const info: StackInfo = {
    languages: [],
    frameworks: [],
    packageManager: null,
    entryPoints: [],
    dbORM: null,
    testFramework: null,
  };

  // Node.js / TypeScript / JavaScript
  const pkgJsonPath = join(root, "package.json");
  if (existsSync(pkgJsonPath)) {
    info.languages.push("typescript", "javascript");
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    // Package manager
    if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock")))
      info.packageManager = "bun";
    else if (existsSync(join(root, "pnpm-lock.yaml")))
      info.packageManager = "pnpm";
    else if (existsSync(join(root, "yarn.lock")))
      info.packageManager = "yarn";
    else info.packageManager = "npm";

    // Frameworks
    if (allDeps["next"]) info.frameworks.push("next.js");
    if (allDeps["react"]) info.frameworks.push("react");
    if (allDeps["vue"]) info.frameworks.push("vue");
    if (allDeps["svelte"] || allDeps["@sveltejs/kit"])
      info.frameworks.push("svelte");
    if (allDeps["express"]) info.frameworks.push("express");
    if (allDeps["fastify"]) info.frameworks.push("fastify");
    if (allDeps["hono"]) info.frameworks.push("hono");
    if (allDeps["@nestjs/core"]) info.frameworks.push("nestjs");
    if (allDeps["nuxt"]) info.frameworks.push("nuxt");
    if (allDeps["astro"]) info.frameworks.push("astro");
    if (allDeps["remix"] || allDeps["@remix-run/node"])
      info.frameworks.push("remix");

    // DB/ORM
    if (allDeps["prisma"] || allDeps["@prisma/client"])
      info.dbORM = "prisma";
    else if (allDeps["drizzle-orm"]) info.dbORM = "drizzle";
    else if (allDeps["typeorm"]) info.dbORM = "typeorm";
    else if (allDeps["sequelize"]) info.dbORM = "sequelize";
    else if (allDeps["knex"]) info.dbORM = "knex";
    else if (allDeps["mongoose"]) info.dbORM = "mongoose";

    // Test frameworks
    if (allDeps["vitest"]) info.testFramework = "vitest";
    else if (allDeps["jest"]) info.testFramework = "jest";
    else if (allDeps["mocha"]) info.testFramework = "mocha";
    else if (allDeps["playwright"] || allDeps["@playwright/test"])
      info.testFramework = "playwright";

    // Entry points
    if (allDeps["next"]) {
      if (existsSync(join(root, "src/app")))
        info.entryPoints.push("src/app/layout.tsx");
      else if (existsSync(join(root, "app")))
        info.entryPoints.push("app/layout.tsx");
      else info.entryPoints.push("pages/index.tsx");
    }
    if (pkg.main) info.entryPoints.push(pkg.main);
  }

  // Python
  if (
    existsSync(join(root, "pyproject.toml")) ||
    existsSync(join(root, "requirements.txt")) ||
    existsSync(join(root, "setup.py"))
  ) {
    if (!info.languages.includes("python")) info.languages.push("python");
    if (existsSync(join(root, "pyproject.toml"))) {
      const pyproj = readFileSync(join(root, "pyproject.toml"), "utf-8");
      if (pyproj.includes("django")) info.frameworks.push("django");
      if (pyproj.includes("fastapi")) info.frameworks.push("fastapi");
      if (pyproj.includes("flask")) info.frameworks.push("flask");
      if (pyproj.includes("sqlalchemy")) info.dbORM = "sqlalchemy";
      if (pyproj.includes("pytest")) info.testFramework = "pytest";
    }
  }

  // Go
  if (existsSync(join(root, "go.mod"))) {
    info.languages.push("go");
    const gomod = readFileSync(join(root, "go.mod"), "utf-8");
    if (gomod.includes("gin-gonic")) info.frameworks.push("gin");
    if (gomod.includes("echo")) info.frameworks.push("echo");
    if (gomod.includes("fiber")) info.frameworks.push("fiber");
    if (existsSync(join(root, "main.go")))
      info.entryPoints.push("main.go");
    else if (existsSync(join(root, "cmd")))
      info.entryPoints.push("cmd/");
  }

  // Rust
  if (existsSync(join(root, "Cargo.toml"))) {
    info.languages.push("rust");
    if (existsSync(join(root, "src/main.rs")))
      info.entryPoints.push("src/main.rs");
    else if (existsSync(join(root, "src/lib.rs")))
      info.entryPoints.push("src/lib.rs");
  }

  // Java / Kotlin
  if (existsSync(join(root, "pom.xml")) || existsSync(join(root, "build.gradle")) || existsSync(join(root, "build.gradle.kts"))) {
    info.languages.push("java");
  }

  return info;
}

/** Map file extension to language name */
export function extToLanguage(ext: string): string | null {
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cs": "csharp",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".scala": "scala",
    ".ex": "elixir",
    ".exs": "elixir",
  };
  return map[ext] || null;
}

/** File extensions we should parse */
export const PARSEABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java", ".kt",
  ".c", ".h", ".cpp", ".cc",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".scala",
  ".ex", ".exs",
]);

/** Directories to always skip */
export const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "__pycache__", ".pytest_cache", "venv", ".venv", "env",
  "vendor", "target", ".cargo",
  "coverage", ".nyc_output",
  ".briefed", ".claude",
]);
