import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { extractWithAst } from "./ast.js";

describe("extractWithAst", () => {
  const tmpDir = join(import.meta.dirname, "../../.test-ast");

  function writeAndExtract(filename: string, code: string) {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    const filePath = join(tmpDir, filename);
    writeFileSync(filePath, code);
    return extractWithAst(filePath);
  }

  function cleanup() {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  it("extracts exported functions with full signatures", () => {
    const result = writeAndExtract("test.ts", `
export function createUser(name: string, email: string): Promise<User> {
  return db.insert({ name, email });
}
    `);
    cleanup();
    expect(result).not.toBeNull();
    expect(result!.symbols).toHaveLength(1);
    expect(result!.symbols[0].name).toBe("createUser");
    expect(result!.symbols[0].kind).toBe("function");
    expect(result!.symbols[0].signature).toContain("name: string");
    expect(result!.symbols[0].signature).toContain("Promise<User>");
    expect(result!.symbols[0].confidence).toBe("ast");
  });

  it("extracts class with methods", () => {
    const result = writeAndExtract("test.ts", `
export class UserService {
  async findById(id: string): Promise<User | null> {
    return this.db.find(id);
  }
  async create(data: CreateUserDto): Promise<User> {
    return this.db.insert(data);
  }
  private _validate() {}
}
    `);
    cleanup();
    expect(result).not.toBeNull();
    const cls = result!.symbols.find(s => s.name === "UserService");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");
    expect(cls!.confidence).toBe("ast");

    const methods = result!.symbols.filter(s => s.kind === "method");
    expect(methods).toHaveLength(2); // _validate excluded
    expect(methods[0].name).toBe("UserService.findById");
    expect(methods[0].signature).toContain("id: string");
    expect(methods[1].name).toBe("UserService.create");
  });

  it("extracts interfaces and types", () => {
    const result = writeAndExtract("test.ts", `
export interface User {
  id: string;
  name: string;
}

export type UserId = string;

export interface Admin extends User {
  role: string;
}
    `);
    cleanup();
    expect(result).not.toBeNull();
    const iface = result!.symbols.find(s => s.name === "User");
    expect(iface!.kind).toBe("interface");

    const type = result!.symbols.find(s => s.name === "UserId");
    expect(type!.kind).toBe("type");
    expect(type!.signature).toContain("string");

    const admin = result!.symbols.find(s => s.name === "Admin");
    expect(admin!.signature).toContain("extends User");
  });

  it("extracts arrow function exports", () => {
    const result = writeAndExtract("test.ts", `
export const handler = async (req: Request): Promise<Response> => {
  return new Response("ok");
};
    `);
    cleanup();
    expect(result).not.toBeNull();
    const fn = result!.symbols.find(s => s.name === "handler");
    expect(fn).toBeDefined();
    expect(fn!.signature).toContain("req: Request");
    expect(fn!.confidence).toBe("ast");
  });

  it("extracts imports correctly", () => {
    const result = writeAndExtract("test.ts", `
import { readFileSync } from "fs";
import type { User } from "./models.js";
import express from "express";
    `);
    cleanup();
    expect(result).not.toBeNull();
    expect(result!.imports).toHaveLength(3);

    const fsImport = result!.imports.find(i => i.source === "fs");
    expect(fsImport!.names).toContain("readFileSync");
    expect(fsImport!.isRelative).toBe(false);

    const modelImport = result!.imports.find(i => i.source === "./models.js");
    expect(modelImport!.names).toContain("User");
    expect(modelImport!.isRelative).toBe(true);
  });

  it("extracts enums", () => {
    const result = writeAndExtract("test.ts", `
export enum Status {
  Active = "active",
  Inactive = "inactive",
  Deleted = "deleted",
}
    `);
    cleanup();
    expect(result).not.toBeNull();
    const e = result!.symbols.find(s => s.name === "Status");
    expect(e!.kind).toBe("enum");
    expect(e!.signature).toContain("Active");
    expect(e!.signature).toContain("Inactive");
  });

  it("detects route handlers", () => {
    const result = writeAndExtract("route.ts", `
export async function GET(request: Request): Promise<Response> {
  return Response.json({ ok: true });
}

export async function POST(request: Request): Promise<Response> {
  return Response.json({ created: true });
}
    `);
    cleanup();
    expect(result).not.toBeNull();
    const get = result!.symbols.find(s => s.name === "GET");
    expect(get!.kind).toBe("route");
    const post = result!.symbols.find(s => s.name === "POST");
    expect(post!.kind).toBe("route");
  });

  it("extracts JSDoc descriptions", () => {
    // JSDoc extraction is handled by the caller (extractFile), not extractWithAst directly
    // But the AST extractor does read JSDoc via getJSDocCommentsAndTags
    const result = writeAndExtract("test.ts", `
/**
 * Creates a new invoice for a project.
 * @param projectId - The project ID
 */
export function createInvoice(projectId: string): Promise<Invoice> {
  return db.insert(projectId);
}
    `);
    cleanup();
    expect(result).not.toBeNull();
    const fn = result!.symbols.find(s => s.name === "createInvoice");
    expect(fn!.description).toBe("Creates a new invoice for a project.");
  });

  it("populates throws[] for functions with throw statements", () => {
    const result = writeAndExtract("test.ts", `
export function loadConfig(path: string): Config {
  if (!path) throw new ConfigParseError("path required");
  if (path === "bad") throw new ValidationError("invalid");
  return readConfig(path);
}

export function maybeFind(id: string): User | null {
  if (!id) return null;
  return db.find(id) ?? undefined;
}
    `);
    cleanup();
    expect(result).not.toBeNull();

    const loadFn = result!.symbols.find(s => s.name === "loadConfig");
    expect(loadFn).toBeDefined();
    expect(loadFn!.throws).toBeDefined();
    expect(loadFn!.throws).toContain("ConfigParseError");
    expect(loadFn!.throws).toContain("ValidationError");

    const maybeFn = result!.symbols.find(s => s.name === "maybeFind");
    expect(maybeFn).toBeDefined();
    expect(maybeFn!.throws).toBeDefined();
    expect(maybeFn!.throws).toContain("null");
  });

  it("handles JSX/TSX files", () => {
    const result = writeAndExtract("test.tsx", `
import React from "react";

export function UserCard({ name, email }: { name: string; email: string }) {
  return <div>{name} - {email}</div>;
}
    `);
    cleanup();
    expect(result).not.toBeNull();
    const comp = result!.symbols.find(s => s.name === "UserCard");
    expect(comp).toBeDefined();
    expect(comp!.confidence).toBe("ast");
  });
});
