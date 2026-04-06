import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { extractRoutes, formatRoutes } from "./routes.js";

describe("extractRoutes — auth and schema enrichment", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "briefed-routes-"));
    writeFileSync(join(tmpDir, "package.json"), '{"name":"test","dependencies":{"express":"*"}}');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scopes auth detection to each route, not the whole file", () => {
    writeFileSync(
      join(tmpDir, "api.ts"),
      `import express from 'express';
import { requireAuth, requireRole } from './middleware';

const CreateUserSchema = z.object({});

const app = express();

app.post('/api/users', requireAuth, validateBody(CreateUserSchema), async (req, res) => {});
app.delete('/api/users/:id', requireRole('admin'), async (req, res) => {});
app.get('/api/health', async (req, res) => {});
`,
    );

    const routes = extractRoutes(tmpDir);
    const post = routes.find((r) => r.method === "POST");
    const del = routes.find((r) => r.method === "DELETE");
    const get = routes.find((r) => r.method === "GET");

    expect(post?.auth).toBe("required");
    expect(post?.bodySchema).toBe("CreateUserSchema");

    expect(del?.auth).toBe("role:admin");
    expect(del?.bodySchema).toBeNull();

    expect(get?.auth).toBeNull();
    expect(get?.bodySchema).toBeNull();
  });

  it("strips internal _matchPos field before returning", () => {
    writeFileSync(
      join(tmpDir, "api.ts"),
      `import express from 'express';
const app = express();
app.get('/x', (req, res) => {});
`,
    );
    const routes = extractRoutes(tmpDir);
    expect(routes[0]).not.toHaveProperty("_matchPos");
  });

  it("formats route metadata as bracketed tags", () => {
    writeFileSync(
      join(tmpDir, "api.ts"),
      `import express from 'express';
const app = express();
app.post('/api/users', requireAuth, async (req, res) => {
  const data = CreateUserSchema.parse(req.body);
});
`,
    );
    const routes = extractRoutes(tmpDir);
    const formatted = formatRoutes(routes);
    expect(formatted).toContain("POST /api/users");
    expect(formatted).toContain("required");
    expect(formatted).toContain("body:CreateUserSchema");
  });

  it("detects Next.js route handler auth via getServerSession", () => {
    mkdirSync(join(tmpDir, "src", "app", "api", "me"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "app", "api", "me", "route.ts"),
      `import { getServerSession } from 'next-auth';
export async function GET(req) {
  const session = await getServerSession();
  return Response.json({ user: session.user });
}
`,
    );
    const routes = extractRoutes(tmpDir);
    const me = routes.find((r) => r.path.includes("me"));
    expect(me?.auth).toBe("required");
  });
});
