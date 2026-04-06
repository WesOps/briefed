import { resolve, join } from "path";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { execSync } from "child_process";
import { countTokens } from "../utils/tokens.js";

interface DoctorOptions {
  repo: string;
}

interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  fix: string | null;
}

const MAX_CLAUDE_MD_CHARS = 40_000;

export async function doctorCommand(opts: DoctorOptions) {
  const root = resolve(opts.repo);
  console.log("  briefed doctor\n");

  const checks: Check[] = [];

  // 1. CLAUDE.md exists and is within limits
  const claudeMd = join(root, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    const content = readFileSync(claudeMd, "utf-8");
    const chars = content.length;
    const tokens = countTokens(content);

    if (!content.includes("<!-- briefed:start -->")) {
      checks.push({
        name: "CLAUDE.md has briefed section",
        status: "fail",
        detail: "CLAUDE.md exists but has no briefed section",
        fix: "Run: npx briefed init",
      });
    } else if (chars > MAX_CLAUDE_MD_CHARS) {
      checks.push({
        name: "CLAUDE.md size",
        status: "warn",
        detail: `${chars.toLocaleString()} chars (limit: ${MAX_CLAUDE_MD_CHARS.toLocaleString()}). Claude may not read it fully.`,
        fix: "Run: npx briefed init --max-tokens 600",
      });
    } else {
      checks.push({
        name: "CLAUDE.md",
        status: "pass",
        detail: `${chars.toLocaleString()} chars, ~${tokens} tokens`,
        fix: null,
      });
    }
  } else {
    checks.push({
      name: "CLAUDE.md",
      status: "fail",
      detail: "Not found",
      fix: "Run: npx briefed init",
    });
  }

  // 2. Deep rules (optional — only present when `briefed init --deep` was used)
  const rulesDir = join(root, ".claude", "rules");
  if (existsSync(rulesDir)) {
    const ruleFiles = readdirSync(rulesDir).filter((f) => f.startsWith("briefed-"));
    if (ruleFiles.length > 0) {
      checks.push({
        name: "Deep rules",
        status: "pass",
        detail: `${ruleFiles.length} path-scoped rule files`,
        fix: null,
      });
    }
  }

  // 3. Hooks installed
  const settingsPath = join(root, ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const hooksStr = JSON.stringify(settings.hooks || {});
    const hasSessionStart = hooksStr.includes("session-start");
    const hasPromptSubmit = hooksStr.includes("prompt-submit");

    if (hasSessionStart && hasPromptSubmit) {
      checks.push({
        name: "Hooks",
        status: "pass",
        detail: `SessionStart: yes, PromptSubmit: yes`,
        fix: null,
      });
    } else {
      checks.push({
        name: "Hooks",
        status: "warn",
        detail: `Missing: ${!hasSessionStart ? "SessionStart " : ""}${!hasPromptSubmit ? "PromptSubmit " : ""}`,
        fix: "Run: npx briefed init (without --skip-hooks)",
      });
    }

    // Verify hook scripts exist
    const hooksDir = join(root, ".briefed", "hooks");
    if (existsSync(hooksDir)) {
      const scripts = readdirSync(hooksDir);
      if (!scripts.includes("session-start.js") || !scripts.includes("prompt-submit.js")) {
        checks.push({
          name: "Hook scripts",
          status: "fail",
          detail: "Hook scripts missing from .briefed/hooks/",
          fix: "Run: npx briefed init",
        });
      }
    }
  } else {
    checks.push({
      name: "Hooks",
      status: "fail",
      detail: "No .claude/settings.json found",
      fix: "Run: npx briefed init",
    });
  }

  // 4. Module index + contracts exist
  const indexPath = join(root, ".briefed", "index.json");
  if (existsSync(indexPath)) {
    const index = JSON.parse(readFileSync(indexPath, "utf-8"));
    const moduleCount = index.modules?.length || 0;
    checks.push({
      name: "Module index",
      status: "pass",
      detail: `${moduleCount} modules indexed`,
      fix: null,
    });
  } else {
    checks.push({
      name: "Module index",
      status: "fail",
      detail: "Not found",
      fix: "Run: npx briefed init",
    });
  }

  // 5. Staleness check
  if (existsSync(indexPath)) {
    const indexMtime = statSync(indexPath).mtime;
    const age = Date.now() - indexMtime.getTime();
    const ageHours = Math.round(age / 3600000);

    try {
      const commitsSince = execSync(
        `git log --oneline --since="${indexMtime.toISOString()}" -- "*.ts" "*.tsx" "*.js" "*.jsx" "*.py" "*.go" "*.rs"`,
        { cwd: root, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      const commitCount = commitsSince ? commitsSince.split("\n").length : 0;

      if (commitCount > 10) {
        checks.push({
          name: "Freshness",
          status: "warn",
          detail: `${commitCount} commits since last index (${ageHours}h ago)`,
          fix: "Run: npx briefed init",
        });
      } else if (commitCount > 0) {
        checks.push({
          name: "Freshness",
          status: "pass",
          detail: `${commitCount} commits since last index (${ageHours}h ago)`,
          fix: null,
        });
      } else {
        checks.push({
          name: "Freshness",
          status: "pass",
          detail: `Up to date (indexed ${ageHours}h ago)`,
          fix: null,
        });
      }
    } catch {
      checks.push({
        name: "Freshness",
        status: "pass",
        detail: `Indexed ${ageHours}h ago (not a git repo)`,
        fix: null,
      });
    }
  }

  // 6. Git hook installed
  try {
    const gitDir = execSync("git rev-parse --git-dir", {
      cwd: root, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"]
    }).trim();
    const hookPath = join(root, gitDir, "hooks", "post-commit");
    if (existsSync(hookPath) && readFileSync(hookPath, "utf-8").includes("briefed")) {
      checks.push({ name: "Git hook", status: "pass", detail: "post-commit auto-update installed", fix: null });
    } else {
      checks.push({ name: "Git hook", status: "warn", detail: "Not installed — context won't auto-update", fix: "Run: npx briefed init" });
    }
  } catch {
    checks.push({ name: "Git hook", status: "warn", detail: "Not a git repository", fix: null });
  }

  // 7. Cross-tool files
  if (existsSync(join(root, ".cursorrules"))) {
    checks.push({ name: "Cursor support", status: "pass", detail: ".cursorrules present", fix: null });
  }
  if (existsSync(join(root, "AGENTS.md"))) {
    checks.push({ name: "Cross-tool support", status: "pass", detail: "AGENTS.md present", fix: null });
  }

  // Output
  const icons = { pass: "  OK", warn: "  !!", fail: "  XX" };
  for (const check of checks) {
    const icon = icons[check.status];
    console.log(`${icon}  ${check.name}: ${check.detail}`);
    if (check.fix) {
      console.log(`        Fix: ${check.fix}`);
    }
  }

  const passed = checks.filter((c) => c.status === "pass").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const failed = checks.filter((c) => c.status === "fail").length;

  console.log(`\n  ${passed} passed, ${warned} warnings, ${failed} failed`);

  if (failed > 0) {
    console.log("  Run `npx briefed init` to fix all issues.");
  } else if (warned > 0) {
    console.log("  Everything works. Warnings are non-critical.");
  } else {
    console.log("  Everything looks good!");
  }
}
