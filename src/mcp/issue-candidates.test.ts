import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { issueCandidates } from "./issue-candidates.js";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text || "").join("\n");
}

describe("issueCandidates", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "briefed-issue-candidates-"));
    mkdirSync(join(tmp, "src"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns no-match message when no terms found", () => {
    writeFileSync(join(tmp, "src", "a.ts"), "export const x = 1;\n");
    const result = issueCandidates(tmp, "the and for");
    const text = getText(result);
    expect(text).toContain("No meaningful terms found");
  });

  it("finds a file whose exported symbol matches the issue terms", () => {
    writeFileSync(
      join(tmp, "src", "auth.ts"),
      [
        "/** Validate user session token */",
        "export function validateToken(token: string): boolean { return true; }",
        "",
      ].join("\n")
    );
    writeFileSync(
      join(tmp, "src", "unrelated.ts"),
      "export function formatDate(d: Date): string { return d.toISOString(); }\n"
    );

    const result = issueCandidates(tmp, "token validation is broken");
    const text = getText(result);
    expect(result.content[0].type).toBe("text");
    // auth.ts should appear; unrelated.ts should not
    expect(text).toContain("src/auth.ts");
    expect(text).not.toContain("src/unrelated.ts");
    // Should show the matched symbol
    expect(text).toContain("validateToken");
  });

  it("scores exported symbols higher than unexported ones", () => {
    writeFileSync(
      join(tmp, "src", "payment.ts"),
      [
        "export function processPayment(amount: number): void {}",
        "function internalPaymentHelper(): void {}",
        "",
      ].join("\n")
    );

    const result = issueCandidates(tmp, "payment processing error");
    const text = getText(result);
    expect(text).toContain("src/payment.ts");
    // Should show score > 0
    expect(text).toMatch(/\*\*Score:\*\* [1-9]/);
  });

  it("matches on file path terms", () => {
    writeFileSync(
      join(tmp, "src", "database.ts"),
      "export function connect(): void {}\n"
    );
    writeFileSync(
      join(tmp, "src", "server.ts"),
      "export function start(): void {}\n"
    );

    const result = issueCandidates(tmp, "database connection fails on startup");
    const text = getText(result);
    expect(text).toContain("src/database.ts");
  });

  it("returns no-match message when terms don't match anything", () => {
    writeFileSync(
      join(tmp, "src", "widget.ts"),
      "export function renderWidget(): void {}\n"
    );

    const result = issueCandidates(tmp, "xyzzy frobnicator quux");
    const text = getText(result);
    expect(text).toContain("No files matched the terms");
  });

  it("returns at most 8 results", () => {
    // Create 10 files all matching the same term
    for (let i = 0; i < 10; i++) {
      writeFileSync(
        join(tmp, "src", `cache${i}.ts`),
        `export function getCacheEntry${i}(): void {}\n`
      );
    }

    const result = issueCandidates(tmp, "cache invalidation issue");
    const text = getText(result);
    // Count occurrences of "## `" which marks each result entry
    const entryCount = (text.match(/^## `/gm) || []).length;
    expect(entryCount).toBeLessThanOrEqual(8);
  });

  it("includes matched terms in output", () => {
    writeFileSync(
      join(tmp, "src", "session.ts"),
      "/** Manage user session lifecycle */\nexport function destroySession(id: string): void {}\n"
    );

    const result = issueCandidates(tmp, "session is not being destroyed");
    const text = getText(result);
    expect(text).toContain("Matched terms:");
    expect(text).toContain("session");
  });
});
