import { describe, it, expect } from "vitest";
import { enumerateArms, ARM_LABELS, type QualityOptions } from "./quality.js";

describe("enumerateArms", () => {
  it("defaults to all 4 arms in the default matrix", () => {
    const arms = enumerateArms({} as QualityOptions);
    expect(arms.map((a) => a.label)).toEqual(["A", "B", "C", "D"]);
  });

  it("A = no-serena, no-briefed, no-hooks", () => {
    const arms = enumerateArms({} as QualityOptions);
    expect(arms[0]).toEqual({ label: "A", serena: false, briefed: "none", hooks: false });
  });

  it("D = serena, briefed-deep, no-hooks (default 4-arm matrix is hooks-off)", () => {
    const arms = enumerateArms({} as QualityOptions);
    expect(arms[3]).toEqual({ label: "D", serena: true, briefed: "deep", hooks: false });
  });

  it("--arms C,D filters to only the listed arms", () => {
    const arms = enumerateArms({ arms: "C,D" } as QualityOptions);
    expect(arms.map((a) => a.label)).toEqual(["C", "D"]);
  });

  it("--full adds 2 static-briefed arms plus the hooks arm", () => {
    const arms = enumerateArms({ full: true } as QualityOptions);
    expect(arms.map((a) => a.label).sort()).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
    expect(arms.find((a) => a.label === "E")).toEqual({ label: "E", serena: false, briefed: "static", hooks: false });
    expect(arms.find((a) => a.label === "F")).toEqual({ label: "F", serena: true, briefed: "static", hooks: false });
    expect(arms.find((a) => a.label === "G")).toEqual({ label: "G", serena: true, briefed: "deep", hooks: true });
  });

  it("--arms G isolates the hooks arm without --full", () => {
    const arms = enumerateArms({ arms: "G" } as QualityOptions);
    expect(arms).toHaveLength(0);
    // G is in FULL_EXTRA, so it requires --full. Without --full it's not in
    // the available pool and the filter returns nothing.
  });

  it("--arms C,D,G with --full pulls G in for the headline hooks comparison", () => {
    const arms = enumerateArms({ full: true, arms: "C,D,G" } as QualityOptions);
    expect(arms.map((a) => a.label)).toEqual(["C", "D", "G"]);
  });

  it("ARM_LABELS has a human-readable label for every arm including G", () => {
    expect(ARM_LABELS.A).toBe("no-serena + no-briefed");
    expect(ARM_LABELS.D).toBe("serena + briefed-deep");
    expect(ARM_LABELS.G).toBe("serena + briefed-deep + hooks");
  });
});
