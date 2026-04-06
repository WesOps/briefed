import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { extractDeps, formatDeps, __test } from "./deps.js";
import type { FileExtraction } from "./signatures.js";

const { packageNameFromImport, looksPrivate } = __test;

function makeExt(
  path: string,
  imports: Array<{ source: string; isRelative: boolean }>
): FileExtraction {
  return {
    path,
    symbols: [],
    imports: imports.map((imp) => ({
      source: imp.source,
      names: ["default"],
      isRelative: imp.isRelative,
    })),
    lineCount: 10,
  };
}

describe("packageNameFromImport", () => {
  it("returns plain package name", () => {
    expect(packageNameFromImport("stripe")).toBe("stripe");
  });
  it("strips subpath", () => {
    expect(packageNameFromImport("stripe/lib/billing")).toBe("stripe");
  });
  it("preserves scope", () => {
    expect(packageNameFromImport("@stripe/stripe-js")).toBe("@stripe/stripe-js");
  });
  it("strips subpath under scope", () => {
    expect(packageNameFromImport("@stripe/stripe-js/utils")).toBe("@stripe/stripe-js");
  });
  it("returns null for relative paths", () => {
    expect(packageNameFromImport("./foo")).toBe(null);
    expect(packageNameFromImport("/abs/foo")).toBe(null);
  });
  it("returns null for empty string", () => {
    expect(packageNameFromImport("")).toBe(null);
  });
  it("returns null for malformed scope", () => {
    expect(packageNameFromImport("@scopeonly")).toBe(null);
  });
});

describe("looksPrivate", () => {
  it("flags unknown scoped packages as private", () => {
    expect(looksPrivate("@my-org/internal")).toBe(true);
  });
  it("does not flag known public scopes", () => {
    expect(looksPrivate("@types/node")).toBe(false);
    expect(looksPrivate("@modelcontextprotocol/sdk")).toBe(false);
    expect(looksPrivate("@stripe/stripe-js")).toBe(false);
  });
  it("does not flag unscoped packages", () => {
    expect(looksPrivate("stripe")).toBe(false);
    expect(looksPrivate("react")).toBe(false);
  });
});

describe("extractDeps", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "briefed-deps-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when no external imports exist", () => {
    const exts = [makeExt("a.ts", [{ source: "./b", isRelative: true }])];
    const result = extractDeps(tmpDir, exts);
    expect(result.packages).toEqual([]);
  });

  it("counts external imports per package", () => {
    const exts = [
      makeExt("a.ts", [{ source: "stripe", isRelative: false }]),
      makeExt("b.ts", [{ source: "stripe/lib/x", isRelative: false }]),
      makeExt("c.ts", [{ source: "react", isRelative: false }]),
    ];
    const result = extractDeps(tmpDir, exts);
    const stripe = result.packages.find((p) => p.name === "stripe")!;
    const react = result.packages.find((p) => p.name === "react")!;
    expect(stripe.importCount).toBe(2);
    expect(react.importCount).toBe(1);
  });

  it("counts each package once per file even with multiple import statements", () => {
    const exts = [
      makeExt("a.ts", [
        { source: "stripe", isRelative: false },
        { source: "stripe/lib/x", isRelative: false },
        { source: "stripe/lib/y", isRelative: false },
      ]),
    ];
    const result = extractDeps(tmpDir, exts);
    expect(result.packages[0].importCount).toBe(1);
  });

  it("skips Node stdlib imports", () => {
    const exts = [
      makeExt("a.ts", [
        { source: "fs", isRelative: false },
        { source: "node:path", isRelative: false },
        { source: "stripe", isRelative: false },
      ]),
    ];
    const result = extractDeps(tmpDir, exts);
    expect(result.packages.map((p) => p.name)).toEqual(["stripe"]);
  });

  it("resolves versions from root package.json", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        dependencies: { stripe: "^10.17.0" },
      })
    );
    const exts = [makeExt("a.ts", [{ source: "stripe", isRelative: false }])];
    const result = extractDeps(tmpDir, exts);
    expect(result.packages[0].version).toBe("10.17.0");
  });

  it("prefers installed version from node_modules over package.json range", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { stripe: "^10.0.0" } })
    );
    const nm = join(tmpDir, "node_modules", "stripe");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, "package.json"), JSON.stringify({ version: "10.17.4" }));
    const exts = [makeExt("a.ts", [{ source: "stripe", isRelative: false }])];
    const result = extractDeps(tmpDir, exts);
    expect(result.packages[0].version).toBe("10.17.4");
  });

  it("sorts private packages first, then by import count", () => {
    const exts = [
      makeExt("a.ts", [{ source: "react", isRelative: false }]),
      makeExt("b.ts", [{ source: "react", isRelative: false }]),
      makeExt("c.ts", [{ source: "react", isRelative: false }]),
      makeExt("d.ts", [{ source: "@my-org/private", isRelative: false }]),
    ];
    const result = extractDeps(tmpDir, exts);
    expect(result.packages[0].name).toBe("@my-org/private");
    expect(result.packages[0].isPrivate).toBe(true);
    expect(result.packages[1].name).toBe("react");
  });

  it("detects Context7 from .mcp.json", () => {
    writeFileSync(
      join(tmpDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { context7: { command: "x" } } })
    );
    const result = extractDeps(tmpDir, []);
    expect(result.hasContext7).toBe(true);
  });

  it("does not detect Context7 when absent", () => {
    writeFileSync(
      join(tmpDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } } })
    );
    // Override HOME so we don't pick up the dev's user-level settings
    const prev = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const result = extractDeps(tmpDir, []);
      expect(result.hasContext7).toBe(false);
    } finally {
      process.env.HOME = prev;
    }
  });
});

describe("formatDeps", () => {
  it("returns empty string when no packages", () => {
    expect(formatDeps({ packages: [], hasContext7: false })).toBe("");
  });

  it("uses Context7-aware heading when detected", () => {
    const out = formatDeps({
      packages: [{ name: "stripe", version: "10.0.0", importCount: 3, isPrivate: false }],
      hasContext7: true,
    });
    expect(out).toContain("Context7 detected");
  });

  it("uses plain heading when Context7 absent", () => {
    const out = formatDeps({
      packages: [{ name: "stripe", version: "10.0.0", importCount: 3, isPrivate: false }],
      hasContext7: false,
    });
    expect(out).toContain("External deps:");
    expect(out).not.toContain("Context7");
  });

  it("tags private packages", () => {
    const out = formatDeps({
      packages: [{ name: "@my-org/x", version: "1.0.0", importCount: 1, isPrivate: true }],
      hasContext7: false,
    });
    expect(out).toContain("[private]");
  });

  it("omits version tag when version is null", () => {
    const out = formatDeps({
      packages: [{ name: "stripe", version: null, importCount: 1, isPrivate: false }],
      hasContext7: false,
    });
    expect(out).toContain("- stripe — 1 imports");
  });

  it("respects the top limit", () => {
    const packages = Array.from({ length: 20 }, (_, i) => ({
      name: `pkg${i}`,
      version: "1.0.0",
      importCount: 20 - i,
      isPrivate: false,
    }));
    const out = formatDeps({ packages, hasContext7: false }, 5);
    expect(out.split("\n")).toHaveLength(6); // heading + 5
  });
});
