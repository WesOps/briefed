import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { extractScripts, formatScripts } from "./scripts.js";

describe("extractScripts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "briefed-test-scripts-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts scripts from package.json", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        scripts: {
          build: "tsc",
          dev: "tsc --watch",
          test: "vitest run",
          lint: "eslint .",
          start: "node dist/index.js",
        },
      })
    );
    const scripts = extractScripts(tmpDir);
    expect(scripts.build).toBe("tsc");
    expect(scripts.dev).toBe("tsc --watch");
    expect(scripts.test).toBe("vitest run");
    expect(scripts.lint).toBe("eslint .");
    expect(scripts.start).toBe("node dist/index.js");
  });

  it("extracts deploy and other scripts", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        scripts: {
          deploy: "vercel deploy",
          "db:migrate": "prisma migrate dev",
          generate: "prisma generate",
        },
      })
    );
    const scripts = extractScripts(tmpDir);
    expect(scripts.deploy).toBe("vercel deploy");
    expect(scripts.other["db:migrate"]).toBe("prisma migrate dev");
    expect(scripts.other["generate"]).toBe("prisma generate");
  });

  it("extracts targets from Makefile", () => {
    writeFileSync(
      join(tmpDir, "Makefile"),
      `build:\n\tgo build ./...\n\ntest:\n\tgo test ./...\n\nlint:\n\tgolangci-lint run\n`
    );
    const scripts = extractScripts(tmpDir);
    expect(scripts.build).toBe("make build");
    expect(scripts.test).toBe("make test");
    expect(scripts.lint).toBe("make lint");
  });

  it("prefers package.json scripts over Makefile", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc", test: "vitest" } })
    );
    writeFileSync(join(tmpDir, "Makefile"), `build:\n\tgo build\n\ntest:\n\tgo test\n`);
    const scripts = extractScripts(tmpDir);
    expect(scripts.build).toBe("tsc");
    expect(scripts.test).toBe("vitest");
  });

  it("infers Go scripts from go.mod", () => {
    writeFileSync(join(tmpDir, "go.mod"), `module example.com/test\ngo 1.21\n`);
    const scripts = extractScripts(tmpDir);
    expect(scripts.build).toBe("go build ./...");
    expect(scripts.test).toBe("go test ./...");
  });

  it("infers Rust scripts from Cargo.toml", () => {
    writeFileSync(join(tmpDir, "Cargo.toml"), `[package]\nname = "test"\n`);
    const scripts = extractScripts(tmpDir);
    expect(scripts.build).toBe("cargo build");
    expect(scripts.test).toBe("cargo test");
  });

  it("infers Python test script from pyproject.toml", () => {
    writeFileSync(join(tmpDir, "pyproject.toml"), `[tool.pytest]\n`);
    const scripts = extractScripts(tmpDir);
    expect(scripts.test).toBe("pytest");
  });

  it("returns null for missing scripts", () => {
    const scripts = extractScripts(tmpDir);
    expect(scripts.build).toBeNull();
    expect(scripts.dev).toBeNull();
    expect(scripts.test).toBeNull();
    expect(scripts.lint).toBeNull();
    expect(scripts.start).toBeNull();
    expect(scripts.deploy).toBeNull();
  });
});

describe("formatScripts", () => {
  it("formats scripts as a readable string", () => {
    const output = formatScripts({
      build: "tsc",
      dev: "tsc --watch",
      test: "vitest",
      lint: "eslint .",
      start: null,
      deploy: null,
      other: {},
    });
    expect(output).toContain("Commands:");
    expect(output).toContain("build: tsc");
    expect(output).toContain("dev: tsc --watch");
    expect(output).toContain("test: vitest");
    expect(output).toContain("lint: eslint .");
    expect(output).not.toContain("start:");
    expect(output).not.toContain("deploy:");
  });

  it("returns empty string when no scripts found", () => {
    const output = formatScripts({
      build: null,
      dev: null,
      test: null,
      lint: null,
      start: null,
      deploy: null,
      other: {},
    });
    expect(output).toBe("");
  });
});
