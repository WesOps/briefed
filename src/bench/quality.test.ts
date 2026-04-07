import { describe, it, expect } from "vitest";
import { enumerateArms, ARM_LABELS, type QualityOptions } from "./quality.js";

describe("enumerateArms", () => {
  it("defaults to all 4 arms in the default matrix", () => {
    const arms = enumerateArms({} as QualityOptions);
    expect(arms.map((a) => a.label)).toEqual(["A", "B", "C", "D"]);
  });

  it("A = no-serena,no-briefed", () => {
    const arms = enumerateArms({} as QualityOptions);
    expect(arms[0]).toEqual({ label: "A", serena: false, briefed: "none" });
  });

  it("D = serena,briefed-deep", () => {
    const arms = enumerateArms({} as QualityOptions);
    expect(arms[3]).toEqual({ label: "D", serena: true, briefed: "deep" });
  });

  it("--arms C,D filters to only the listed arms", () => {
    const arms = enumerateArms({ arms: "C,D" } as QualityOptions);
    expect(arms.map((a) => a.label)).toEqual(["C", "D"]);
  });

  it("--full adds 2 static-briefed arms", () => {
    const arms = enumerateArms({ full: true } as QualityOptions);
    expect(arms.map((a) => a.label).sort()).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(arms.find((a) => a.label === "E")).toEqual({ label: "E", serena: false, briefed: "static" });
    expect(arms.find((a) => a.label === "F")).toEqual({ label: "F", serena: true, briefed: "static" });
  });

  it("ARM_LABELS has a human-readable label for every arm", () => {
    expect(ARM_LABELS.A).toBe("no-serena + no-briefed");
    expect(ARM_LABELS.D).toBe("serena + briefed-deep");
  });
});
