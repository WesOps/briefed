import { describe, it, expect } from "vitest";
import { formatConventions, type ProjectConventions } from "./conventions.js";

describe("formatConventions", () => {
  it("includes entries from every category in the formatted output", () => {
    // Regression for the v0.4.0 audit bug: `formatConventions` used to spread
    // naming/errorHandling/patterns/imports/other but silently dropped the
    // testing category. The detector populated `testing` (e.g. "test files
    // are colocated", "uses .test.{ext} naming") and the formatter threw
    // them away — that's why epic-stack reported "Detected 5 conventions"
    // but only 3 rendered. This test asserts that every category produces a
    // visible entry, so dropping any future category fails loudly.
    const conv: ProjectConventions = {
      naming: ["camelCase for functions and methods"],
      errorHandling: ["uses try/catch for error handling"],
      patterns: ["prefers named exports over default exports"],
      testing: ["test files are colocated with source files"],
      imports: ["uses #app path alias for absolute imports"],
      other: ["arbitrary other detail"],
    };

    const out = formatConventions(conv);

    expect(out).toContain("camelCase for functions and methods");
    expect(out).toContain("uses try/catch for error handling");
    expect(out).toContain("prefers named exports over default exports");
    expect(out).toContain("test files are colocated with source files");
    expect(out).toContain("uses #app path alias for absolute imports");
    expect(out).toContain("arbitrary other detail");
  });

  it("returns empty string when every category is empty", () => {
    const conv: ProjectConventions = {
      naming: [],
      errorHandling: [],
      patterns: [],
      testing: [],
      imports: [],
      other: [],
    };
    expect(formatConventions(conv)).toBe("");
  });

  it("renders the testing category by itself when nothing else is set", () => {
    const conv: ProjectConventions = {
      naming: [],
      errorHandling: [],
      patterns: [],
      testing: ["uses .test.{ext} naming convention"],
      imports: [],
      other: [],
    };
    const out = formatConventions(conv);
    expect(out).toContain("uses .test.{ext} naming convention");
  });
});
