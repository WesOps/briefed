import { describe, it, expect } from "vitest";
import { buildDeepRules, __test } from "./deep.js";
import type { FileExtraction, Symbol } from "./signatures.js";

const { hashFileForCache, parseBatchResponse, sliceRelevantLines, scoreFile, getGitSignals } = __test;

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
    const { descriptions: result } = parseBatchResponse(raw);
    expect(result.size).toBe(1);
    expect(result.get("src/a.ts")!.get("foo")).toBe("does foo things");
    expect(result.get("src/a.ts")!.get("bar")).toBe("does bar things");
  });

  it("strips markdown code fences", () => {
    const raw = '```json\n{"src/a.ts::foo": "does foo"}\n```';
    const { descriptions: result } = parseBatchResponse(raw);
    expect(result.get("src/a.ts")!.get("foo")).toBe("does foo");
  });

  it("groups symbols under their file", () => {
    const raw = JSON.stringify({
      "src/a.ts::foo": "a foo",
      "src/a.ts::bar": "a bar",
      "src/b.ts::baz": "b baz",
    });
    const { descriptions: result } = parseBatchResponse(raw);
    expect(result.size).toBe(2);
    expect(result.get("src/a.ts")!.size).toBe(2);
    expect(result.get("src/b.ts")!.size).toBe(1);
  });

  it("recovers from surrounding prose", () => {
    const raw =
      'Here is the analysis:\n{"src/a.ts::foo": "does foo"}\nHope that helps!';
    const { descriptions: result } = parseBatchResponse(raw);
    expect(result.get("src/a.ts")!.get("foo")).toBe("does foo");
  });

  it("returns empty map on malformed JSON", () => {
    expect(parseBatchResponse("not json at all").descriptions.size).toBe(0);
  });

  it("ignores entries without the :: separator", () => {
    const raw = JSON.stringify({
      "malformed-key": "skipped",
      "src/a.ts::foo": "kept",
    });
    const { descriptions: result } = parseBatchResponse(raw);
    expect(result.get("src/a.ts")!.get("foo")).toBe("kept");
    expect(result.has("malformed-key")).toBe(false);
  });

  it("parses {description, danger} object values for critical-tier symbols", () => {
    const raw = JSON.stringify({
      "src/a.ts::foo": {
        description: "does foo things",
        danger: "callers depend on return value being non-null",
      },
      "src/a.ts::bar": "does bar things",
    });
    const { descriptions: result } = parseBatchResponse(raw);
    expect(result.get("src/a.ts")!.get("foo")).toBe("does foo things");
    expect(result.get("src/a.ts")!.get("bar")).toBe("does bar things");
  });

  it("extracts danger zones into separate map", () => {
    const raw = JSON.stringify({
      "src/a.ts::foo": {
        description: "does foo things",
        danger: "callers depend on return value",
      },
      "src/a.ts::bar": "simple description",
    });
    const { descriptions, dangerZones } = parseBatchResponse(raw);
    expect(descriptions.get("src/a.ts")!.get("foo")).toBe("does foo things");
    expect(dangerZones.get("src/a.ts")!.get("foo")).toBe("callers depend on return value");
    expect(dangerZones.get("src/a.ts")?.has("bar")).toBeFalsy();
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
  it("scores higher with churn and minor authors than PageRank alone", () => {
    const ext = makeExt("a.ts", []);
    const graph = {
      nodes: new Map(),
      pageRank: new Map([["a.ts", 0.002]]),
      refCounts: new Map([["a.ts", 5]]),
      symbolRefs: new Map(),
    };
    const emptyComplexity = new Map();
    const emptyGit = new Map();
    const noTests = new Set<string>();
    const gitWithChurn = new Map([["a.ts", { commits: 30, minorAuthors: 5 }]]);

    const baseScore = scoreFile(ext, graph, emptyComplexity, emptyGit, noTests);
    const churnScore = scoreFile(ext, graph, emptyComplexity, gitWithChurn, noTests);
    expect(churnScore).toBeGreaterThan(baseScore);
  });

  it("handles missing entries as zero", () => {
    const ext = makeExt("missing.ts", []);
    const graph = {
      nodes: new Map(),
      pageRank: new Map(),
      refCounts: new Map(),
      symbolRefs: new Map(),
    };
    expect(scoreFile(ext, graph, new Map(), new Map(), new Set())).toBe(0);
  });
});

describe("getGitSignals", () => {
  it("returns a map with commit counts for a real git repo", () => {
    // Use the briefed repo itself — it definitely has git history
    const repoRoot = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
    const signals = getGitSignals(repoRoot);
    // Should have at least one entry (briefed has many commits)
    expect(signals.size).toBeGreaterThan(0);
    // Every entry should have a non-negative commit count
    for (const [, s] of signals) {
      expect(s.commits).toBeGreaterThanOrEqual(1);
      expect(s.minorAuthors).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns empty map for a non-git directory", () => {
    const signals = getGitSignals("/tmp");
    expect(signals.size).toBe(0);
  });
});

describe("buildDeepRules", () => {
  it("returns empty map when no danger zones", () => {
    // Rules are now danger-zone-only; no danger zones = no rules (except arch-index)
    const rules = buildDeepRules([], new Map());
    expect(rules.size).toBe(0);
  });

  it("emits rule files only for directories with danger zones", () => {
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
    // Only src/a.ts has a danger zone
    const dangerZones = new Map([
      ["src/a.ts", new Map([["foo", "callers depend on return shape"]])],
    ]);
    const rules = buildDeepRules(extractions, annotations, new Map(), [], undefined, dangerZones);
    // Only src/ gets a rule (has danger), lib/ does not
    const ruleKeys = [...rules.keys()].filter(k => !k.includes("arch-index"));
    expect(ruleKeys.length).toBe(1);
    expect(ruleKeys[0]).toContain("src");
  });

  it("includes path-scoped frontmatter and terse danger format", () => {
    const extractions = [makeExt("src/a.ts", [makeSym("foo", 1)])];
    const annotations = new Map([["src/a.ts", new Map([["foo", "does foo"]])]]);
    const dangerZones = new Map([["src/a.ts", new Map([["foo", "callers depend on return value"]])]]);
    const rules = buildDeepRules(extractions, annotations, new Map(), [], undefined, dangerZones);
    const content = [...rules.values()].find(v => v.includes("foo"));
    expect(content).toBeDefined();
    expect(content).toContain("---");
    expect(content).toContain('paths:');
    expect(content).toContain('- "src/**"');
    expect(content).toContain("callers depend on return value");
    expect(content).toContain("briefed_symbol");
  });

  it("does not include descriptions or callers in rule files", () => {
    const extractions = [makeExt("src/a.ts", [makeSym("foo", 1, { exported: true, calls: ["bar"] })])];
    const annotations = new Map([["src/a.ts", new Map([["foo", "does foo things"]])]]);
    const dangerZones = new Map([["src/a.ts", new Map([["foo", "danger info"]])]]);
    const rules = buildDeepRules(extractions, annotations, new Map(), [], undefined, dangerZones);
    const content = [...rules.values()].find(v => v.includes("foo"));
    expect(content).toBeDefined();
    // Descriptions and call details should NOT be in rules (moved to MCP)
    expect(content).not.toContain("does foo things");
    expect(content).not.toContain("calls:");
  });

  it("omits rule file when no danger annotation exists for directory", () => {
    const ext = makeExt("src/utils/hash.ts", [
      makeSym("hashPassword", 5, { exported: true }),
    ]);
    const annotations = new Map([
      ["src/utils/hash.ts", new Map([["hashPassword", "hashes with bcrypt"]])],
    ]);
    const rules = buildDeepRules([ext], annotations, new Map(), [], undefined, new Map());
    const ruleKeys = [...rules.keys()].filter(k => !k.includes("arch-index"));
    expect(ruleKeys.length).toBe(0);
  });
});
