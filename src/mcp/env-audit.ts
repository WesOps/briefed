import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { extractEnvVars } from "../extract/env.js";
import { buildEnvAudit } from "../generate/artifacts.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Full environment variable audit: every var the app reads, whether it's
 * required or optional, its category, and which files consume it.
 */
export function envAudit(root: string): CallToolResult {
  // Serve pre-built artifact if fresh (written by `briefed init`)
  const artifactPath = join(root, ".briefed", "artifacts", "env-audit.md");
  if (existsSync(artifactPath)) {
    try {
      return { content: [{ type: "text", text: readFileSync(artifactPath, "utf-8") }] };
    } catch { /* fall through to live generation */ }
  }

  // Live generation fallback (no init needed)
  const vars = extractEnvVars(root);
  if (vars.length === 0) {
    return {
      content: [{ type: "text", text: "No environment variables found. Checked: .env.example, .env.sample, process.env references in source files." }],
    };
  }

  return { content: [{ type: "text", text: buildEnvAudit(root, vars) }] };
}
