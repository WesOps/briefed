import { describe, it, expect } from "vitest";
import { QUALITY_TASKS } from "./quality-tasks.js";

describe("QUALITY_TASKS", () => {
  it("has exactly 4 tasks", () => {
    expect(QUALITY_TASKS).toHaveLength(4);
  });

  it("every task has a non-empty prompt and a rubric with mustContain", () => {
    for (const t of QUALITY_TASKS) {
      expect(t.name).toMatch(/^[a-z-]+$/);
      expect(t.prompt.length).toBeGreaterThan(20);
      expect(t.rubric.mustContain.length).toBeGreaterThan(0);
      expect(Array.isArray(t.rubric.mustNotHallucinate)).toBe(true);
    }
  });

  it("task names are unique", () => {
    const names = QUALITY_TASKS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("includes the 4 expected tasks", () => {
    const names = QUALITY_TASKS.map((t) => t.name).sort();
    expect(names).toEqual([
      "env-var-audit",
      "explain-architecture",
      "list-routes",
      "trace-auth-flow",
    ]);
  });
});
