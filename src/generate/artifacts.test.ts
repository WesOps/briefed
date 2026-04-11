import { describe, it, expect } from "vitest";
import { buildRouteGraph, buildImpactMap } from "./artifacts.js";
import { buildDepGraph } from "../extract/depgraph.js";
import type { FileExtraction, Symbol } from "../extract/signatures.js";
import type { Route } from "../extract/routes.js";
import type { SchemaModel } from "../extract/schema.js";
import type { TestMapping } from "../extract/tests.js";

function sym(partial: Partial<Symbol> & { name: string }): Symbol {
  return {
    kind: "function",
    signature: partial.name + "()",
    description: null,
    exported: true,
    line: 1,
    ...partial,
  };
}

function ext(
  path: string,
  symbols: Symbol[] = [],
  imports: Array<{ source: string; names: string[]; isRelative: boolean }> = [],
): FileExtraction {
  return { path, symbols, imports, lineCount: 10 };
}

describe("buildRouteGraph", () => {
  it("returns null when there are no routes", () => {
    const md = buildRouteGraph([], [], [], []);
    expect(md).toBeNull();
  });

  it("emits a block per route with handler + call chain + tests", () => {
    const routes: Route[] = [
      {
        method: "POST",
        path: "/api/users",
        handler: "createUser",
        file: "src/routes/users.ts",
        middleware: [],
        auth: "required",
        bodySchema: "CreateUserSchema",
      },
    ];
    const extractions: FileExtraction[] = [
      ext("src/routes/users.ts", [
        sym({ name: "createUser", calls: ["validateInput", "userService.create"] }),
      ]),
      ext("src/utils/validation.ts", [
        sym({ name: "validateInput", description: "Validates request payload" }),
      ]),
      ext("src/services/user.ts", [
        sym({ name: "create", description: "Persists a new user" }),
      ]),
    ];
    const schemas: SchemaModel[] = [
      {
        name: "CreateUserSchema",
        source: "src/schemas/user.ts",
        fields: [
          { name: "email", type: "string", optional: false, unique: true, default: null, isPk: false },
          { name: "password", type: "string", optional: false, unique: false, default: null, isPk: false },
        ],
        relations: [],
      },
    ];
    const testMappings: TestMapping[] = [
      {
        sourceFile: "src/routes/users.ts",
        testFile: "src/routes/users.test.ts",
        testNames: ["creates a user"],
        testCount: 4,
        confidence: 0.9,
        candidates: [],
        assertions: new Map(),
      },
    ];

    const md = buildRouteGraph(routes, extractions, schemas, testMappings);
    expect(md).not.toBeNull();
    expect(md).toContain("## POST /api/users [required, body:CreateUserSchema]");
    expect(md).toContain("file: `src/routes/users.ts`");
    expect(md).toContain("handler: `createUser`");
    expect(md).toContain("→ `validateInput`");
    expect(md).toContain("Validates request payload");
    expect(md).toContain("schema fields: email:string, password:string");
    expect(md).toContain("tests: `src/routes/users.test.ts` (4 tests");
  });

  it("deduplicates routes sharing (method, path)", () => {
    const routes: Route[] = [
      { method: "GET", path: "/ping", handler: "ping", file: "a.ts", middleware: [] },
      { method: "GET", path: "/ping", handler: "ping", file: "b.ts", middleware: [] },
    ];
    const md = buildRouteGraph(routes, [], [], [])!;
    const matches = md.match(/## GET \/ping/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("buildImpactMap", () => {
  it("returns null when extractions is empty", () => {
    const extractions: FileExtraction[] = [];
    const depGraph = buildDepGraph(extractions, "/project");
    const md = buildImpactMap(extractions, depGraph, [], [], []);
    expect(md).toBeNull();
  });

  it("projects transitive dependents onto routes and tests", () => {
    // Graph: service.ts ← route.ts  (route imports service)
    const extractions: FileExtraction[] = [
      ext("src/services/user.ts", [sym({ name: "createUser" })]),
      ext("src/routes/user.ts", [sym({ name: "handler" })], [
        { source: "../services/user", names: ["createUser"], isRelative: true },
      ]),
    ];
    const depGraph = buildDepGraph(extractions, "/project");
    const routes: Route[] = [
      { method: "POST", path: "/users", handler: "handler", file: "src/routes/user.ts", middleware: [] },
    ];
    const testMappings: TestMapping[] = [
      {
        sourceFile: "src/routes/user.ts",
        testFile: "src/routes/user.test.ts",
        testNames: [],
        testCount: 2,
        confidence: 0.9,
        candidates: [],
        assertions: new Map(),
      },
    ];

    const md = buildImpactMap(extractions, depGraph, routes, [], testMappings)!;
    // The service file has fan-in=1 (route imports it), so editing it
    // should project onto the route its dependent defines.
    expect(md).toContain("src/services/user.ts");
    expect(md).toContain("POST /users");
    expect(md).toContain("src/routes/user.test.ts");
  });

  it("dedupes identical routes/schemas/tests within a block", () => {
    // Two dependents both define the same-named test target — should appear once.
    const extractions: FileExtraction[] = [
      ext("src/core.ts", [sym({ name: "core" })]),
      ext("src/a.ts", [], [{ source: "./core", names: ["core"], isRelative: true }]),
      ext("src/b.ts", [], [{ source: "./core", names: ["core"], isRelative: true }]),
    ];
    const depGraph = buildDepGraph(extractions, "/project");
    const testMappings: TestMapping[] = [
      { sourceFile: "src/a.ts", testFile: "src/shared.test.ts", testNames: [], testCount: 1, confidence: 1, candidates: [], assertions: new Map() },
      { sourceFile: "src/b.ts", testFile: "src/shared.test.ts", testNames: [], testCount: 1, confidence: 1, candidates: [], assertions: new Map() },
    ];
    const md = buildImpactMap(extractions, depGraph, [], [], testMappings)!;
    // shared.test.ts should appear exactly once in core.ts's block
    const coreBlock = md.split("##").find((b) => b.includes("src/core.ts")) ?? "";
    const matches = coreBlock.match(/src\/shared\.test\.ts/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
