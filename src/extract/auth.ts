import { readFileSync } from "fs";
import { glob } from "glob";
import { join } from "path";

export interface AuthInfo {
  provider: string;          // "next-auth" | "clerk" | "auth0" | "lucia" | "passport" | "custom"
  strategy: string[];        // "github" | "google" | "email" | "credentials" | "jwt"
  roles: string[];           // detected role names
  protectedPaths: string[];  // routes/pages with auth guards
  middlewareFile: string | null;
  sessionStore: string | null; // "database" | "jwt" | "cookie" | "redis"
}

export function extractAuth(root: string): AuthInfo | null {
  const info: AuthInfo = {
    provider: "custom",
    strategy: [],
    roles: [],
    protectedPaths: [],
    middlewareFile: null,
    sessionStore: null,
  };

  // Detect provider from package.json
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (deps["next-auth"] || deps["@auth/core"]) info.provider = "next-auth";
    else if (deps["@clerk/nextjs"] || deps["@clerk/clerk-js"]) info.provider = "clerk";
    else if (deps["auth0"] || deps["@auth0/nextjs-auth0"]) info.provider = "auth0";
    else if (deps["@lucia-auth/core"] || deps["lucia"]) info.provider = "lucia";
    else if (deps["passport"]) info.provider = "passport";
    else if (deps["@supabase/auth-helpers-nextjs"] || deps["@supabase/ssr"]) info.provider = "supabase-auth";
    else if (deps["firebase-admin"] || deps["firebase"]) info.provider = "firebase-auth";
    else return null; // No auth library detected
  } catch { return null; }

  const sourceFiles = glob.sync("**/*.{ts,tsx,js,jsx}", {
    cwd: root,
    ignore: ["node_modules/**", "dist/**", "test/**"],
  });

  for (const f of sourceFiles) {
    let content: string;
    try { content = readFileSync(join(root, f), "utf-8"); } catch { continue; }

    // Detect OAuth providers
    for (const provider of ["github", "google", "apple", "discord", "twitter", "facebook", "microsoft", "gitlab", "okta", "auth0"]) {
      if (content.toLowerCase().includes(`${provider}provider`) || content.includes(`provider: '${provider}'`) || content.includes(`provider: "${provider}"`)) {
        if (!info.strategy.includes(provider)) info.strategy.push(provider);
      }
    }

    // Credentials / email+password
    if (content.includes("CredentialsProvider") || content.includes("credentials") && content.includes("password")) {
      if (!info.strategy.includes("credentials")) info.strategy.push("credentials");
    }

    // JWT detection
    if (content.includes("jwt") || content.includes("jsonwebtoken") || content.includes("jose")) {
      info.sessionStore = "jwt";
    }

    // Role detection
    const roleRegex = /(?:role|Role)\s*(?:===?\s*|:\s*|=\s*)['"](\w+)['"]/g;
    for (const m of content.matchAll(roleRegex)) {
      const role = m[1].toLowerCase();
      if (["admin", "user", "moderator", "editor", "viewer", "manager", "owner", "member", "superadmin"].includes(role)) {
        if (!info.roles.includes(role)) info.roles.push(role);
      }
    }

    // Enum-based roles
    const enumRoleRegex = /enum\s+(?:\w*Role\w*)\s*\{([^}]+)\}/;
    const enumMatch = content.match(enumRoleRegex);
    if (enumMatch) {
      const roles = enumMatch[1].match(/(\w+)/g);
      if (roles) {
        for (const r of roles) {
          const role = r.toLowerCase();
          if (!info.roles.includes(role)) info.roles.push(role);
        }
      }
    }

    // Middleware file detection
    if (f.includes("middleware") && (content.includes("auth") || content.includes("session") || content.includes("token"))) {
      info.middlewareFile = f;
    }

    // Protected paths from middleware matchers
    const matcherRegex = /matcher\s*[:=]\s*\[([\s\S]*?)\]/;
    const matcherMatch = content.match(matcherRegex);
    if (matcherMatch) {
      const paths = matcherMatch[1].match(/['"]([^'"]+)['"]/g);
      if (paths) {
        for (const p of paths) {
          const cleanPath = p.replace(/['"]/g, "");
          if (!info.protectedPaths.includes(cleanPath)) info.protectedPaths.push(cleanPath);
        }
      }
    }

    // Session store detection
    if (content.includes("PrismaAdapter") || content.includes("DrizzleAdapter") || content.includes("database")) {
      if (!info.sessionStore) info.sessionStore = "database";
    }
    if (content.includes("redis") && content.includes("session")) {
      info.sessionStore = "redis";
    }
  }

  // If no strategies found but provider exists, return minimal info
  if (info.strategy.length === 0 && info.provider !== "custom") {
    info.strategy.push("configured");
  }

  return info;
}

export function formatAuth(auth: AuthInfo | null): string {
  if (!auth) return "";

  const parts: string[] = [`Auth: ${auth.provider}`];
  if (auth.strategy.length > 0) parts[0] += ` (${auth.strategy.join(", ")})`;
  if (auth.sessionStore) parts.push(`  session: ${auth.sessionStore}`);
  if (auth.roles.length > 0) parts.push(`  roles: ${auth.roles.join(", ")}`);
  if (auth.middlewareFile) parts.push(`  middleware: ${auth.middlewareFile}`);
  if (auth.protectedPaths.length > 0) {
    parts.push(`  protected: ${auth.protectedPaths.slice(0, 10).join(", ")}`);
  }
  return parts.join("\n");
}
