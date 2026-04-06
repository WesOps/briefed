import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findUsages } from "./find-usages.js";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text || "").join("\n");
}

describe("findUsages", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "briefed-find-usages-"));
    mkdirSync(join(tmp, "src"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns isError when symbol does not exist", () => {
    writeFileSync(join(tmp, "src", "a.ts"), "export const x = 1;\n");
    const result = findUsages(tmp, "doesNotExist");
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("No symbol named");
  });

  it("finds call sites in importing files", () => {
    writeFileSync(
      join(tmp, "src", "math.ts"),
      "export function add(a: number, b: number) { return a + b; }\n"
    );
    writeFileSync(
      join(tmp, "src", "caller.ts"),
      [
        'import { add } from "./math.js";',
        "export function compute() {",
        "  const x = add(1, 2);",
        "  const y = add(3, 4);",
        "  return x + y;",
        "}",
        "",
      ].join("\n")
    );
    const result = findUsages(tmp, "add");
    const text = getText(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain("Defined in:");
    expect(text).toContain("src/math.ts");
    expect(text).toContain("src/caller.ts");
    expect(text).toContain("2 call sites");
    // L1 is the import line, which we skip
    expect(text).toContain("L3");
    expect(text).toContain("L4");
  });

  it("skips the import line itself", () => {
    writeFileSync(
      join(tmp, "src", "math.ts"),
      "export function multiply(a: number, b: number) { return a * b; }\n"
    );
    writeFileSync(
      join(tmp, "src", "caller.ts"),
      [
        'import { multiply } from "./math.js";',
        "export const x = multiply(2, 3);",
        "",
      ].join("\n")
    );
    const result = findUsages(tmp, "multiply");
    const text = getText(result);
    expect(text).toContain("1 call site");
    expect(text).not.toContain("L1:");
  });

  it("uses word-boundary matching to avoid substring false positives", () => {
    writeFileSync(
      join(tmp, "src", "lib.ts"),
      "export function add(a: number, b: number) { return a + b; }\n"
    );
    writeFileSync(
      join(tmp, "src", "caller.ts"),
      [
        'import { add } from "./lib.js";',
        "export const padded = add(1, 2);",
        "// addendum here is just a substring",
        "",
      ].join("\n")
    );
    const result = findUsages(tmp, "add");
    const text = getText(result);
    // "padded" and "addendum" both contain "add" as a substring; only the
    // first line is an actual word-boundary match. So we get 1 call site,
    // not 2, and the comment line is not reported.
    expect(text).toContain("1 call site");
    expect(text).toContain("padded");
    expect(text).not.toContain("addendum");
  });
});
