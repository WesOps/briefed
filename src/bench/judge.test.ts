import { describe, it, expect } from "vitest";
import { buildJudgePrompt, parseJudgeResponse } from "./judge.js";
import type { QualityTask } from "./quality-tasks.js";

const sampleTask: QualityTask = {
  name: "env-var-audit",
  prompt: "What env vars does this project read?",
  rubric: {
    mustContain: ["DATABASE_URL", "SESSION_SECRET"],
    mustNotHallucinate: ["NEXT_PUBLIC_FOO"],
  },
};

describe("buildJudgePrompt", () => {
  it("includes question, rubric items, and answer", () => {
    const prompt = buildJudgePrompt(sampleTask, "The env vars are DATABASE_URL and SESSION_SECRET.");
    expect(prompt).toContain("What env vars does this project read?");
    expect(prompt).toContain("DATABASE_URL");
    expect(prompt).toContain("SESSION_SECRET");
    expect(prompt).toContain("NEXT_PUBLIC_FOO");
    expect(prompt).toContain("The env vars are DATABASE_URL and SESSION_SECRET.");
    expect(prompt).toContain("Return strict JSON only");
  });

  it("does not mention arm/briefed/serena labels in the prompt", () => {
    const prompt = buildJudgePrompt(sampleTask, "answer");
    expect(prompt.toLowerCase()).not.toContain("briefed");
    expect(prompt.toLowerCase()).not.toContain("serena");
  });
});

describe("parseJudgeResponse", () => {
  it("parses valid JSON", () => {
    const raw = '{"coverage": 5, "accuracy": 4, "specificity": 3, "overall": 4, "justification": "good"}';
    const result = parseJudgeResponse(raw);
    expect(result).toEqual({
      coverage: 5,
      accuracy: 4,
      specificity: 3,
      overall: 4,
      justification: "good",
    });
  });

  it("strips markdown code fences", () => {
    const raw = '```json\n{"coverage":3,"accuracy":3,"specificity":3,"overall":3,"justification":"mid"}\n```';
    expect(parseJudgeResponse(raw)).not.toBeNull();
  });

  it("returns null on bad JSON", () => {
    expect(parseJudgeResponse("not json")).toBeNull();
  });

  it("returns null when fields are missing", () => {
    expect(parseJudgeResponse('{"coverage": 5}')).toBeNull();
  });

  it("returns null when scores are out of range", () => {
    expect(
      parseJudgeResponse('{"coverage":7,"accuracy":3,"specificity":3,"overall":3,"justification":"x"}'),
    ).toBeNull();
  });

  it("returns null when a score is 0 (out of range low)", () => {
    expect(
      parseJudgeResponse('{"coverage":0,"accuracy":3,"specificity":3,"overall":3,"justification":"x"}'),
    ).toBeNull();
  });

  it("returns null when a score is non-integer", () => {
    expect(
      parseJudgeResponse('{"coverage":3.5,"accuracy":3,"specificity":3,"overall":3,"justification":"x"}'),
    ).toBeNull();
  });

  it("returns null when justification is not a string", () => {
    expect(
      parseJudgeResponse('{"coverage":3,"accuracy":3,"specificity":3,"overall":3,"justification":null}'),
    ).toBeNull();
  });
});
