import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseResult } from "./metrics.js";

describe("parseResult", () => {
  it("captures finalAnswer from result event", () => {
    const dir = mkdtempSync(join(tmpdir(), "briefed-bench-test-"));
    const file = join(dir, "t.json");
    const events = [
      { type: "assistant", message: { usage: { input_tokens: 10, output_tokens: 5 }, content: [] } },
      {
        type: "result",
        subtype: "success",
        duration_ms: 1000,
        num_turns: 1,
        result: "Architecture: a 3-tier app.",
        total_cost_usd: 0.01,
        session_id: "abc",
        is_error: false,
      },
    ];
    writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n"));
    const m = parseResult(file);
    expect(m.finalAnswer).toBe("Architecture: a 3-tier app.");
    expect(m.correctness).toBeNull();
  });

  it("finalAnswer empty string when no result field", () => {
    const dir = mkdtempSync(join(tmpdir(), "briefed-bench-test-"));
    const file = join(dir, "t.json");
    writeFileSync(
      file,
      JSON.stringify({ type: "result", subtype: "success", duration_ms: 100, num_turns: 1 }),
    );
    const m = parseResult(file);
    expect(m.finalAnswer).toBe("");
  });
});
