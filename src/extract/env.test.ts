import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { extractEnvVars, formatEnvVars } from "./env.js";

describe("extractEnvVars", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "briefed-test-env-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses .env.example file", () => {
    writeFileSync(
      join(tmpDir, ".env.example"),
      `# Database connection\nDATABASE_URL=postgres://localhost:5432/mydb\nAPI_KEY=\nSECRET=\n`
    );
    const vars = extractEnvVars(tmpDir);
    expect(vars.length).toBe(3);

    const dbVar = vars.find((v) => v.name === "DATABASE_URL");
    expect(dbVar).toBeDefined();
    // Values in .env.example are placeholder examples, not runtime defaults.
    expect(dbVar!.hasDefault).toBe(false);
    expect(dbVar!.required).toBe(true);
    expect(dbVar!.description).toBe("Database connection");
    expect(dbVar!.category).toBe("database");

    const apiKeyVar = vars.find((v) => v.name === "API_KEY");
    expect(apiKeyVar).toBeDefined();
    expect(apiKeyVar!.hasDefault).toBe(false);
    expect(apiKeyVar!.required).toBe(true);
  });

  it("parses .env.sample file", () => {
    writeFileSync(join(tmpDir, ".env.sample"), `REDIS_URL=redis://localhost:6379\n`);
    const vars = extractEnvVars(tmpDir);
    expect(vars.some((v) => v.name === "REDIS_URL")).toBe(true);
  });

  it("scans source files for process.env references", () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "config.ts"),
      `const port = process.env.APP_PORT;\nconst host = process.env['APP_HOST'];\n`
    );
    const vars = extractEnvVars(tmpDir);
    expect(vars.some((v) => v.name === "APP_PORT")).toBe(true);
    expect(vars.some((v) => v.name === "APP_HOST")).toBe(true);
  });

  it("skips common system env vars", () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "app.ts"),
      `const env = process.env.NODE_ENV;\nconst path = process.env.PATH;\n`
    );
    const vars = extractEnvVars(tmpDir);
    expect(vars.some((v) => v.name === "NODE_ENV")).toBe(false);
    expect(vars.some((v) => v.name === "PATH")).toBe(false);
  });

  it("categorizes env vars correctly", () => {
    writeFileSync(
      join(tmpDir, ".env.example"),
      `DATABASE_URL=\nJWT_SECRET=\nAPI_ENDPOINT=\nAWS_S3_BUCKET=\nAPP_NAME=myapp\n`
    );
    const vars = extractEnvVars(tmpDir);
    expect(vars.find((v) => v.name === "DATABASE_URL")!.category).toBe("database");
    expect(vars.find((v) => v.name === "JWT_SECRET")!.category).toBe("auth");
    expect(vars.find((v) => v.name === "API_ENDPOINT")!.category).toBe("api");
    expect(vars.find((v) => v.name === "AWS_S3_BUCKET")!.category).toBe("services");
    expect(vars.find((v) => v.name === "APP_NAME")!.category).toBe("config");
  });

  it(".env.example takes precedence over source scan", () => {
    writeFileSync(
      join(tmpDir, ".env.example"),
      `# My custom API key for external service\nCUSTOM_KEY=default_value\n`
    );
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "app.ts"),
      `const key = process.env.CUSTOM_KEY;\n`
    );
    const vars = extractEnvVars(tmpDir);
    const customKey = vars.find((v) => v.name === "CUSTOM_KEY");
    expect(customKey).toBeDefined();
    // Should have the .env.example data, not the source scan data
    expect(customKey!.source).toBe(".env.example");
    expect(customKey!.description).toBe("My custom API key for external service");
  });

  it("returns empty for project with no env vars", () => {
    const vars = extractEnvVars(tmpDir);
    expect(vars).toHaveLength(0);
  });

  it("treats every .env.example entry as required regardless of placeholder value", () => {
    writeFileSync(
      join(tmpDir, ".env.example"),
      `EMPTY=\nQUOTED_EMPTY=""\nSINGLE_QUOTED=''\nHAS_VALUE=something\n`
    );
    const vars = extractEnvVars(tmpDir);
    expect(vars.find((v) => v.name === "EMPTY")!.required).toBe(true);
    expect(vars.find((v) => v.name === "QUOTED_EMPTY")!.required).toBe(true);
    expect(vars.find((v) => v.name === "SINGLE_QUOTED")!.required).toBe(true);
    // HAS_VALUE has a placeholder value but is still required — `.env.example`
    // values are documentation, not runtime defaults.
    expect(vars.find((v) => v.name === "HAS_VALUE")!.required).toBe(true);
    expect(vars.find((v) => v.name === "HAS_VALUE")!.hasDefault).toBe(false);
  });

  // Regression for the inverted-extraction bug found in the v0.4.0 audit:
  // briefed used to mark `.env.example` placeholder values as `hasDefault`,
  // which silently dropped DATABASE_URL / SESSION_SECRET / etc. from the
  // skeleton's "Required env" output and instead listed CI tooling vars matched
  // from `process.env.X` source references as required.
  it("surfaces realistic placeholder-style entries in formatEnvVars output", () => {
    writeFileSync(
      join(tmpDir, ".env.example"),
      `SESSION_SECRET="super-duper-s3cret"\nDATABASE_URL="postgres://localhost:5432/mydb"\nHONEYPOT_SECRET="placeholder"\n`,
    );
    const vars = extractEnvVars(tmpDir);

    for (const name of ["SESSION_SECRET", "DATABASE_URL", "HONEYPOT_SECRET"]) {
      const v = vars.find((x) => x.name === name);
      expect(v, `${name} should be extracted`).toBeDefined();
      expect(v!.hasDefault).toBe(false);
      expect(v!.required).toBe(true);
    }

    const formatted = formatEnvVars(vars);
    expect(formatted).toContain("SESSION_SECRET");
    expect(formatted).toContain("DATABASE_URL");
    expect(formatted).toContain("HONEYPOT_SECRET");
  });
});

describe("formatEnvVars", () => {
  it("formats env vars grouped by category", () => {
    const vars = [
      { name: "DB_URL", source: ".env.example", hasDefault: false, required: true, description: null, category: "database" },
      { name: "JWT_KEY", source: ".env.example", hasDefault: false, required: true, description: null, category: "auth" },
    ];
    const output = formatEnvVars(vars);
    expect(output).toContain("Required env:");
    expect(output).toContain("database:");
    expect(output).toContain("DB_URL");
    expect(output).toContain("auth:");
    expect(output).toContain("JWT_KEY");
  });

  it("returns empty string for no vars", () => {
    expect(formatEnvVars([])).toBe("");
  });
});
