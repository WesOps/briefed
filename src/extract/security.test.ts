import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isSensitiveFile, scanForSecrets, redactSecrets } from "./security.js";

describe("isSensitiveFile", () => {
  it("flags .env files", () => {
    expect(isSensitiveFile(".env")).toBe(true);
    expect(isSensitiveFile(".env.local")).toBe(true);
    expect(isSensitiveFile(".env.production")).toBe(true);
    expect(isSensitiveFile(".env.development")).toBe(true);
    expect(isSensitiveFile(".env.custom")).toBe(true);
  });

  it("flags credential files", () => {
    expect(isSensitiveFile("credentials.json")).toBe(true);
    expect(isSensitiveFile("service-account.json")).toBe(true);
    expect(isSensitiveFile("secrets.yaml")).toBe(true);
    expect(isSensitiveFile("secrets.yml")).toBe(true);
  });

  it("flags key files", () => {
    expect(isSensitiveFile("id_rsa")).toBe(true);
    expect(isSensitiveFile("id_ed25519")).toBe(true);
    expect(isSensitiveFile("server.pem")).toBe(true);
    expect(isSensitiveFile("private.key")).toBe(true);
    expect(isSensitiveFile("cert.p12")).toBe(true);
  });

  it("flags .npmrc and .pypirc", () => {
    expect(isSensitiveFile(".npmrc")).toBe(true);
    expect(isSensitiveFile(".pypirc")).toBe(true);
  });

  it("does NOT flag regular source files", () => {
    expect(isSensitiveFile("app.ts")).toBe(false);
    expect(isSensitiveFile("package.json")).toBe(false);
    expect(isSensitiveFile("config.ts")).toBe(false);
    expect(isSensitiveFile("README.md")).toBe(false);
  });

  it("handles paths with directories", () => {
    expect(isSensitiveFile("/project/.env")).toBe(true);
    expect(isSensitiveFile("/project/src/app.ts")).toBe(false);
  });
});

describe("scanForSecrets", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "briefed-test-security-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects hardcoded API keys", () => {
    const file = join(tmpDir, "config.ts");
    writeFileSync(file, `const api_key = "sk-abcdef1234567890abcdef";\n`);
    const warnings = scanForSecrets(file);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.type === "api_key")).toBe(true);
  });

  it("detects hardcoded passwords", () => {
    const file = join(tmpDir, "config.ts");
    writeFileSync(file, `const password = "super_secret_password";\n`);
    const warnings = scanForSecrets(file);
    expect(warnings.some((w) => w.type === "password")).toBe(true);
  });

  it("detects private keys", () => {
    const file = join(tmpDir, "key.ts");
    writeFileSync(file, `const key = "-----BEGIN RSA PRIVATE KEY-----\\nMIIE...";\n`);
    const warnings = scanForSecrets(file);
    expect(warnings.some((w) => w.type === "private_key")).toBe(true);
  });

  it("detects connection strings with credentials", () => {
    const file = join(tmpDir, "db.ts");
    writeFileSync(file, `const url = "postgres://admin:password123@localhost:5432/db";\n`);
    const warnings = scanForSecrets(file);
    expect(warnings.some((w) => w.type === "connection_string")).toBe(true);
  });

  it("detects GitHub tokens", () => {
    const file = join(tmpDir, "ci.ts");
    writeFileSync(file, `const token = "ghp_abcdef1234567890abcdef1234567890ab";\n`);
    const warnings = scanForSecrets(file);
    expect(warnings.some((w) => w.type === "token")).toBe(true);
  });

  it("does NOT flag process.env references", () => {
    const file = join(tmpDir, "safe.ts");
    writeFileSync(file, `const apiKey = process.env.API_KEY;\nconst secret = process.env.SECRET;\n`);
    const warnings = scanForSecrets(file);
    expect(warnings).toHaveLength(0);
  });

  it("returns empty array for clean files", () => {
    const file = join(tmpDir, "clean.ts");
    writeFileSync(file, `export function add(a: number, b: number) { return a + b; }\n`);
    const warnings = scanForSecrets(file);
    expect(warnings).toHaveLength(0);
  });

  it("returns empty array for unreadable files", () => {
    const warnings = scanForSecrets(join(tmpDir, "nonexistent.ts"));
    expect(warnings).toHaveLength(0);
  });
});

describe("redactSecrets", () => {
  it("redacts API keys", () => {
    const input = `api_key = "sk-abcdef1234567890abcdef"`;
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED");
    expect(result).not.toContain("sk-abcdef");
  });

  it("redacts connection strings", () => {
    const input = `postgres://admin:password123@localhost:5432/db`;
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED");
  });

  it("redacts private keys", () => {
    const input = `-----BEGIN RSA PRIVATE KEY-----`;
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED");
  });

  it("leaves clean text unchanged", () => {
    const input = "This is just a regular string with no secrets.";
    expect(redactSecrets(input)).toBe(input);
  });

  it("redacts GitHub tokens", () => {
    const input = `token: ghp_abcdef1234567890abcdef1234567890ab`;
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED");
  });
});
