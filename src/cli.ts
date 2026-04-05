#!/usr/bin/env node

import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { statsCommand } from "./commands/stats.js";
import { benchCommand } from "./commands/bench.js";
import { doctorCommand } from "./commands/doctor.js";

const program = new Command();

program
  .name("briefed")
  .description(
    "Adaptive Context Engine — compile your codebase into focused, token-efficient context for AI coding tools"
  )
  .version("0.1.0");

program
  .command("init")
  .description("Scan codebase and compile context (skeleton + gotchas + hooks)")
  .option("--repo <path>", "Repository root path", ".")
  .option("--max-tokens <n>", "Token budget for skeleton", "1000")
  .option("--skip-hooks", "Skip hook installation")
  .option("--skip-rules", "Skip .claude/rules/ generation")
  .action(initCommand);

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
  .option("--quick", "Run 3 tasks (fastest)")
  .option("--full", "Run 10 tasks (most thorough)")
  .option("--with-only", "Only run WITH briefed (skip without)")
  .option("--without-only", "Only run WITHOUT briefed")
  .option("--report-only", "Just generate report from existing transcripts")
  .option("--output <dir>", "Output directory for transcripts")
  .action(benchCommand);

program.parse();
