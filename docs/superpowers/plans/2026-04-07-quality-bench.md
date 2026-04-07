# Quality Bench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `briefed bench --quality` mode that measures answer correctness (via LLM-as-judge) alongside tokens and speed, across a 4-arm matrix (serena on/off × briefed-deep on/off) run against a pinned commit of `epicweb-dev/epic-stack`.

**Architecture:** New `src/bench/quality.ts` orchestrator wraps four repo-state configurations, runs the existing task loop per arm, then invokes a judging pass (`src/bench/judge.ts`) that scores transcripts against hand-authored rubrics (`src/bench/quality-tasks.ts`). Corpus fetched via `src/bench/corpus.ts` using the already-installed `simple-git`. Repo state snapshotted via `src/bench/repo-state.ts` to guarantee cleanup on any exit path. Shared helpers extracted from `runner.ts` into `src/bench/shared.ts`.

**Tech Stack:** TypeScript (ES2022 modules, strict), Vitest, commander, simple-git, `child_process.spawnSync` for all shell-out (no `exec`/`execSync` in new code — `spawnSync` with array args avoids shell injection and matches the existing `runClaudeTask` pattern).

---

## File Structure

**New files:**
| File | Responsibility |
|---|---|
| `src/bench/shared.ts` | Reusable helpers (strip briefed, detect serena, run claude -p) extracted from runner.ts |
| `src/bench/repo-state.ts` | Snapshot/restore `.claude/`, `CLAUDE.md`, `.briefed/` around arm runs |
| `src/bench/corpus.ts` | Shallow-clone the bench target repo at a pinned SHA, cache on resume |
| `src/bench/quality-tasks.ts` | 4 task prompts + rubrics, keyed by corpus name |
| `src/bench/judge.ts` | Build judge prompt, invoke claude -p, parse strict JSON |
| `src/bench/quality.ts` | 4-arm orchestrator: matrix, run loop, resume, report |
| `src/bench/shared.test.ts` | Unit tests for extracted helpers |
| `src/bench/repo-state.test.ts` | Snapshot/restore tests (tmp dirs) |
| `src/bench/corpus.test.ts` | Corpus prep tests (mocked simple-git) |
| `src/bench/quality-tasks.test.ts` | Rubric shape validation |
| `src/bench/judge.test.ts` | Judge prompt + parse tests |
| `src/bench/quality.test.ts` | Orchestrator tests (arm enumeration) |
| `src/bench/metrics.test.ts` | Tests for new TaskMetrics fields |

**Modified files:**
| File | Change |
|---|---|
| `src/bench/metrics.ts` | Add `correctness` + `finalAnswer` fields to `TaskMetrics`; capture final `result` string in `parseResult` |
| `src/bench/runner.ts` | Import helpers from `shared.ts`, remove the now-extracted definitions |
| `src/commands/bench.ts` | New `--quality` branch + flags |
| `src/cli.ts` | New CLI options on the `bench` command |

---

## Task 1: Extend TaskMetrics with correctness + finalAnswer

**Files:**
- Modify: `src/bench/metrics.ts`
- Create: `src/bench/metrics.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/bench/metrics.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/bench/metrics.test.ts`
Expected: FAIL — `m.finalAnswer` is undefined, `m.correctness` is undefined.

- [ ] **Step 3: Extend the TaskMetrics interface**

In `src/bench/metrics.ts`, add these fields and a new exported type. Insert the `CorrectnessScore` interface immediately above `TaskMetrics`, then add the two new fields to `TaskMetrics`:

```typescript
export interface CorrectnessScore {
  coverage: number;        // 1-5
  accuracy: number;        // 1-5
  specificity: number;     // 1-5
  overall: number;         // 1-5
  justification: string;
}

export interface TaskMetrics {
  // ... existing fields, unchanged ...
  mcpCallsByServer: Record<string, number>;
  /** Final user-visible answer extracted from the transcript's `result` event. */
  finalAnswer: string;
  /** LLM-as-judge score. Null until a judge pass runs. */
  correctness: CorrectnessScore | null;
}
```

- [ ] **Step 4: Populate finalAnswer in parseResult**

In `src/bench/metrics.ts`, inside `parseResult`, after the existing `const num = ...` / `const str = ...` helpers but before the returned object, capture the answer:

```typescript
  const finalAnswer = str(data.result);
```

Then in the returned object add both new fields at the end:

```typescript
    mcpCallsByServer,
    finalAnswer,
    correctness: null,
  };
```

- [ ] **Step 5: Run test, verify pass**

Run: `npx vitest run src/bench/metrics.test.ts`
Expected: 2 tests pass.

- [ ] **Step 6: Run full test suite and type check**

Run: `npm run lint && npm run test`
Expected: all passing. If TypeScript complains about `finalAnswer`/`correctness` missing in other places where `TaskMetrics` is constructed by hand (unlikely — `parseResult` is the only constructor), add them as `finalAnswer: ""` and `correctness: null`.

- [ ] **Step 7: Commit**

```bash
git add src/bench/metrics.ts src/bench/metrics.test.ts
git commit -m "feat(bench): capture finalAnswer and add correctness slot to TaskMetrics"
```

---

## Task 2: RepoState snapshot/restore helper

**Files:**
- Create: `src/bench/repo-state.ts`
- Create: `src/bench/repo-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/bench/repo-state.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { snapshotRepoState, restoreRepoState } from "./repo-state.js";

describe("RepoState", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "briefed-state-test-"));
    mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
    mkdirSync(join(repo, ".briefed"), { recursive: true });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("restores CLAUDE.md, settings.json, rules/, .briefed/ to snapshot state", () => {
    writeFileSync(join(repo, "CLAUDE.md"), "original\n");
    writeFileSync(join(repo, ".claude", "settings.json"), '{"original":true}');
    writeFileSync(join(repo, ".claude", "rules", "r.md"), "orig-rule");
    writeFileSync(join(repo, ".briefed", "skeleton.md"), "orig-skel");

    const state = snapshotRepoState(repo);

    writeFileSync(join(repo, "CLAUDE.md"), "mutated\n");
    writeFileSync(join(repo, ".claude", "settings.json"), '{"mutated":true}');
    writeFileSync(join(repo, ".claude", "rules", "r.md"), "mut-rule");
    writeFileSync(join(repo, ".claude", "rules", "new.md"), "added");
    writeFileSync(join(repo, ".briefed", "skeleton.md"), "mut-skel");

    restoreRepoState(state);

    expect(readFileSync(join(repo, "CLAUDE.md"), "utf-8")).toBe("original\n");
    expect(readFileSync(join(repo, ".claude", "settings.json"), "utf-8")).toBe('{"original":true}');
    expect(readFileSync(join(repo, ".claude", "rules", "r.md"), "utf-8")).toBe("orig-rule");
    expect(existsSync(join(repo, ".claude", "rules", "new.md"))).toBe(false);
    expect(readFileSync(join(repo, ".briefed", "skeleton.md"), "utf-8")).toBe("orig-skel");
  });

  it("restores missing files to missing state", () => {
    const state = snapshotRepoState(repo);
    writeFileSync(join(repo, "CLAUDE.md"), "created-after-snapshot");
    restoreRepoState(state);
    expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);
  });

  it("excludes the quality bench output dir from the .briefed snapshot", () => {
    mkdirSync(join(repo, ".briefed", "bench", "quality"), { recursive: true });
    writeFileSync(join(repo, ".briefed", "bench", "quality", "should-survive.txt"), "keep-me");
    writeFileSync(join(repo, ".briefed", "skeleton.md"), "orig");

    const state = snapshotRepoState(repo);
    writeFileSync(join(repo, ".briefed", "skeleton.md"), "mut");
    writeFileSync(join(repo, ".briefed", "bench", "quality", "new.txt"), "also-keep");
    restoreRepoState(state);

    expect(readFileSync(join(repo, ".briefed", "skeleton.md"), "utf-8")).toBe("orig");
    expect(existsSync(join(repo, ".briefed", "bench", "quality", "should-survive.txt"))).toBe(true);
    expect(existsSync(join(repo, ".briefed", "bench", "quality", "new.txt"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/bench/repo-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement repo-state.ts**

Create `src/bench/repo-state.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * Snapshot of everything the quality bench might mutate. Excludes the
 * bench output directory (.briefed/bench/quality) itself so results
 * accumulated during the run survive restore.
 */
export interface RepoStateSnapshot {
  repo: string;
  files: Map<string, string | null>;
  dirs: Map<string, Map<string, string>>;
  absentDirs: Set<string>;
}

const TRACKED_FILES = ["CLAUDE.md", ".claude/settings.json"];
const TRACKED_DIRS = [".claude/rules", ".briefed"];
const SNAPSHOT_EXCLUDE_PREFIXES = [".briefed/bench/quality"];

export function snapshotRepoState(repo: string): RepoStateSnapshot {
  const files = new Map<string, string | null>();
  for (const rel of TRACKED_FILES) {
    const p = join(repo, rel);
    files.set(rel, existsSync(p) ? readFileSync(p, "utf-8") : null);
  }

  const dirs = new Map<string, Map<string, string>>();
  const absentDirs = new Set<string>();
  for (const rel of TRACKED_DIRS) {
    const p = join(repo, rel);
    if (!existsSync(p)) {
      absentDirs.add(rel);
      continue;
    }
    dirs.set(rel, snapshotDir(repo, p));
  }

  return { repo, files, dirs, absentDirs };
}

function snapshotDir(repo: string, absDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative(repo, full);
      if (SNAPSHOT_EXCLUDE_PREFIXES.some((p) => rel === p || rel.startsWith(p + "/"))) continue;
      const s = statSync(full);
      if (s.isDirectory()) walk(full);
      else if (s.isFile()) out.set(rel, readFileSync(full, "utf-8"));
    }
  };
  walk(absDir);
  return out;
}

export function restoreRepoState(state: RepoStateSnapshot): void {
  for (const [rel, content] of state.files) {
    const p = join(state.repo, rel);
    if (content === null) {
      if (existsSync(p)) rmSync(p, { force: true });
    } else {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
    }
  }

  for (const rel of TRACKED_DIRS) {
    const absDir = join(state.repo, rel);
    if (state.absentDirs.has(rel)) {
      if (existsSync(absDir)) wipeDirExcludingExcluded(state.repo, absDir);
      continue;
    }
    if (!existsSync(absDir)) mkdirSync(absDir, { recursive: true });
    wipeDirExcludingExcluded(state.repo, absDir);
    const snap = state.dirs.get(rel)!;
    for (const [relFile, content] of snap) {
      const p = join(state.repo, relFile);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
    }
  }
}

function wipeDirExcludingExcluded(repo: string, absDir: string) {
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative(repo, full);
      if (SNAPSHOT_EXCLUDE_PREFIXES.some((p) => rel === p || rel.startsWith(p + "/"))) continue;
      const s = statSync(full);
      if (s.isDirectory()) {
        walk(full);
        try {
          if (readdirSync(full).length === 0) rmSync(full, { recursive: true, force: true });
        } catch { /* ignore */ }
      } else {
        rmSync(full, { force: true });
      }
    }
  };
  walk(absDir);
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run src/bench/repo-state.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/bench/repo-state.ts src/bench/repo-state.test.ts
git commit -m "feat(bench): add RepoState snapshot/restore helper for quality bench"
```

---

## Task 3: Extract reusable helpers from runner.ts into shared.ts

**Files:**
- Create: `src/bench/shared.ts`
- Modify: `src/bench/runner.ts`
- Create: `src/bench/shared.test.ts`

The four helpers being extracted are: `stripBriefedPreservingMcp`, `isMcpServerRegistered`, `findClaude`, `runClaudeTask`. None of them use `execSync` — they all use `spawnSync` or direct filesystem ops, so the extraction is purely a copy-move with no shell-out concerns.

- [ ] **Step 1: Write the failing test**

Create `src/bench/shared.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { stripBriefedPreservingMcp, isMcpServerRegistered, findClaude } from "./shared.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("shared helpers", () => {
  it("stripBriefedPreservingMcp leaves non-briefed MCP servers alone", () => {
    const repo = mkdtempSync(join(tmpdir(), "briefed-shared-test-"));
    try {
      mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
      writeFileSync(join(repo, "CLAUDE.md"), "# Header\n<!-- briefed:start -->\nremoveme\n<!-- briefed:end -->\nfooter");
      writeFileSync(
        join(repo, ".claude", "settings.json"),
        JSON.stringify({
          mcpServers: { serena: { command: "uvx", args: [] }, briefed: { command: "node" } },
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ command: "briefed hook" }] },
              { hooks: [{ command: "other hook" }] },
            ],
          },
        }),
      );
      writeFileSync(join(repo, ".claude", "rules", "briefed-a.md"), "x");
      writeFileSync(join(repo, ".claude", "rules", "user-own.md"), "y");

      stripBriefedPreservingMcp(repo);

      const md = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
      expect(md).not.toContain("briefed:start");
      expect(md).toContain("footer");

      const parsed = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf-8"));
      expect(parsed.mcpServers.serena).toBeDefined();
      expect(parsed.mcpServers.briefed).toBeUndefined();
      expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
      expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toBe("other hook");

      expect(existsSync(join(repo, ".claude", "rules", "briefed-a.md"))).toBe(false);
      expect(existsSync(join(repo, ".claude", "rules", "user-own.md"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("findClaude returns a string or null without throwing", () => {
    const result = findClaude();
    expect(result === null || typeof result === "string").toBe(true);
  });

  it("isMcpServerRegistered returns boolean without throwing", () => {
    const result = isMcpServerRegistered("nonexistent-claude-binary", process.cwd(), "serena");
    expect(typeof result).toBe("boolean");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/bench/shared.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create shared.ts by copying the 4 helpers verbatim**

Create `src/bench/shared.ts`. Open `src/bench/runner.ts`, find each of these functions, and copy its entire body into `shared.ts` with `export` prepended:
- `stripBriefedPreservingMcp` (currently around lines 486–536 of runner.ts)
- `isMcpServerRegistered` (around lines 579–595)
- `findClaude` (around lines 597–611)
- `runClaudeTask` (around lines 613–643)

The imports `shared.ts` needs at the top:

```typescript
import { spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
```

Each function declaration changes from `function foo(` to `export function foo(`. The bodies stay identical — do not edit them.

- [ ] **Step 4: Remove the originals from runner.ts and import from shared**

In `src/bench/runner.ts`:

1. At the top of the file, right after the existing imports, add:

```typescript
import {
  stripBriefedPreservingMcp,
  isMcpServerRegistered,
  findClaude,
  runClaudeTask,
} from "./shared.js";
```

2. Delete the four function definitions that are now in `shared.ts` (`stripBriefedPreservingMcp`, `isMcpServerRegistered`, `findClaude`, `runClaudeTask`).

3. If the old `runner.ts` imports at the top included `spawnSync` from `child_process` only for these functions, keep the existing `execSync, spawnSync` import line **as-is** — runner.ts still uses `execSync` elsewhere (in `runBenchmark` for `briefed init`), so don't touch it.

- [ ] **Step 5: Run tests**

Run: `npm run test`
Expected: all tests pass, including existing bench tests that use the helpers transitively.

- [ ] **Step 6: Run lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/bench/shared.ts src/bench/shared.test.ts src/bench/runner.ts
git commit -m "refactor(bench): extract reusable helpers into shared.ts"
```

---

## Task 4: Corpus fetcher (shallow-clone epic-stack at pinned SHA)

**Files:**
- Create: `src/bench/corpus.ts`
- Create: `src/bench/corpus.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/bench/corpus.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ensureCorpus, DEFAULT_CORPUS } from "./corpus.js";

vi.mock("simple-git", () => {
  return {
    simpleGit: vi.fn(() => ({
      clone: vi.fn().mockResolvedValue(undefined),
      checkout: vi.fn().mockResolvedValue(undefined),
      fetch: vi.fn().mockResolvedValue(undefined),
      revparse: vi.fn().mockResolvedValue("19eeb4ba358781ea447762e70403f7b78994db10\n"),
    })),
  };
});

describe("ensureCorpus", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "briefed-corpus-test-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("returns cacheRoot/<repo-name> on first call", async () => {
    const path = await ensureCorpus(DEFAULT_CORPUS, cacheRoot);
    expect(path).toBe(join(cacheRoot, "epic-stack"));
  });

  it("reuses existing checkout if the ref already matches", async () => {
    const target = join(cacheRoot, "epic-stack");
    mkdirSync(target, { recursive: true });
    mkdirSync(join(target, ".git"));
    writeFileSync(join(target, "marker"), "pre-existing");

    const path = await ensureCorpus(DEFAULT_CORPUS, cacheRoot);
    expect(path).toBe(target);
    expect(existsSync(join(target, "marker"))).toBe(true);
  });

  it("DEFAULT_CORPUS is epic-stack pinned to a real 40-char SHA", () => {
    expect(DEFAULT_CORPUS.name).toBe("epic-stack");
    expect(DEFAULT_CORPUS.url).toMatch(/epicweb-dev\/epic-stack/);
    expect(DEFAULT_CORPUS.ref).toMatch(/^[0-9a-f]{40}$/);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/bench/corpus.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement corpus.ts**

Create `src/bench/corpus.ts`:

```typescript
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { simpleGit } from "simple-git";

export interface CorpusSpec {
  name: string;
  url: string;
  ref: string;
}

/** Default bench target: epic-stack pinned to a known-good commit. */
export const DEFAULT_CORPUS: CorpusSpec = {
  name: "epic-stack",
  url: "https://github.com/epicweb-dev/epic-stack.git",
  ref: "19eeb4ba358781ea447762e70403f7b78994db10",
};

/**
 * Shallow-clone a CorpusSpec into `<cacheRoot>/<name>` and check out its pinned ref.
 * If the directory already contains a .git dir at the expected ref, reuse it.
 * Returns the absolute path to the checkout.
 */
export async function ensureCorpus(spec: CorpusSpec, cacheRoot: string): Promise<string> {
  mkdirSync(cacheRoot, { recursive: true });
  const target = join(cacheRoot, spec.name);

  if (existsSync(join(target, ".git"))) {
    try {
      const git = simpleGit(target);
      const head = (await git.revparse(["HEAD"])).trim();
      if (head === spec.ref) return target;
      await git.checkout(spec.ref);
      return target;
    } catch {
      // fall through
    }
  }

  if (existsSync(target)) {
    return target;
  }

  const git = simpleGit();
  await git.clone(spec.url, target, ["--depth", "1", "--no-single-branch"]);
  const repo = simpleGit(target);
  try {
    await repo.checkout(spec.ref);
  } catch {
    await repo.fetch(["--unshallow"]);
    await repo.checkout(spec.ref);
  }
  return target;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run src/bench/corpus.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/bench/corpus.ts src/bench/corpus.test.ts
git commit -m "feat(bench): add corpus fetcher with pinned epic-stack default"
```

---

## Task 5: Quality tasks + rubrics

**Files:**
- Create: `src/bench/quality-tasks.ts`
- Create: `src/bench/quality-tasks.test.ts`

**CRITICAL — rubric authoring:** before writing this file, the implementer must actually look at the pinned commit of epic-stack. The `mustContain` arrays below are templates; replace them with values sourced from the actual code at the pinned commit.

- [ ] **Step 1: Clone and inspect epic-stack at the pinned commit**

Run:

```bash
rm -rf /tmp/epic-stack-rubric-check
git clone https://github.com/epicweb-dev/epic-stack.git /tmp/epic-stack-rubric-check
cd /tmp/epic-stack-rubric-check
git checkout 19eeb4ba358781ea447762e70403f7b78994db10
```

Inspect these files and record ground-truth facts:

- `app/utils/env.server.ts` — the complete list of env var names the zod schema declares. Write them down.
- `prisma/schema.prisma` — the full list of `model` declarations. Write them down.
- `app/routes/` — top-level directories and notable route files. For React Router file routes, segments like `_auth+`, `users+`, `settings+`, `resources+` are common.
- `app/routes/_auth+/login.tsx` (or wherever the login action lives in the pinned commit) — what server helpers it imports, what DB tables the login touches.

If the pinned commit's structure differs from the examples below (file moved, schema restructured, etc.), update the rubrics to match reality. The rubric is the ground truth, so it must match the code.

- [ ] **Step 2: Write the shape-validation test**

Create `src/bench/quality-tasks.test.ts`:

```typescript
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
```

- [ ] **Step 3: Implement quality-tasks.ts**

Create `src/bench/quality-tasks.ts`. The `mustContain` entries below are **template placeholders** — replace every one with a fact sourced from the pinned commit in Step 1.

```typescript
/**
 * Quality bench task set. Each task pairs a strategy-neutral prompt with a
 * rubric listing facts a correct answer MUST contain. Rubrics are hand-authored
 * by reading the pinned commit of the bench corpus.
 *
 * Current corpus: epic-stack @ 19eeb4ba358781ea447762e70403f7b78994db10
 *
 * If you change the pinned ref or swap corpora, you MUST re-author every rubric.
 */

export interface QualityRubric {
  mustContain: string[];
  mustNotHallucinate: string[];
}

export interface QualityTask {
  name: string;
  prompt: string;
  rubric: QualityRubric;
}

export const QUALITY_TASKS: QualityTask[] = [
  {
    name: "explain-architecture",
    prompt:
      "Explain the overall architecture of this project in one paragraph per top-level module. Cover what each module does, how they connect, and which file is the server entry point.",
    rubric: {
      mustContain: [
        // TEMPLATE — replace with actual top-level dirs found in pinned commit
        "app/ directory contains the React Router application code",
        "server/ or index.ts is the server entrypoint",
        "prisma/ contains the database schema and migrations",
        "tests/ contains Playwright E2E tests",
      ],
      mustNotHallucinate: [
        "Next.js (epic-stack uses React Router, not Next.js)",
        "pages/ directory (that's Next.js pages router)",
      ],
    },
  },
  {
    name: "list-routes",
    prompt:
      "List every route this app exposes with its HTTP method (or React Router equivalent) and a one-line purpose. Produce a markdown table.",
    rubric: {
      mustContain: [
        // TEMPLATE — replace with actual route segments from app/routes/
        "_auth+/login",
        "_auth+/signup",
        "settings+",
        "users+",
        "resources+",
      ],
      mustNotHallucinate: [
        "/api/v1/ (epic-stack has no versioned REST API)",
      ],
    },
  },
  {
    name: "env-var-audit",
    prompt:
      "What environment variables does this project read? For each one, name the variable, say whether it is required or optional, and name the file(s) where it is consumed.",
    rubric: {
      mustContain: [
        // TEMPLATE — replace with actual env vars from app/utils/env.server.ts
        "DATABASE_URL",
        "SESSION_SECRET",
        "HONEYPOT_SECRET",
        "INTERNAL_COMMAND_TOKEN",
        "NODE_ENV",
      ],
      mustNotHallucinate: [
        "NEXT_PUBLIC_ (epic-stack is not Next.js)",
      ],
    },
  },
  {
    name: "trace-auth-flow",
    prompt:
      "Trace what happens when a user logs in to this app — which route handles the POST, which server modules run, which database tables get touched, in order. Name the specific functions involved at each step.",
    rubric: {
      mustContain: [
        // TEMPLATE — replace after inspecting app/routes/_auth+/login.tsx
        "login route in app/routes/_auth+/login.tsx",
        "session handling via getSession / commitSession",
        "User table query",
        "Session or Password database model",
      ],
      mustNotHallucinate: [
        "JWT (epic-stack uses cookie sessions by default, not JWTs)",
      ],
    },
  },
];
```

- [ ] **Step 4: Replace template placeholders with real facts**

For each of the 4 tasks, replace every string in `mustContain` and `mustNotHallucinate` with what you found at the pinned commit. Keep each fact short (<60 chars), specific, and checkable. The word "TEMPLATE" must not appear in the final file.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/bench/quality-tasks.test.ts`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/bench/quality-tasks.ts src/bench/quality-tasks.test.ts
git commit -m "feat(bench): add quality task set with rubrics for epic-stack corpus"
```

---

## Task 6: LLM-as-judge module

**Files:**
- Create: `src/bench/judge.ts`
- Create: `src/bench/judge.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/bench/judge.test.ts`:

```typescript
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
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/bench/judge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement judge.ts**

Create `src/bench/judge.ts`. All subprocess calls use `spawnSync` with array-args — never a shell.

```typescript
import { spawnSync } from "child_process";
import { writeFileSync } from "fs";
import type { QualityTask } from "./quality-tasks.js";
import type { CorrectnessScore } from "./metrics.js";
import { parseResult } from "./metrics.js";

/**
 * Build the blinded judge prompt. Must NOT reveal which arm produced the answer.
 */
export function buildJudgePrompt(task: QualityTask, answer: string): string {
  const mustContain = task.rubric.mustContain.map((f) => `- ${f}`).join("\n");
  const redFlags = task.rubric.mustNotHallucinate.length > 0
    ? task.rubric.mustNotHallucinate.map((f) => `- ${f}`).join("\n")
    : "(none)";

  return `You are grading an AI assistant's answer to a question about a codebase.

QUESTION:
${task.prompt}

ANSWER KEY (facts a correct answer must contain):
${mustContain}

RED FLAGS (answer must NOT contain any of these):
${redFlags}

ANSWER GIVEN:
${answer}

Score each dimension 1-5 (1 = poor, 5 = excellent):
- coverage:    fraction of answer-key facts the answer hits
- accuracy:    fraction of claims in the answer that are factually correct
- specificity: cites real file paths / function names where relevant
- overall:     single 1-5 verdict weighing the three

Return strict JSON only, no prose:
{"coverage": N, "accuracy": N, "specificity": N, "overall": N, "justification": "one sentence"}`;
}

/**
 * Parse the judge's raw reply into a CorrectnessScore. Returns null on any
 * malformation — the caller decides whether to retry.
 */
export function parseJudgeResponse(raw: string): CorrectnessScore | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;

  const requiredNumFields = ["coverage", "accuracy", "specificity", "overall"] as const;
  for (const k of requiredNumFields) {
    const v = p[k];
    if (typeof v !== "number" || v < 1 || v > 5) return null;
  }
  if (typeof p.justification !== "string") return null;

  return {
    coverage: p.coverage as number,
    accuracy: p.accuracy as number,
    specificity: p.specificity as number,
    overall: p.overall as number,
    justification: p.justification,
  };
}

/**
 * Invoke `claude -p` with the judge prompt and parse the reply.
 * Retries once on parse failure with an explicit "JSON only" hint.
 * Returns null if both attempts fail.
 */
export function runJudge(
  claudePath: string,
  cwd: string,
  task: QualityTask,
  answer: string,
  timeoutMs = 60_000,
): CorrectnessScore | null {
  const prompt = buildJudgePrompt(task, answer);
  const first = invokeClaudeJson(claudePath, cwd, prompt, timeoutMs);
  if (first !== null) {
    const parsed1 = parseJudgeResponse(first);
    if (parsed1) return parsed1;
  }

  const retryPrompt =
    "Your previous response was not valid JSON. Return ONLY the JSON object, no prose, no code fences.\n\n" +
    prompt;
  const second = invokeClaudeJson(claudePath, cwd, retryPrompt, timeoutMs);
  if (second === null) return null;
  return parseJudgeResponse(second);
}

function invokeClaudeJson(claudePath: string, cwd: string, prompt: string, timeoutMs: number): string | null {
  const isWindows = process.platform === "win32";
  const result = spawnSync(
    claudePath,
    ["-p", prompt, "--output-format", "json", "--max-turns", "1"],
    { cwd, stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, encoding: "utf-8", shell: isWindows },
  );
  if (result.status !== 0) return null;
  const stdout = result.stdout?.trim() || "";
  if (!stdout) return null;
  try {
    const parsed = JSON.parse(stdout);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).result === "string"
    ) {
      return (parsed as Record<string, unknown>).result as string;
    }
  } catch { /* fall through */ }
  return stdout;
}

/**
 * Judge a single transcript file. Extracts the final answer, runs the judge,
 * writes a .judge.json file next to the transcript.
 * Returns the score or null if unscored.
 */
export function judgeTranscript(
  claudePath: string,
  cwd: string,
  task: QualityTask,
  transcriptPath: string,
): CorrectnessScore | null {
  const metrics = parseResult(transcriptPath);
  if (!metrics.finalAnswer) {
    writeFileSync(
      transcriptPath + ".judge.json",
      JSON.stringify({ unscored: true, reason: "empty answer" }),
    );
    return null;
  }
  const score = runJudge(claudePath, cwd, task, metrics.finalAnswer);
  if (!score) {
    writeFileSync(
      transcriptPath + ".judge.json",
      JSON.stringify({ unscored: true, reason: "judge parse failure" }),
    );
    return null;
  }
  writeFileSync(transcriptPath + ".judge.json", JSON.stringify(score, null, 2));
  return score;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run src/bench/judge.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/bench/judge.ts src/bench/judge.test.ts
git commit -m "feat(bench): add LLM-as-judge for scoring transcript answers"
```

---

## Task 7: Quality orchestrator

**Files:**
- Create: `src/bench/quality.ts`
- Create: `src/bench/quality.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/bench/quality.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/bench/quality.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement quality.ts**

Create `src/bench/quality.ts`. Note: every shell-out uses `spawnSync` with an array of arguments. No `execSync`, no template-string commands.

```typescript
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import {
  findClaude,
  isMcpServerRegistered,
  runClaudeTask,
  stripBriefedPreservingMcp,
} from "./shared.js";
import { snapshotRepoState, restoreRepoState, type RepoStateSnapshot } from "./repo-state.js";
import { DEFAULT_CORPUS, ensureCorpus, type CorpusSpec } from "./corpus.js";
import { QUALITY_TASKS, type QualityTask } from "./quality-tasks.js";
import { judgeTranscript } from "./judge.js";
import { parseResult, type TaskMetrics } from "./metrics.js";

export interface QualityOptions {
  repo: string;
  quick?: boolean;
  full?: boolean;
  reportOnly?: boolean;
  arms?: string;
  rerun?: string;
  corpusRepo?: string;
  corpusRef?: string;
  timeoutMs?: number;
  resume?: boolean;
  outputDir?: string;
}

export interface ArmConfig {
  label: string;
  serena: boolean;
  briefed: "none" | "static" | "deep";
}

export const ARM_LABELS: Record<string, string> = {
  A: "no-serena + no-briefed",
  B: "no-serena + briefed-deep",
  C: "serena + no-briefed",
  D: "serena + briefed-deep",
  E: "no-serena + briefed-static",
  F: "serena + briefed-static",
};

const DEFAULT_MATRIX: ArmConfig[] = [
  { label: "A", serena: false, briefed: "none" },
  { label: "B", serena: false, briefed: "deep" },
  { label: "C", serena: true, briefed: "none" },
  { label: "D", serena: true, briefed: "deep" },
];

const FULL_EXTRA: ArmConfig[] = [
  { label: "E", serena: false, briefed: "static" },
  { label: "F", serena: true, briefed: "static" },
];

export function enumerateArms(opts: QualityOptions): ArmConfig[] {
  let arms = [...DEFAULT_MATRIX];
  if (opts.full) arms = arms.concat(FULL_EXTRA);
  if (opts.arms) {
    const wanted = new Set(opts.arms.split(",").map((s) => s.trim().toUpperCase()));
    arms = arms.filter((a) => wanted.has(a.label));
  }
  return arms;
}

export interface QualityCellResult {
  arm: ArmConfig;
  task: QualityTask;
  metrics: TaskMetrics | null;
  error: string | null;
}

/**
 * Main orchestrator. Single long function by design — the state-transition
 * sequencing is the whole point, and splitting it into helpers makes the
 * control flow harder to audit.
 */
export async function runQualityBench(opts: QualityOptions): Promise<QualityCellResult[]> {
  const hostRepo = resolve(opts.repo);
  const tasks = opts.quick ? QUALITY_TASKS.slice(0, 2) : QUALITY_TASKS;
  const arms = enumerateArms(opts);

  const outputDir = resolve(opts.outputDir || join(hostRepo, ".briefed", "bench", "quality"));
  const corpusCacheRoot = join(outputDir, "corpus");
  const timeoutMs = opts.timeoutMs || 600_000;
  const resume = opts.resume !== false;

  mkdirSync(outputDir, { recursive: true });

  const claudePath = findClaude();
  if (!claudePath) {
    console.error("  Error: 'claude' CLI not found. Install with: npm i -g @anthropic-ai/claude-code");
    return [];
  }
  console.log(`  Using: ${claudePath}`);

  // Corpus prep
  const corpus: CorpusSpec = {
    name: opts.corpusRepo ? deriveNameFromUrl(opts.corpusRepo) : DEFAULT_CORPUS.name,
    url: opts.corpusRepo || DEFAULT_CORPUS.url,
    ref: opts.corpusRef || DEFAULT_CORPUS.ref,
  };
  console.log(`  Corpus: ${corpus.name} @ ${corpus.ref.slice(0, 7)}`);
  let corpusPath: string;
  try {
    corpusPath = await ensureCorpus(corpus, corpusCacheRoot);
  } catch (e) {
    console.error(`  Corpus prep failed: ${(e as Error).message}`);
    return [];
  }
  console.log(`  Corpus path: ${corpusPath}`);

  // Plugin-serena detection for arms that need serena OFF
  const serenaIsPluginInstalled = detectPluginInstalledServer(claudePath, corpusPath, "serena");
  if (serenaIsPluginInstalled && arms.some((a) => !a.serena)) {
    console.error(
      "  Error: Serena is installed via a Claude Code plugin and cannot be\n" +
        "  temporarily disabled for the no-serena arms. Either:\n" +
        "    (a) uninstall the plugin for this bench,\n" +
        "    (b) pass `--arms C,D` to run only the serena arms, or\n" +
        "    (c) install Serena via .claude/settings.json instead.",
    );
    return [];
  }

  // Snapshot CORPUS state so every arm mutation is reversible
  const state: RepoStateSnapshot = snapshotRepoState(corpusPath);

  const restore = () => {
    try {
      restoreRepoState(state);
      console.log("  Corpus state restored.");
    } catch (e) {
      console.error(`  Restore failed: ${(e as Error).message}`);
    }
  };
  process.once("SIGINT", () => { restore(); process.exit(130); });
  process.once("SIGTERM", () => { restore(); process.exit(143); });

  const results: QualityCellResult[] = [];

  // Parse rerun spec: "arm=D,task=env-var-audit" → {"D:env-var-audit"}
  const rerunSet = new Set<string>();
  if (opts.rerun) {
    const m = opts.rerun.match(/arm=([A-Z])\s*[,;]\s*task=([a-z-]+)/i);
    if (m) rerunSet.add(`${m[1].toUpperCase()}:${m[2]}`);
  }

  try {
    for (const arm of arms) {
      console.log(`\n  Arm ${arm.label}: ${ARM_LABELS[arm.label]}`);
      mkdirSync(join(outputDir, arm.label), { recursive: true });

      if (!opts.reportOnly) {
        try {
          applyArmState(corpusPath, arm, claudePath);
        } catch (e) {
          const msg = (e as Error).message;
          console.error(`    arm setup failed: ${msg.slice(0, 200)}`);
          for (const task of tasks) {
            results.push({ arm, task, metrics: null, error: `arm setup failed: ${msg}` });
          }
          continue;
        }

        for (let i = 0; i < tasks.length; i++) {
          const task = tasks[i];
          const out = join(outputDir, arm.label, `${task.name}.json`);
          const cellKey = `${arm.label}:${task.name}`;
          if (resume && existsSync(out) && !rerunSet.has(cellKey)) {
            console.log(`    [${i + 1}/${tasks.length}] ${task.name} (cached)`);
            continue;
          }
          console.log(`    [${i + 1}/${tasks.length}] ${task.name}`);
          try {
            runClaudeTask(claudePath, corpusPath, task.prompt, out, timeoutMs);
            const m = parseResult(out);
            console.log(
              `      ${(m.durationMs / 1000).toFixed(1)}s, ${m.numTurns} turns, ${m.totalToolCalls} tool calls`,
            );
          } catch (e) {
            console.error(`      Error: ${(e as Error).message.slice(0, 120)}`);
          }
        }
      }
    }
  } finally {
    restore();
  }

  // Judge pass (randomized order)
  console.log("\n  Judge pass:");
  const cells: Array<{ arm: ArmConfig; task: QualityTask }> = [];
  for (const arm of arms) for (const task of tasks) cells.push({ arm, task });
  shuffle(cells);

  for (const { arm, task } of cells) {
    const out = join(outputDir, arm.label, `${task.name}.json`);
    if (!existsSync(out)) continue;
    const judgeOut = out + ".judge.json";
    const cellKey = `${arm.label}:${task.name}`;
    if (resume && existsSync(judgeOut) && !rerunSet.has(cellKey)) continue;
    console.log(`    ${arm.label} / ${task.name}`);
    try {
      const score = judgeTranscript(claudePath, corpusPath, task, out);
      if (score) {
        console.log(
          `      overall=${score.overall}/5 coverage=${score.coverage} accuracy=${score.accuracy}`,
        );
      } else {
        console.log(`      unscored`);
      }
    } catch (e) {
      console.error(`      judge error: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  // Collect final results
  for (const arm of arms) {
    for (const task of tasks) {
      const out = join(outputDir, arm.label, `${task.name}.json`);
      if (!existsSync(out)) {
        results.push({ arm, task, metrics: null, error: "no transcript" });
        continue;
      }
      try {
        const m = parseResult(out);
        const judgeOut = out + ".judge.json";
        if (existsSync(judgeOut)) {
          const judged = JSON.parse(readFileSync(judgeOut, "utf-8"));
          if (judged && typeof judged.overall === "number") {
            m.correctness = judged;
          }
        }
        results.push({ arm, task, metrics: m, error: null });
      } catch (e) {
        results.push({ arm, task, metrics: null, error: (e as Error).message });
      }
    }
  }

  return results;
}

function applyArmState(corpusPath: string, arm: ArmConfig, claudePath: string): void {
  // 1. Clean slate: strip any briefed artifacts
  stripBriefedPreservingMcp(corpusPath);

  // 2. Toggle serena presence in .claude/settings.json
  toggleSerenaInSettings(corpusPath, arm.serena);

  // 3. Install briefed if this arm requires it
  if (arm.briefed !== "none") {
    const briefedCli = join(import.meta.dirname, "..", "cli.js");
    const flags = ["init", "--repo", corpusPath, "--skip-hooks"];
    if (arm.briefed === "deep") flags.push("--deep");
    const result = spawnSync("node", [briefedCli, ...flags], {
      stdio: "inherit",
      timeout: 600_000,
    });
    if (result.status !== 0) {
      throw new Error(`briefed init exited with status ${result.status ?? "unknown"}`);
    }
  }

  // 4. Sanity: if arm requires serena, it must still be visible after setup
  if (arm.serena && !isMcpServerRegistered(claudePath, corpusPath, "serena")) {
    throw new Error("serena required by this arm but not registered after setup");
  }
}

function toggleSerenaInSettings(corpusPath: string, enable: boolean): void {
  const settingsPath = join(corpusPath, ".claude", "settings.json");
  let parsed: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      parsed = {};
    }
  }
  const servers = (parsed.mcpServers as Record<string, unknown> | undefined) || {};
  if (enable) {
    if (!servers.serena) {
      servers.serena = {
        command: "uvx",
        args: [
          "--from",
          "git+https://github.com/oraios/serena",
          "serena-mcp-server",
          "--context",
          "ide-assistant",
          "--project",
          corpusPath,
        ],
      };
    }
  } else {
    delete servers.serena;
  }
  parsed.mcpServers = servers;
  mkdirSync(join(corpusPath, ".claude"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + "\n");
}

function detectPluginInstalledServer(claudePath: string, cwd: string, name: string): boolean {
  if (!isMcpServerRegistered(claudePath, cwd, name)) return false;
  const settingsPath = join(cwd, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return true;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const servers = (parsed.mcpServers || {}) as Record<string, unknown>;
    return !(name in servers);
  } catch {
    return true;
  }
}

function deriveNameFromUrl(url: string): string {
  const m = url.match(/\/([^/]+?)(\.git)?$/);
  return m ? m[1] : "corpus";
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * Format a numeric value with k/M suffixes for compact reporting.
 */
function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

/**
 * Generate a report string comparing arms across tasks.
 */
export function generateQualityReport(results: QualityCellResult[]): string {
  const lines: string[] = [];
  lines.push("  " + "=".repeat(80));
  lines.push("  briefed Quality Bench — correctness + tokens + speed");
  lines.push("  " + "=".repeat(80));
  lines.push("");

  const byTask = new Map<string, QualityCellResult[]>();
  for (const r of results) {
    if (!byTask.has(r.task.name)) byTask.set(r.task.name, []);
    byTask.get(r.task.name)!.push(r);
  }

  for (const [taskName, cells] of byTask) {
    lines.push(`  Task: ${taskName}`);
    lines.push("  " + "-".repeat(80));
    lines.push("    arm   duration   in-tokens   cost     overall  coverage  accuracy");
    lines.push("  " + "-".repeat(80));
    for (const cell of cells) {
      const m = cell.metrics;
      if (!m) {
        lines.push(`    ${cell.arm.label.padEnd(5)} ${(cell.error || "error").slice(0, 60)}`);
        continue;
      }
      const score = m.correctness;
      lines.push(
        `    ${cell.arm.label.padEnd(5)}` +
          ` ${(m.durationMs / 1000).toFixed(1).padStart(7)}s` +
          ` ${formatNum(m.inputTokens).padStart(10)}` +
          ` $${m.totalCostUsd.toFixed(4).padStart(6)}` +
          ` ${score ? (score.overall + "/5").padStart(8) : "unscored".padStart(8)}` +
          ` ${score ? (score.coverage + "/5").padStart(9) : "-".padStart(9)}` +
          ` ${score ? (score.accuracy + "/5").padStart(9) : "-".padStart(9)}`,
      );
    }
    lines.push("");
  }

  lines.push("  " + "=".repeat(80));
  lines.push("  SUMMARY (mean across tasks per arm)");
  lines.push("  " + "=".repeat(80));
  const armTotals = new Map<
    string,
    { count: number; duration: number; tokens: number; cost: number; overall: number; overallN: number }
  >();
  for (const r of results) {
    if (!r.metrics) continue;
    const key = r.arm.label;
    const t = armTotals.get(key) || {
      count: 0,
      duration: 0,
      tokens: 0,
      cost: 0,
      overall: 0,
      overallN: 0,
    };
    t.count++;
    t.duration += r.metrics.durationMs;
    t.tokens += r.metrics.inputTokens;
    t.cost += r.metrics.totalCostUsd;
    if (r.metrics.correctness) {
      t.overall += r.metrics.correctness.overall;
      t.overallN++;
    }
    armTotals.set(key, t);
  }
  for (const [label, t] of armTotals) {
    const meanOverall = t.overallN > 0 ? (t.overall / t.overallN).toFixed(2) : "—";
    lines.push(
      `    ${label} (${ARM_LABELS[label] || "?"})`.padEnd(45) +
        ` dur=${(t.duration / t.count / 1000).toFixed(1)}s` +
        ` tok=${formatNum(Math.round(t.tokens / t.count))}` +
        ` $${(t.cost / t.count).toFixed(4)}` +
        ` overall=${meanOverall}`,
    );
  }

  lines.push("  " + "=".repeat(80));
  return lines.join("\n");
}
```

- [ ] **Step 4: Run enumerateArms tests**

Run: `npx vitest run src/bench/quality.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/bench/quality.ts src/bench/quality.test.ts
git commit -m "feat(bench): add quality orchestrator with 4-arm matrix and judge pass"
```

---

## Task 8: CLI wiring

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/commands/bench.ts`

- [ ] **Step 1: Add CLI flags in src/cli.ts**

In `src/cli.ts`, find the `program.command("bench")` block and add five new `.option(...)` lines immediately before the `.action(benchCommand)` line:

```typescript
  .option("--quality", "Quality bench: 4-arm matrix + LLM-as-judge correctness scoring")
  .option("--arms <list>", "Comma-separated arm subset, e.g. `C,D` (quality mode only)")
  .option("--rerun <spec>", "Re-run specific cells, e.g. `arm=D,task=env-var-audit`")
  .option("--corpus-repo <url>", "Override bench corpus repo URL (quality mode only)")
  .option("--corpus-ref <sha>", "Override bench corpus ref (quality mode only)")
```

Keep all existing options. Do not touch `--compare-deep` or `--serena-compare`.

- [ ] **Step 2: Dispatch to runQualityBench in bench.ts**

In `src/commands/bench.ts`:

1. Add the import at the top of the file, after the existing imports:

```typescript
import { runQualityBench, generateQualityReport } from "../bench/quality.js";
```

2. Extend the `BenchOptions` interface to include the new fields:

```typescript
interface BenchOptions {
  repo: string;
  quick?: boolean;
  full?: boolean;
  withOnly?: boolean;
  withoutOnly?: boolean;
  reportOnly?: boolean;
  output?: string;
  timeout?: string;
  resume?: boolean;
  compareDeep?: boolean;
  serenaCompare?: boolean;
  quality?: boolean;
  arms?: string;
  rerun?: string;
  corpusRepo?: string;
  corpusRef?: string;
}
```

3. Inside `benchCommand`, add a new branch at the very top (before the existing `if (opts.serenaCompare)` block):

```typescript
  if (opts.quality) {
    console.log("  briefed bench --quality — 4-arm correctness + tokens + speed");
    console.log(`  Host repo (output dir parent): ${root}\n`);
    const results = await runQualityBench({
      repo: root,
      quick: opts.quick,
      full: opts.full,
      reportOnly: opts.reportOnly,
      arms: opts.arms,
      rerun: opts.rerun,
      corpusRepo: opts.corpusRepo,
      corpusRef: opts.corpusRef,
      timeoutMs: opts.timeout ? parseInt(opts.timeout, 10) * 1000 : undefined,
      resume: opts.resume,
      outputDir: opts.output,
    });
    if (results.length === 0) process.exit(1);

    const report = generateQualityReport(results);
    console.log("\n" + report);

    const outDir = join(root, ".briefed", "bench", "quality");
    if (existsSync(outDir)) {
      writeFileSync(join(outDir, "report.txt"), report);
      console.log(`\n  Report saved to ${join(outDir, "report.txt")}`);
    }
    return;
  }
```

- [ ] **Step 3: Build and type-check**

Run: `npm run build`
Expected: clean compile.

- [ ] **Step 4: Smoke test CLI wiring (no real runs)**

Run: `node dist/cli.js bench --help`
Expected: the new flags (`--quality`, `--arms`, `--rerun`, `--corpus-repo`, `--corpus-ref`) appear in the help output.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/commands/bench.ts
git commit -m "feat(cli): wire --quality bench mode into the bench command"
```

---

## Task 9: End-to-end smoke sanity check

**Files:** no new files; verification only.

- [ ] **Step 1: Run all tests**

Run: `npm run test`
Expected: all tests pass (metrics, repo-state, shared, corpus, quality-tasks, judge, quality, plus existing tests).

- [ ] **Step 2: Run lint and build**

Run: `npm run lint && npm run build`
Expected: clean.

- [ ] **Step 3: Dry run with a single arm**

Pre-requisite: `claude` CLI must be in PATH. Serena does NOT need to be installed — we'll run only arm B (briefed-deep, no serena).

```bash
mkdir -p /tmp/briefed-quality-smoke
node dist/cli.js bench --quality --arms B --quick --repo /tmp/briefed-quality-smoke --timeout 300
```

Expected behavior:
- Clones epic-stack into `/tmp/briefed-quality-smoke/.briefed/bench/quality/corpus/epic-stack`
- Runs `briefed init --deep` on the corpus clone
- Runs 1 arm × 2 tasks = 2 task runs
- Runs 2 judge passes
- Prints a report table and saves `.briefed/bench/quality/report.txt`
- Restores corpus state before exit (the corpus clone's `.claude/` should contain only what was there at the pinned commit, plus briefed artifacts stripped)

If the dry run takes longer than 20 minutes, abort with Ctrl-C and verify the SIGINT handler restored the corpus state cleanly (no briefed artifacts should remain in the corpus checkout after Ctrl-C).

- [ ] **Step 4: Inspect the report**

After the dry run, open `/tmp/briefed-quality-smoke/.briefed/bench/quality/report.txt` and sanity-check:
- Each task row shows a duration, token count, and a correctness score (or "unscored" if the judge failed)
- The summary row shows `overall=X.XX` for arm B
- No rows show "no transcript" unless an individual task actually failed

If the correctness scores are all `unscored`, check `<arm>/<task>.json.judge.json` for the failure reason. Most likely cause: judge returning non-JSON. Tighten the prompt wording in `buildJudgePrompt` and re-run with `--rerun arm=B,task=<name>` to re-score just that cell.

---

## Self-review: spec coverage checklist

- [x] 4-arm 2×2 matrix — Task 7 (`DEFAULT_MATRIX`)
- [x] 4 tasks adapted to epic-stack — Task 5 (`QUALITY_TASKS`)
- [x] Epic-stack pinned corpus + override — Task 4 (`DEFAULT_CORPUS`, `--corpus-repo`, `--corpus-ref`)
- [x] LLM-as-judge with blinded prompt + strict JSON + retry — Task 6
- [x] `--quality`, `--quick`, `--full`, `--arms`, `--rerun` — Task 8
- [x] RepoState snapshot + restore + SIGINT — Task 2 + Task 7
- [x] Plugin-installed Serena detection — Task 7 (`detectPluginInstalledServer`)
- [x] TaskMetrics extended — Task 1
- [x] Randomized judge order — Task 7 (`shuffle(cells)` before judge loop)
- [x] Resume + `--rerun` cell invalidation — Task 7
- [x] Unit tests per component — every task includes a test step
- [x] End-to-end smoke — Task 9

No placeholders beyond the epic-stack rubric values, which are explicitly flagged as requiring inspection of the pinned commit in Task 5 Steps 1 and 4.
