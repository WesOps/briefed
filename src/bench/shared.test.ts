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
