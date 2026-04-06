#!/usr/bin/env node

import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { planCommand } from "./commands/plan.js";
import { statsCommand } from "./commands/stats.js";
import { benchCommand } from "./commands/bench.js";
import { doctorCommand } from "./commands/doctor.js";
import { removeGitHook } from "./deliver/git-hook.js";
import { startMcpServer } from "./mcp/server.js";
import { resolve } from "path";

const program = new Command();

program
  .name("briefed")
  .description(
    "Adaptive Context Engine — compile your codebase into focused, token-efficient context for AI coding tools"
  )
  .version("0.3.0");

program
  .command("init")
  .description("Scan codebase and compile context (skeleton + gotchas + hooks)")
  .option("--repo <path>", "Repository root path", ".")
  .option("--max-tokens <n>", "Token budget for skeleton (default: auto-scaled by project size)", "auto")
  .option("--skip-hooks", "Skip hook installation")
  .option("--skip-rules", "Skip .claude/rules/ generation")
  .option("--deep", "LLM-powered behavioral descriptions via `claude -p` subscription (path-scoped rules + system overview). Cached by SHA256, so re-runs are near-free.")
  .action(initCommand);

program
  .command("plan")
  .description("Preview what briefed will generate — file counts, token estimates, features — without writing anything")
  .option("--repo <path>", "Repository root path", ".")
  .action(planCommand);

program
  .command("stats")
  .description("Show token usage and context statistics")
  .option("--repo <path>", "Repository root path", ".")
  .action(statsCommand);

program
  .command("doctor")
  .description("Validate briefed setup and diagnose issues")
  .option("--repo <path>", "Repository root path", ".")
  .action(doctorCommand);

program
  .command("bench")
  .description("Benchmark briefed vs default Claude Code (uses your subscription)")
  .option("--repo <path>", "Repository to benchmark", ".")
  .option("--quick", "Run 2 tasks (fastest)")
  .option("--full", "Run all 5 tasks (most thorough)")
  .option("--with-only", "Only run WITH briefed (skip without)")
  .option("--without-only", "Only run WITHOUT briefed")
  .option("--report-only", "Just generate report from existing transcripts")
  .option("--output <dir>", "Output directory for transcripts")
  .option("--timeout <seconds>", "Per-task timeout in seconds (default 600)")
  .option("--no-resume", "Re-run tasks even if cached results exist")
  .option("--compare-deep", "Also run a third arm with `briefed init --deep` (LLM-annotated rules via claude -p)")
  .option("--serena-compare", "Compare Serena-only vs Serena+briefed. Requires Serena pre-registered in .claude/settings.json")
  .action(benchCommand);

program
  .command("unhook")
  .description("Remove briefed's git post-commit hook")
  .option("--repo <path>", "Repository root path", ".")
  .action((opts: { repo: string }) => {
    const root = resolve(opts.repo);
    removeGitHook(root);
    console.log("  Removed briefed git hook.");
  });

program
  .command("mcp")
  .description("Start MCP server (blast-radius, symbol, schema, routes) for AI tools")
  .option("--repo <path>", "Repository root path", ".")
  .action(async (opts: { repo: string }) => {
    await startMcpServer(opts.repo);
  });

program.parse();
