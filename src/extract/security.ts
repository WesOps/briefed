import { readFileSync } from "fs";
import { basename } from "path";

export interface SecurityWarning {
  file: string;
  line: number;
  type: SecurityIssueType;
  detail: string;
}

export type SecurityIssueType =
  | "api_key"
  | "password"
  | "secret"
  | "private_key"
  | "connection_string"
  | "token"
  | "sensitive_file";

/** Files that should NEVER be included in context output */
const SENSITIVE_FILENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "credentials.json",
  "service-account.json",
  "secrets.yaml",
  "secrets.yml",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
  ".pem",
  ".key",
]);

/** Patterns that indicate sensitive values in code */
const SECRET_PATTERNS: Array<{ regex: RegExp; type: SecurityIssueType; label: string }> = [
  { regex: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{8,}/i, type: "api_key", label: "API key" },
  { regex: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]+/i, type: "password", label: "password" },
  { regex: /(?:secret|client_secret)\s*[:=]\s*['"][^'"]{8,}/i, type: "secret", label: "secret" },
  { regex: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/i, type: "private_key", label: "private key" },
  { regex: /(?:postgres|mysql|mongodb|redis):\/\/\w+:[^@]+@/i, type: "connection_string", label: "connection string with credentials" },
  { regex: /(?:bearer|token)\s+[a-zA-Z0-9_\-.]{20,}/i, type: "token", label: "auth token" },
  { regex: /(?:aws_secret_access_key|AWS_SECRET)\s*[:=]\s*['"]?[A-Za-z0-9/+=]{20,}/i, type: "secret", label: "AWS secret key" },
  { regex: /(?:ghp_|github_pat_)[a-zA-Z0-9]{30,}/i, type: "token", label: "GitHub token" },
  { regex: /sk-[a-zA-Z0-9]{20,}/i, type: "api_key", label: "OpenAI/Stripe secret key" },
];

/**
 * Check if a file should be excluded from context output for security reasons.
 */
export function isSensitiveFile(filePath: string): boolean {
  const name = basename(filePath);
  if (SENSITIVE_FILENAMES.has(name)) return true;
  if (name.endsWith(".pem") || name.endsWith(".key") || name.endsWith(".p12")) return true;
  if (name.startsWith(".env")) return true;
  return false;
}

/**
 * Scan a file for sensitive data patterns.
 * Returns warnings but does NOT include the actual secret values.
 */
export function scanForSecrets(filePath: string): SecurityWarning[] {
  const warnings: SecurityWarning[] = [];

  // Skip binary files
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip comments that reference secrets generically
      if (line.trim().startsWith("//") || line.trim().startsWith("#")) {
        // Still check for actual hardcoded values in comments
        if (!line.includes("=") && !line.includes(":")) continue;
      }

      for (const pattern of SECRET_PATTERNS) {
        if (pattern.regex.test(line)) {
          // Don't flag env var references (process.env.X, os.environ, etc.)
          if (line.includes("process.env") || line.includes("os.environ") ||
              line.includes("${") || line.includes("getenv")) {
            continue;
          }

          warnings.push({
            file: filePath,
            line: i + 1,
            type: pattern.type,
            detail: `Possible ${pattern.label} found — not included in context output`,
          });
        }
      }
    }
  } catch {
    // Can't read file — skip
  }

  return warnings;
}

/**
 * Redact sensitive values from text before including in context.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern.regex, `[REDACTED ${pattern.label}]`);
  }
  return result;
}
