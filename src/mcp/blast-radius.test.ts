import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { blastRadius } from "./blast-radius.js";

describe("blastRadius", () => {
  const tmpDir = join(import.meta.dirname, "../../.test-mcp-blast");

  function setup() {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(join(tmpDir, "src"), { recursive: true });

    // a.ts imports b.ts, c.ts imports a.ts (use extensionless imports for dep resolution)
    writeFileSync(join(tmpDir, "src", "a.ts"), `import { foo } from "./b";\nexport function bar() { return foo(); }\n`);
    writeFileSync(join(tmpDir, "src", "b.ts"), `export function foo() { return 1; }\n`);
    writeFileSync(join(tmpDir, "src", "c.ts"), `import { bar } from "./a";\nexport function baz() { return bar(); }\n`);
  }

  function cleanup() {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  it("finds transitive dependents", () => {
    setup();
    try {
      const result = blastRadius(tmpDir, "src/b.ts");
      expect(result.isError).toBeUndefined();
      const text = (result.content[0] as { text: string }).text;
      // Changing b.ts affects a.ts (direct) and c.ts (transitive)
      expect(text).toContain("src/a.ts");
      expect(text).toContain("src/c.ts");
      expect(text).toContain("2 files affected");
    } finally {
      cleanup();
    }
  });

  it("returns error for unknown file", () => {
    setup();
    try {
      const result = blastRadius(tmpDir, "src/unknown.ts");
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("not found");
    } finally {
      cleanup();
    }
  });

  it("shows direct vs transitive dependents", () => {
    setup();
    try {
      const result = blastRadius(tmpDir, "src/b.ts");
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Direct dependents");
      expect(text).toContain("Transitive dependents");
    } finally {
      cleanup();
    }
  });
});
