import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseCsv, loadTasks } from "./tasks.js";

describe("parseCsv", () => {
  it("parses simple comma-separated rows", () => {
    expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with embedded commas", () => {
    expect(parseCsv('a,b\n"hello, world",42\n')).toEqual([
      ["a", "b"],
      ["hello, world", "42"],
    ]);
  });

  it("handles quoted fields with embedded newlines", () => {
    expect(parseCsv('a,b\n"line 1\nline 2",end\n')).toEqual([
      ["a", "b"],
      ["line 1\nline 2", "end"],
    ]);
  });

  it("handles escaped quotes inside quoted fields", () => {
    expect(parseCsv('a\n"he said ""hi"""\n')).toEqual([
      ["a"],
      ['he said "hi"'],
    ]);
  });

  it("handles trailing row without newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("loadTasks", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "briefed-polybench-tasks-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const HEADER = "instance_id,repo,base_commit,problem_statement,language,extra";

  it("parses the required columns and skips non-matching languages", () => {
    const csvPath = join(tmpDir, "tasks.csv");
    writeFileSync(
      csvPath,
      `${HEADER}
foo__foo-1,foo/foo,abc123,"fix the bug",TypeScript,ignored
bar__bar-2,bar/bar,def456,"another bug",Python,ignored
baz__baz-3,baz/baz,ghi789,"third bug",TypeScript,ignored
`,
    );

    const tasks = loadTasks(csvPath, "TypeScript");
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toEqual({
      instanceId: "foo__foo-1",
      repo: "foo/foo",
      baseCommit: "abc123",
      problemStatement: "fix the bug",
      language: "TypeScript",
    });
    expect(tasks[1].instanceId).toBe("baz__baz-3");
  });

  it("respects the n limit", () => {
    const csvPath = join(tmpDir, "tasks.csv");
    const rows = [HEADER];
    for (let i = 1; i <= 10; i++) {
      rows.push(`task-${i},org/repo,sha,issue ${i},TypeScript,x`);
    }
    writeFileSync(csvPath, rows.join("\n") + "\n");

    const tasks = loadTasks(csvPath, "TypeScript", 3);
    expect(tasks).toHaveLength(3);
    expect(tasks[0].instanceId).toBe("task-1");
    expect(tasks[2].instanceId).toBe("task-3");
  });

  it("parses problem_statement with embedded newlines and commas", () => {
    const csvPath = join(tmpDir, "tasks.csv");
    writeFileSync(
      csvPath,
      `${HEADER}
tw__tw-1,tailwindlabs/tailwindcss,abc,"Fix flex-1 bug

Steps to reproduce, inline:
1. open browser
2. click button
",TypeScript,x
`,
    );

    const tasks = loadTasks(csvPath, "TypeScript");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].problemStatement).toContain("Steps to reproduce, inline:");
    expect(tasks[0].problemStatement).toContain("1. open browser");
  });

  it("throws a clear error if required columns are missing", () => {
    const csvPath = join(tmpDir, "tasks.csv");
    writeFileSync(csvPath, "wrong,columns,here\n1,2,3\n");
    expect(() => loadTasks(csvPath, "TypeScript")).toThrow(/missing required column/);
  });

  it("throws if the file doesn't exist", () => {
    expect(() => loadTasks(join(tmpDir, "nope.csv"), "TypeScript")).toThrow(
      /tasks CSV not found/,
    );
  });
});
