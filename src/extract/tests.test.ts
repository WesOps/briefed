import { describe, it, expect } from "vitest";
import { extractTestAssertions } from "./tests.js";

describe("extractTestAssertions", () => {
  it("extracts expect() lines from JS/TS it()/test() blocks, mapped by test name", () => {
    const content = `
it('adds numbers', () => {
  const result = add(1, 2);
  expect(result).toBe(3);
  expect(result).not.toBeNull();
});

test('subtracts numbers', () => {
  expect(subtract(5, 3)).toBe(2);
});
`;
    const result = extractTestAssertions(content, ".ts");
    expect(result.get("adds numbers")).toEqual([
      "  expect(result).toBe(3);",
      "  expect(result).not.toBeNull();",
    ]);
    expect(result.get("subtracts numbers")).toEqual([
      "  expect(subtract(5, 3)).toBe(2);",
    ]);
  });

  it("extracts assert lines from Python def test_* functions", () => {
    const content = `
def test_addition():
    result = add(1, 2)
    assert result == 3
    assert result is not None

def test_subtraction():
    assert subtract(5, 3) == 2
`;
    const result = extractTestAssertions(content, ".py");
    expect(result.get("test_addition")).toEqual([
      "    assert result == 3",
      "    assert result is not None",
    ]);
    expect(result.get("test_subtraction")).toEqual([
      "    assert subtract(5, 3) == 2",
    ]);
  });

  it("caps assertions at 5 per test", () => {
    const content = `
it('many assertions', () => {
  expect(a).toBe(1);
  expect(b).toBe(2);
  expect(c).toBe(3);
  expect(d).toBe(4);
  expect(e).toBe(5);
  expect(f).toBe(6);
  expect(g).toBe(7);
});
`;
    const result = extractTestAssertions(content, ".ts");
    const assertions = result.get("many assertions");
    expect(assertions).toBeDefined();
    expect(assertions!.length).toBe(5);
  });

  it("truncates long assertion lines to 120 chars", () => {
    const longValue = "x".repeat(200);
    const content = `
it('long line', () => {
  expect(someFunction()).toBe('${longValue}');
});
`;
    const result = extractTestAssertions(content, ".ts");
    const assertions = result.get("long line");
    expect(assertions).toBeDefined();
    for (const line of assertions!) {
      expect(line.length).toBeLessThanOrEqual(120);
    }
  });

  it("returns empty map when no tests found", () => {
    const content = `
function helper() {
  return 42;
}

const value = helper();
`;
    const result = extractTestAssertions(content, ".ts");
    expect(result.size).toBe(0);
  });

  it("handles nested describe blocks", () => {
    const content = `
describe('math', () => {
  describe('addition', () => {
    it('adds positive numbers', () => {
      expect(add(1, 2)).toBe(3);
    });
  });

  it('top level test', () => {
    expect(true).toBe(true);
  });
});
`;
    const result = extractTestAssertions(content, ".ts");
    expect(result.get("adds positive numbers")).toEqual([
      "      expect(add(1, 2)).toBe(3);",
    ]);
    expect(result.get("top level test")).toEqual([
      "    expect(true).toBe(true);",
    ]);
  });
});
