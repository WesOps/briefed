import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { scanFiles } from "./scanner.js";

describe("scanFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "briefed-test-scanner-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("discovers TypeScript files", () => {
    writeFileSync(join(tmpDir, "index.ts"), "export const x = 1;");
    writeFileSync(join(tmpDir, "app.tsx"), "export default function App() {}");
    const result = scanFiles(tmpDir);
    expect(result.totalFiles).toBe(2);
    expect(result.files.map((f) => f.path).sort()).toEqual(["app.tsx", "index.ts"]);
  });

  it("discovers files in subdirectories", () => {
    mkdirSync(join(tmpDir, "src"));
    mkdirSync(join(tmpDir, "src", "utils"));
    writeFileSync(join(tmpDir, "src", "main.ts"), "const a = 1;");
    writeFileSync(join(tmpDir, "src", "utils", "helper.ts"), "const b = 2;");
    const result = scanFiles(tmpDir);
    expect(result.totalFiles).toBe(2);
    expect(result.files.map((f) => f.path)).toContain("src/main.ts");
    expect(result.files.map((f) => f.path)).toContain("src/utils/helper.ts");
  });

  it("skips node_modules directory", () => {
    mkdirSync(join(tmpDir, "node_modules"));
    writeFileSync(join(tmpDir, "node_modules", "dep.js"), "module.exports = {};");
    writeFileSync(join(tmpDir, "index.ts"), "import dep from 'dep';");
    const result = scanFiles(tmpDir);
    expect(result.totalFiles).toBe(1);
    expect(result.files[0].path).toBe("index.ts");
  });

  it("skips .git and other hidden directories", () => {
    mkdirSync(join(tmpDir, ".git"));
    writeFileSync(join(tmpDir, ".git", "config.js"), "");
    mkdirSync(join(tmpDir, ".hidden"));
    writeFileSync(join(tmpDir, ".hidden", "secret.ts"), "");
    writeFileSync(join(tmpDir, "app.ts"), "const x = 1;");
    const result = scanFiles(tmpDir);
    expect(result.totalFiles).toBe(1);
  });

  it("skips non-parseable extensions", () => {
    writeFileSync(join(tmpDir, "readme.md"), "# Hello");
    writeFileSync(join(tmpDir, "data.json"), "{}");
    writeFileSync(join(tmpDir, "style.css"), "body {}");
    writeFileSync(join(tmpDir, "app.ts"), "const x = 1;");
    const result = scanFiles(tmpDir);
    expect(result.totalFiles).toBe(1);
  });

  it("skips files larger than 500KB", () => {
    const largeContent = "x".repeat(600_000);
    writeFileSync(join(tmpDir, "large.ts"), largeContent);
    writeFileSync(join(tmpDir, "small.ts"), "const x = 1;");
    const result = scanFiles(tmpDir);
    expect(result.totalFiles).toBe(1);
    expect(result.files[0].path).toBe("small.ts");
  });

  it("respects .gitignore patterns", () => {
    writeFileSync(join(tmpDir, ".gitignore"), "ignored/\n*.generated.ts\n");
    mkdirSync(join(tmpDir, "ignored"));
    writeFileSync(join(tmpDir, "ignored", "file.ts"), "const x = 1;");
    writeFileSync(join(tmpDir, "output.generated.ts"), "const x = 2;");
    writeFileSync(join(tmpDir, "kept.ts"), "const x = 3;");
    const result = scanFiles(tmpDir);
    expect(result.totalFiles).toBe(1);
    expect(result.files[0].path).toBe("kept.ts");
  });

  it("respects .briefedignore patterns", () => {
    writeFileSync(join(tmpDir, ".briefedignore"), "vendor/\n");
    mkdirSync(join(tmpDir, "vendor"));
    writeFileSync(join(tmpDir, "vendor", "lib.ts"), "");
    writeFileSync(join(tmpDir, "app.ts"), "const x = 1;");
    const result = scanFiles(tmpDir);
    expect(result.totalFiles).toBe(1);
  });

  it("tracks file extensions correctly", () => {
    writeFileSync(join(tmpDir, "a.ts"), "const a = 1;");
    writeFileSync(join(tmpDir, "b.ts"), "const b = 2;");
    writeFileSync(join(tmpDir, "c.js"), "const c = 3;");
    const result = scanFiles(tmpDir);
    expect(result.filesByExtension.get(".ts")).toBe(2);
    expect(result.filesByExtension.get(".js")).toBe(1);
  });

  it("calculates total bytes", () => {
    const content = "export const hello = 'world';";
    writeFileSync(join(tmpDir, "a.ts"), content);
    const result = scanFiles(tmpDir);
    expect(result.totalBytes).toBe(Buffer.byteLength(content, "utf-8"));
  });

  it("returns empty result for empty directory", () => {
    const result = scanFiles(tmpDir);
    expect(result.totalFiles).toBe(0);
    expect(result.files).toEqual([]);
    expect(result.totalBytes).toBe(0);
  });

  it("sets absolutePath correctly on discovered files", () => {
    writeFileSync(join(tmpDir, "index.ts"), "const x = 1;");
    const result = scanFiles(tmpDir);
    expect(result.files[0].absolutePath).toBe(join(tmpDir, "index.ts"));
  });

  it("discovers Python, Go, and Rust files", () => {
    writeFileSync(join(tmpDir, "main.py"), "def hello(): pass");
    writeFileSync(join(tmpDir, "main.go"), "package main");
    writeFileSync(join(tmpDir, "main.rs"), "fn main() {}");
    const result = scanFiles(tmpDir);
    expect(result.totalFiles).toBe(3);
  });
});
