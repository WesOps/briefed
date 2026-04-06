import { describe, it, expect } from "vitest";
import { buildDeepRules, __test } from "./deep.js";
import type { FileExtraction, Symbol } from "./signatures.js";

const { hashFileForCache, parseBatchResponse, sliceRelevantLines, scoreFile } = __test;

function makeSym(name: string, line: number, opts: Partial<Symbol> = {}): Symbol {
  return {
    name,
    kind: "function",
    signature: `${name}()`,
    exported: true,
    line,
    description: null,
    ...opts,
  };
}

function makeExt(path: string, symbols: Symbol[]): FileExtraction {
  return { path, symbols, imports: [], lineCount: 100 };
}

describe("hashFileForCache", () => {
  it("produces the same hash for identical inputs", () => {
    const syms = [makeSym("foo", 1), makeSym("bar", 5)];
    const h1 = hashFileForCache("content", syms);
    const h2 = hashFileForCache("content", syms);
    expect(h1).toBe(h2);
  });

  it("changes when file content changes", () => {
    const syms = [makeSym("foo", 1)];
    expect(hashFileForCache("v1", syms)).not.toBe(hashFileForCache("v2", syms));
  });

  it("changes when exported symbol set changes", () => {
    const h1 = hashFileForCache("x", [makeSym("foo", 1)]);
    const h2 = hashFileForCache("x", [makeSym("foo", 1), makeSym("bar", 2)]);
    expect(h1).not.toBe(h2);
  });

  it("ignores non-exported symbols in the hash key", () => {
    const h1 = hashFileForCache("x", [makeSym("foo", 1)]);
    const h2 = hashFileForCache("x", [
      makeSym("foo", 1),
      makeSym("internal", 2, { exported: false }),
    ]);
    expect(h1).toBe(h2);
  });
});

describe("parseBatchResponse", () => {
  it("parses a clean JSON object", () => {
    const raw = '{"src/a.ts::foo": "does foo things", "src/a.ts::bar": "does bar things"}';
    const result = parseBatchResponse(raw);
    expect(result.size).toBe(1);
    expect(result.get("src/a.ts")!.get("foo")).toBe("does foo things");
    expect(result.get("src/a.ts")!.get("bar")).toBe("does bar things");
  });

  it("strips markdown code fences", () => {
    const raw = '```json\n{"src/a.ts::foo": "does foo"}\n```';
    const result = parseBatchResponse(raw);
    expect(result.get("src/a.ts")!.get("foo")).toBe("does foo");
  });

  it("groups symbols under their file", () => {
    const raw = JSON.stringify({
      "src/a.ts::foo": "a foo",
      "src/a.ts::bar": "a bar",
      "src/b.ts::baz": "b baz",
    });
    const result = parseBatchResponse(raw);
    expect(result.size).toBe(2);
    expect(result.get("src/a.ts")!.size).toBe(2);
    expect(result.get("src/b.ts")!.size).toBe(1);
  });

  it("recovers from surrounding prose", () => {
    const raw =
      'Here is the analysis:\n{"src/a.ts::foo": "does foo"}\nHope that helps!';
    const result = parseBatchResponse(raw);
    expect(result.get("src/a.ts")!.get("foo")).toBe("does foo");
  });

  it("returns empty map on malformed JSON", () => {
    expect(parseBatchResponse("not json at all").size).toBe(0);
  });

  it("ignores entries without the :: separator", () => {
    const raw = JSON.stringify({
      "malformed-key": "skipped",
      "src/a.ts::foo": "kept",
    });
    const result = parseBatchResponse(raw);
    expect(result.get("src/a.ts")!.get("foo")).toBe("kept");
    expect(result.has("malformed-key")).toBe(false);
  });
});

describe("sliceRelevantLines", () => {
  it("returns windows around each symbol's line", () => {
    const content = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n");
    const out = sliceRelevantLines(content, [makeSym("foo", 10)]);
    expect(out).toContain("line10");
    expect(out).toContain("line11");
    expect(out).not.toContain("line50");
  });

  it("inserts '...' between non-contiguous windows", () => {
    const content = Array.from({ length: 200 }, (_, i) => `line${i + 1}`).join("\n");
    const out = sliceRelevantLines(content, [makeSym("foo", 10), makeSym("bar", 100)]);
    expect(out).toContain("...");
  });

  it("truncates at 180 lines", () => {
    const content = Array.from({ length: 500 }, (_, i) => `line${i + 1}`).join("\n");
    // Use many symbols scattered across the file so the set exceeds 180
    const symbols = Array.from({ length: 20 }, (_, i) => makeSym(`sym${i}`, (i + 1) * 20));
    const out = sliceRelevantLines(content, symbols);
    const lineCount = out.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(181); // 180 + truncation marker
  });
});

describe("scoreFile", () => {
  it("sums PageRank and refCount", () => {
    const ext = makeExt("a.ts", []);
    const graph = {
      nodes: new Map(),
      pageRank: new Map([["a.ts", 0.3]]),
      refCounts: new Map([["a.ts", 5]]),
      symbolRefs: new Map(),
    };
    expect(scoreFile(ext, graph)).toBeCloseTo(5.3);
  });

  it("handles missing entries as zero", () => {
    const ext = makeExt("missing.ts", []);
    const graph = {
      nodes: new Map(),
      pageRank: new Map(),
      refCounts: new Map(),
      symbolRefs: new Map(),
    };
    expect(scoreFile(ext, graph)).toBe(0);
  });
});

describe("buildDeepRules", () => {
  it("returns empty map when no annotations", () => {
    const rules = buildDeepRules([], new Map());
    expect(rules.size).toBe(0);
  });

  it("groups annotated symbols by directory into one rule file per dir", () => {
    const extractions = [
      makeExt("src/a.ts", [makeSym("foo", 1)]),
      makeExt("src/b.ts", [makeSym("bar", 1)]),
      makeExt("lib/c.ts", [makeSym("baz", 1)]),
    ];
    const annotations = new Map([
      ["src/a.ts", new Map([["foo", "does foo"]])],
      ["src/b.ts", new Map([["bar", "does bar"]])],
      ["lib/c.ts", new Map([["baz", "does baz"]])],
    ]);
    const rules = buildDeepRules(extractions, annotations);
    expect(rules.size).toBe(2); // src/ and lib/
    expect([...rules.keys()].some((k) => k.startsWith("briefed-deep-src"))).toBe(true);
    expect([...rules.keys()].some((k) => k.startsWith("briefed-deep-lib"))).toBe(true);
  });

  it("includes path-scoped frontmatter", () => {
    const extractions = [makeExt("src/a.ts", [makeSym("foo", 1)])];
    const annotations = new Map([["src/a.ts", new Map([["foo", "does foo"]])]]);
    const rules = buildDeepRules(extractions, annotations);
    const content = [...rules.values()][0];
    expect(content).toContain("---");
    expect(content).toContain('paths:');
    expect(content).toContain('- "src/**"');
  });

  it("skips files without annotations", () => {
    const extractions = [
      makeExt("src/a.ts", [makeSym("foo", 1)]),
      makeExt("src/b.ts", [makeSym("bar", 1)]),
    ];
    const annotations = new Map([["src/a.ts", new Map([["foo", "does foo"]])]]);
    const rules = buildDeepRules(extractions, annotations);
    const content = [...rules.values()][0];
    expect(content).toContain("foo");
    expect(content).toContain("does foo");
    expect(content).not.toContain("bar");
  });
});
