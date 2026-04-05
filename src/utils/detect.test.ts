import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { extToLanguage, PARSEABLE_EXTENSIONS, SKIP_DIRS, detectStack } from "./detect.js";

describe("extToLanguage", () => {
  it("maps TypeScript extensions", () => {
    expect(extToLanguage(".ts")).toBe("typescript");
    expect(extToLanguage(".tsx")).toBe("typescript");
  });

  it("maps JavaScript extensions", () => {
    expect(extToLanguage(".js")).toBe("javascript");
    expect(extToLanguage(".jsx")).toBe("javascript");
    expect(extToLanguage(".mjs")).toBe("javascript");
    expect(extToLanguage(".cjs")).toBe("javascript");
  });

  it("maps Python", () => {
    expect(extToLanguage(".py")).toBe("python");
  });

  it("maps Go", () => {
    expect(extToLanguage(".go")).toBe("go");
  });

  it("maps Rust", () => {
    expect(extToLanguage(".rs")).toBe("rust");
  });

  it("maps other languages", () => {
    expect(extToLanguage(".java")).toBe("java");
    expect(extToLanguage(".kt")).toBe("kotlin");
    expect(extToLanguage(".rb")).toBe("ruby");
    expect(extToLanguage(".php")).toBe("php");
    expect(extToLanguage(".swift")).toBe("swift");
    expect(extToLanguage(".scala")).toBe("scala");
    expect(extToLanguage(".ex")).toBe("elixir");
    expect(extToLanguage(".exs")).toBe("elixir");
    expect(extToLanguage(".c")).toBe("c");
    expect(extToLanguage(".h")).toBe("c");
    expect(extToLanguage(".cpp")).toBe("cpp");
    expect(extToLanguage(".cc")).toBe("cpp");
    expect(extToLanguage(".cs")).toBe("csharp");
  });

  it("returns null for unknown extensions", () => {
    expect(extToLanguage(".txt")).toBeNull();
    expect(extToLanguage(".md")).toBeNull();
    expect(extToLanguage(".json")).toBeNull();
    expect(extToLanguage("")).toBeNull();
  });
});

describe("PARSEABLE_EXTENSIONS", () => {
  it("includes common source extensions", () => {
    expect(PARSEABLE_EXTENSIONS.has(".ts")).toBe(true);
    expect(PARSEABLE_EXTENSIONS.has(".tsx")).toBe(true);
    expect(PARSEABLE_EXTENSIONS.has(".js")).toBe(true);
    expect(PARSEABLE_EXTENSIONS.has(".py")).toBe(true);
    expect(PARSEABLE_EXTENSIONS.has(".go")).toBe(true);
    expect(PARSEABLE_EXTENSIONS.has(".rs")).toBe(true);
  });

  it("does not include non-source extensions", () => {
    expect(PARSEABLE_EXTENSIONS.has(".json")).toBe(false);
    expect(PARSEABLE_EXTENSIONS.has(".md")).toBe(false);
    expect(PARSEABLE_EXTENSIONS.has(".yaml")).toBe(false);
    expect(PARSEABLE_EXTENSIONS.has(".html")).toBe(false);
    expect(PARSEABLE_EXTENSIONS.has(".css")).toBe(false);
  });
});

describe("SKIP_DIRS", () => {
  it("includes node_modules and .git", () => {
    expect(SKIP_DIRS.has("node_modules")).toBe(true);
    expect(SKIP_DIRS.has(".git")).toBe(true);
  });

  it("includes common build/dist directories", () => {
    expect(SKIP_DIRS.has("dist")).toBe(true);
    expect(SKIP_DIRS.has("build")).toBe(true);
    expect(SKIP_DIRS.has(".next")).toBe(true);
  });

  it("includes Python virtual environments", () => {
    expect(SKIP_DIRS.has("venv")).toBe(true);
    expect(SKIP_DIRS.has(".venv")).toBe(true);
    expect(SKIP_DIRS.has("__pycache__")).toBe(true);
  });

  it("includes briefed and claude dirs", () => {
    expect(SKIP_DIRS.has(".briefed")).toBe(true);
    expect(SKIP_DIRS.has(".claude")).toBe(true);
  });
});

describe("detectStack", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "briefed-test-detect-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects a Node.js project with npm", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", dependencies: {}, devDependencies: {} })
    );
    const info = detectStack(tmpDir);
    expect(info.languages).toContain("typescript");
    expect(info.languages).toContain("javascript");
    expect(info.packageManager).toBe("npm");
  });

  it("detects pnpm package manager", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    writeFileSync(join(tmpDir, "pnpm-lock.yaml"), "lockfileVersion: 6.0");
    const info = detectStack(tmpDir);
    expect(info.packageManager).toBe("pnpm");
  });

  it("detects yarn package manager", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    writeFileSync(join(tmpDir, "yarn.lock"), "");
    const info = detectStack(tmpDir);
    expect(info.packageManager).toBe("yarn");
  });

  it("detects frameworks from dependencies", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        dependencies: { react: "^18.0.0", next: "^14.0.0" },
        devDependencies: { vitest: "^1.0.0" },
      })
    );
    const info = detectStack(tmpDir);
    expect(info.frameworks).toContain("react");
    expect(info.frameworks).toContain("next.js");
    expect(info.testFramework).toBe("vitest");
  });

  it("detects Go projects", () => {
    writeFileSync(join(tmpDir, "go.mod"), "module example.com/test\n\ngo 1.21\n");
    const info = detectStack(tmpDir);
    expect(info.languages).toContain("go");
  });

  it("detects Python projects", () => {
    writeFileSync(join(tmpDir, "requirements.txt"), "flask==2.0.0\n");
    const info = detectStack(tmpDir);
    expect(info.languages).toContain("python");
  });

  it("detects Rust projects", () => {
    writeFileSync(join(tmpDir, "Cargo.toml"), '[package]\nname = "test"\n');
    const info = detectStack(tmpDir);
    expect(info.languages).toContain("rust");
  });

  it("returns empty info for empty directory", () => {
    const info = detectStack(tmpDir);
    expect(info.languages).toEqual([]);
    expect(info.frameworks).toEqual([]);
    expect(info.packageManager).toBeNull();
  });
});
