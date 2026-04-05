import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { extractGotchas } from "./gotchas.js";

describe("extractGotchas", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "briefed-test-gotchas-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts important TODO comments with sufficient detail", () => {
    const file = join(tmpDir, "test.ts");
    writeFileSync(
      file,
      `// TODO: This rate limiter must be checked before processing any payment requests\nconst x = 1;\n`
    );
    const gotchas = extractGotchas(file);
    expect(gotchas).toHaveLength(1);
    expect(gotchas[0].category).toBe("important_comment");
    expect(gotchas[0].text).toContain("TODO");
    expect(gotchas[0].line).toBe(1);
  });

  it("skips trivial TODO comments", () => {
    const file = join(tmpDir, "test.ts");
    writeFileSync(file, `// TODO: add tests\n// TODO: refactor this\n// TODO: implement\n`);
    const gotchas = extractGotchas(file);
    expect(gotchas).toHaveLength(0);
  });

  it("skips short TODO comments", () => {
    const file = join(tmpDir, "test.ts");
    writeFileSync(file, `// TODO: fix later\n`);
    const gotchas = extractGotchas(file);
    expect(gotchas).toHaveLength(0);
  });

  it("extracts HACK, FIXME, WARNING, NOTE comments", () => {
    const file = join(tmpDir, "test.ts");
    writeFileSync(
      file,
      [
        "// HACK: This workaround is needed because the API returns stale cache entries",
        "// FIXME: Race condition occurs when two users submit simultaneously in production",
        "// WARNING: Changing this value requires a database migration on all environments",
        "// NOTE: The ordering here matters because downstream consumers depend on sort order",
      ].join("\n")
    );
    const gotchas = extractGotchas(file);
    expect(gotchas).toHaveLength(4);
    expect(gotchas.map((g) => g.category)).toEqual([
      "important_comment",
      "important_comment",
      "important_comment",
      "important_comment",
    ]);
  });

  it("extracts guard clauses (throw inside if)", () => {
    const file = join(tmpDir, "test.ts");
    writeFileSync(
      file,
      `function create(user: User) {
  if (!user.verified) {
    throw new ValidationError('User must be verified before creating')
  }
  return db.create(user);
}
`
    );
    const gotchas = extractGotchas(file);
    const guard = gotchas.find((g) => g.category === "guard_clause");
    expect(guard).toBeDefined();
    expect(guard!.text).toContain("ValidationError");
  });

  it("extracts state transitions from switch statements", () => {
    const file = join(tmpDir, "test.ts");
    writeFileSync(
      file,
      `function process(order: Order) {
  switch (order.status) {
    case 'pending':
      break;
    case 'processing':
      break;
    case 'completed':
      break;
  }
}
`
    );
    const gotchas = extractGotchas(file);
    const state = gotchas.find((g) => g.category === "state_transition");
    expect(state).toBeDefined();
    expect(state!.text).toContain("pending");
    expect(state!.text).toContain("processing");
    expect(state!.text).toContain("completed");
  });

  it("extracts enum-based state machines", () => {
    const file = join(tmpDir, "test.ts");
    writeFileSync(
      file,
      `enum OrderStatus {
  Pending = "pending",
  Active = "active",
  Cancelled = "cancelled",
}
`
    );
    const gotchas = extractGotchas(file);
    const state = gotchas.find((g) => g.category === "state_transition");
    expect(state).toBeDefined();
    expect(state!.text).toContain("Pending");
    expect(state!.text).toContain("Active");
    expect(state!.text).toContain("Cancelled");
  });

  it("extracts side effects (event emission)", () => {
    const file = join(tmpDir, "test.ts");
    writeFileSync(file, `eventBus.emit('OrderCreated', { id: order.id });\n`);
    const gotchas = extractGotchas(file);
    const sideEffect = gotchas.find((g) => g.category === "side_effect");
    expect(sideEffect).toBeDefined();
    expect(sideEffect!.text).toContain("OrderCreated");
  });

  it("extracts soft delete patterns (deduplicates per file)", () => {
    const file = join(tmpDir, "test.ts");
    writeFileSync(
      file,
      `const query = { deletedAt: null };
if (record.deletedAt !== null) { return; }
`
    );
    const gotchas = extractGotchas(file);
    const softDeletes = gotchas.filter((g) => g.category === "soft_delete");
    // Should be deduplicated to 1 per file
    expect(softDeletes).toHaveLength(1);
    expect(softDeletes[0].text).toContain("soft deletes");
  });

  it("extracts unique constraint checks", () => {
    const file = join(tmpDir, "test.ts");
    writeFileSync(
      file,
      `const existing = await db.findFirst({ where: { email } });
if (existing) {
  throw new Conflict('Already exists');
}
`
    );
    const gotchas = extractGotchas(file);
    const unique = gotchas.find((g) => g.category === "unique_constraint");
    expect(unique).toBeDefined();
    expect(unique!.text).toContain("uniqueness");
  });

  it("returns empty for a file with no gotchas", () => {
    const file = join(tmpDir, "clean.ts");
    writeFileSync(file, `export function add(a: number, b: number): number {\n  return a + b;\n}\n`);
    const gotchas = extractGotchas(file);
    expect(gotchas).toHaveLength(0);
  });

  it("handles Python-style comments", () => {
    const file = join(tmpDir, "test.py");
    writeFileSync(
      file,
      `# WARNING: This function must be called with the database lock held or data corruption will occur\ndef update_balance(): pass\n`
    );
    const gotchas = extractGotchas(file);
    expect(gotchas.length).toBeGreaterThanOrEqual(1);
    expect(gotchas[0].category).toBe("important_comment");
  });
});
