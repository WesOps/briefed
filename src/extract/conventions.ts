import { readFileSync } from "fs";
import type { FileExtraction } from "./signatures.js";

export interface ProjectConventions {
  naming: string[];          // e.g. "camelCase for variables", "PascalCase for types"
  errorHandling: string[];   // e.g. "uses try/catch with specific error types"
  patterns: string[];        // e.g. "all DB access through prisma client"
  testing: string[];         // e.g. "colocated tests with .test.ts suffix"
  imports: string[];         // e.g. "absolute imports via @/ alias"
  other: string[];           // anything else detected
}

/**
 * Auto-detect project conventions from code patterns.
 * Prevents the "inconsistent code style" problem that compounds across sessions.
 */
export function detectConventions(
  extractions: FileExtraction[],
  root: string
): ProjectConventions {
  const conventions: ProjectConventions = {
    naming: [],
    errorHandling: [],
    patterns: [],
    testing: [],
    imports: [],
    other: [],
  };

  // Sample files for analysis (up to 20 of the most important)
  const sample = extractions
    .filter((e) => e.symbols.length > 0)
    .slice(0, 20);

  if (sample.length === 0) return conventions;

  // Analyze naming conventions
  const allSymbols = sample.flatMap((e) => e.symbols);
  const exportedFunctions = allSymbols.filter(
    (s) => s.exported && (s.kind === "function" || s.kind === "method")
  );
  const exportedTypes = allSymbols.filter(
    (s) => s.exported && (s.kind === "class" || s.kind === "interface" || s.kind === "type")
  );

  if (exportedFunctions.length > 3) {
    const camelCount = exportedFunctions.filter((s) =>
      /^[a-z][a-zA-Z]+$/.test(s.name.split(".").pop()!)
    ).length;
    const snakeCount = exportedFunctions.filter((s) =>
      /^[a-z][a-z_]+$/.test(s.name.split(".").pop()!)
    ).length;

    if (camelCount > snakeCount * 2) {
      conventions.naming.push("camelCase for functions and methods");
    } else if (snakeCount > camelCount * 2) {
      conventions.naming.push("snake_case for functions and methods");
    }
  }

  if (exportedTypes.length > 2) {
    const pascalCount = exportedTypes.filter((s) =>
      /^[A-Z][a-zA-Z]+$/.test(s.name)
    ).length;
    if (pascalCount > exportedTypes.length * 0.7) {
      conventions.naming.push("PascalCase for types, classes, and interfaces");
    }
  }

  // Analyze error handling patterns
  const fileContents = sample.map((e) => {
    try {
      return readFileSync(e.path, "utf-8");
    } catch {
      return "";
    }
  });

  const tryCatchCount = fileContents.filter((c) => c.includes("try {") || c.includes("try:")).length;
  const resultTypeCount = fileContents.filter((c) =>
    c.includes("Result<") || c.includes("Either<") || c.includes("Result[")
  ).length;
  const throwCount = fileContents.filter((c) =>
    c.includes("throw new") || c.includes("raise ")
  ).length;

  if (tryCatchCount > sample.length * 0.3) {
    conventions.errorHandling.push("uses try/catch for error handling");
  }
  if (resultTypeCount > 2) {
    conventions.errorHandling.push("uses Result/Either types for error propagation");
  }
  if (throwCount > sample.length * 0.3) {
    // Check if custom error classes are used
    const customErrors = fileContents.filter((c) =>
      c.match(/class \w+Error extends/)
    ).length;
    if (customErrors > 0) {
      conventions.errorHandling.push("throws custom error classes (not generic Error)");
    }
  }

  // Analyze import patterns
  const allImports = sample.flatMap((e) => e.imports);
  const aliasImports = allImports.filter((i) =>
    i.source.startsWith("@/") || i.source.startsWith("~/") || i.source.startsWith("#")
  );
  if (aliasImports.length > allImports.length * 0.1) {
    const prefix = aliasImports[0]?.source.split("/")[0];
    conventions.imports.push(`uses ${prefix} path alias for absolute imports`);
  }

  const relativeImports = allImports.filter((i) => i.isRelative);
  const absoluteImports = allImports.filter((i) => !i.isRelative);
  if (relativeImports.length > absoluteImports.length * 2) {
    conventions.imports.push("prefers relative imports");
  }

  // Detect testing patterns
  const testFiles = extractions.filter((e) =>
    e.path.includes(".test.") || e.path.includes(".spec.") ||
    e.path.includes("_test.") || e.path.startsWith("test_")
  );
  if (testFiles.length > 0) {
    const colocated = testFiles.filter((t) => {
      const dir = t.path.split("/").slice(0, -1).join("/");
      return sample.some((s) => s.path.split("/").slice(0, -1).join("/") === dir);
    });
    if (colocated.length > testFiles.length * 0.5) {
      conventions.testing.push("test files are colocated with source files");
    } else {
      conventions.testing.push("test files are in separate test/ directory");
    }

    if (testFiles.some((t) => t.path.includes(".test."))) {
      conventions.testing.push("uses .test.{ext} naming convention");
    } else if (testFiles.some((t) => t.path.includes(".spec."))) {
      conventions.testing.push("uses .spec.{ext} naming convention");
    }
  }

  // Detect common architectural patterns
  const hasServices = extractions.some((e) =>
    e.path.includes("/services/") || e.path.includes("/service/")
  );
  const hasControllers = extractions.some((e) =>
    e.path.includes("/controllers/") || e.path.includes("/routes/") ||
    e.path.includes("/api/")
  );

  if (hasServices && hasControllers) {
    conventions.patterns.push("layered architecture: routes/controllers → services");
  }

  // Detect async patterns
  const asyncCount = fileContents.filter((c) =>
    c.includes("async ") || c.includes("await ")
  ).length;
  if (asyncCount > sample.length * 0.5) {
    conventions.patterns.push("predominantly async/await (not callbacks)");
  }

  // Detect export style
  const defaultExports = fileContents.filter((c) =>
    c.includes("export default") || c.includes("module.exports =")
  ).length;
  const namedExports = fileContents.filter((c) =>
    c.includes("export function") || c.includes("export const") || c.includes("export class")
  ).length;

  if (namedExports > defaultExports * 3) {
    conventions.patterns.push("prefers named exports over default exports");
  } else if (defaultExports > namedExports * 2) {
    conventions.patterns.push("uses default exports");
  }

  return conventions;
}

/**
 * Format conventions for inclusion in CLAUDE.md or rules.
 */
export function formatConventions(conv: ProjectConventions): string {
  const lines: string[] = [];
  const all = [
    ...conv.naming,
    ...conv.errorHandling,
    ...conv.patterns,
    ...conv.testing,
    ...conv.imports,
    ...conv.other,
  ];

  if (all.length === 0) return "";

  lines.push("Conventions:");
  for (const c of all) {
    lines.push(`  - ${c}`);
  }
  return lines.join("\n");
}
