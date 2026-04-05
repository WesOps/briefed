import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectMonorepo } from "./monorepo.js";

describe("detectMonorepo", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "briefed-test-monorepo-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns isMonorepo=false for a regular project", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "single-package", dependencies: {} })
    );
    const info = detectMonorepo(tmpDir);
    expect(info.isMonorepo).toBe(false);
    expect(info.packages).toEqual([]);
  });

  it("detects npm workspaces", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*"] })
    );
    mkdirSync(join(tmpDir, "packages", "pkg-a"), { recursive: true });
    mkdirSync(join(tmpDir, "packages", "pkg-b"), { recursive: true });
    writeFileSync(
      join(tmpDir, "packages", "pkg-a", "package.json"),
      JSON.stringify({ name: "@scope/pkg-a" })
    );
    writeFileSync(
      join(tmpDir, "packages", "pkg-b", "package.json"),
      JSON.stringify({ name: "@scope/pkg-b" })
    );

    const info = detectMonorepo(tmpDir);
    expect(info.isMonorepo).toBe(true);
    expect(info.packages.length).toBe(2);
    expect(info.packages.map((p) => p.name).sort()).toEqual(["@scope/pkg-a", "@scope/pkg-b"]);
  });

  it("detects yarn workspaces with object syntax", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "root", workspaces: { packages: ["apps/*"] } })
    );
    mkdirSync(join(tmpDir, "apps", "web"), { recursive: true });
    writeFileSync(
      join(tmpDir, "apps", "web", "package.json"),
      JSON.stringify({ name: "web-app" })
    );

    const info = detectMonorepo(tmpDir);
    expect(info.isMonorepo).toBe(true);
    expect(info.packages.length).toBe(1);
    expect(info.packages[0].name).toBe("web-app");
  });

  it("detects pnpm workspaces", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "root" }));
    writeFileSync(
      join(tmpDir, "pnpm-workspace.yaml"),
      `packages:\n  - 'packages/*'\n`
    );
    mkdirSync(join(tmpDir, "packages", "core"), { recursive: true });
    writeFileSync(
      join(tmpDir, "packages", "core", "package.json"),
      JSON.stringify({ name: "@mono/core" })
    );

    const info = detectMonorepo(tmpDir);
    expect(info.isMonorepo).toBe(true);
    expect(info.packages.length).toBeGreaterThanOrEqual(1);
  });

  it("detects Go workspaces", () => {
    writeFileSync(
      join(tmpDir, "go.work"),
      `go 1.21\n\nuse (\n\t./svc-a\n\t./svc-b\n)\n`
    );
    mkdirSync(join(tmpDir, "svc-a"), { recursive: true });
    mkdirSync(join(tmpDir, "svc-b"), { recursive: true });

    const info = detectMonorepo(tmpDir);
    expect(info.isMonorepo).toBe(true);
    expect(info.packages.length).toBe(2);
    expect(info.packages.map((p) => p.name).sort()).toEqual(["svc-a", "svc-b"]);
  });

  it("detects Cargo workspace", () => {
    writeFileSync(
      join(tmpDir, "Cargo.toml"),
      `[workspace]\nmembers = ["crate-a", "crate-b"]\n`
    );
    mkdirSync(join(tmpDir, "crate-a"), { recursive: true });
    mkdirSync(join(tmpDir, "crate-b"), { recursive: true });

    const info = detectMonorepo(tmpDir);
    expect(info.isMonorepo).toBe(true);
    expect(info.packages.length).toBe(2);
  });

  it("identifies current package when cwd is inside a workspace package", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*"] })
    );
    mkdirSync(join(tmpDir, "packages", "frontend"), { recursive: true });
    writeFileSync(
      join(tmpDir, "packages", "frontend", "package.json"),
      JSON.stringify({ name: "frontend" })
    );

    const info = detectMonorepo(join(tmpDir, "packages", "frontend"));
    expect(info.isMonorepo).toBe(true);
    expect(info.currentPackage).not.toBeNull();
    expect(info.currentPackage!.name).toBe("frontend");
  });

  it("returns isMonorepo=false for an empty directory", () => {
    const info = detectMonorepo(tmpDir);
    expect(info.isMonorepo).toBe(false);
    expect(info.packages).toEqual([]);
  });
});
