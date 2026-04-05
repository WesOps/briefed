import { describe, it, expect } from "vitest";
import { countTokens, formatTokens, formatBytes } from "./tokens.js";

describe("countTokens", () => {
  it("returns a positive number for non-empty text", () => {
    expect(countTokens("hello world")).toBeGreaterThan(0);
  });

  it("returns 0 for empty string", () => {
    // Math.ceil(0 / 3.7) = 0
    expect(countTokens("")).toBe(0);
  });

  it("estimates roughly 1 token per 3-4 characters for English", () => {
    const text = "This is a simple English sentence for testing.";
    const tokens = countTokens(text);
    // ~47 chars => expect roughly 10-15 tokens
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(25);
  });

  it("handles multi-byte unicode characters", () => {
    const text = "Hello 🌍🌎🌏";
    const tokens = countTokens(text);
    // Emojis are 4 bytes each, so byte count is higher
    expect(tokens).toBeGreaterThan(countTokens("Hello aaa"));
  });

  it("handles code with symbols", () => {
    const code = `function foo(x: number): boolean { return x > 0; }`;
    const tokens = countTokens(code);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("formatTokens", () => {
  it("formats small numbers as-is", () => {
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands with K suffix", () => {
    expect(formatTokens(1000)).toBe("1.0K");
    expect(formatTokens(1500)).toBe("1.5K");
    expect(formatTokens(10000)).toBe("10.0K");
    expect(formatTokens(123456)).toBe("123.5K");
  });
});

describe("formatBytes", () => {
  it("formats bytes under 1000", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(999)).toBe("999B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1000)).toBe("1.0KB");
    expect(formatBytes(1500)).toBe("1.5KB");
    expect(formatBytes(999_999)).toBe("1000.0KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(1_000_000)).toBe("1.0MB");
    expect(formatBytes(5_500_000)).toBe("5.5MB");
  });
});
