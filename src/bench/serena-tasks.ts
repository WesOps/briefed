import type { BenchTask } from "./runner.js";

/**
 * Task set for the "does briefed add anything on top of Serena?" comparison.
 *
 * These tasks are intentionally biased toward briefed's unique strengths:
 *   - Pre-loaded orientation (skeleton is in CLAUDE.md before turn 1)
 *   - Cross-file joined metadata (routes + schemas + env + deps + conventions)
 *   - Repo-wide summaries (conventions, dependency graph, API surface)
 *   - Adaptive per-prompt injection (UserPromptSubmit hook)
 *
 * Generic coding tasks (single-file bugfix, rename-symbol, stack-trace debug)
 * are deliberately excluded — Serena's symbol resolution wins those on merit,
 * and including them would measure the wrong hypothesis.
 *
 * Prompts are strategy-neutral: they describe the outcome, not the approach.
 * The model chooses whether to use Read, Grep, Serena's MCP tools, briefed's
 * MCP tools, or its pre-loaded context.
 */
export const SERENA_COMPARE_TASKS: BenchTask[] = [
  {
    name: "explain-architecture",
    prompt:
      "Explain the overall architecture of this project in one paragraph per top-level module. Cover what each module does, how they connect, and which one is the entry point.",
  },
  {
    name: "list-cli-commands",
    prompt:
      "List every CLI command this tool exposes, including flags and a one-line description of what each does. Produce a markdown table.",
  },
  {
    name: "env-var-audit",
    prompt:
      "What environment variables does this project read? For each one, name the variable, say whether it is required or optional, and name the file(s) where it is consumed.",
  },
  {
    name: "trace-extraction-pipeline",
    prompt:
      "Trace the extraction pipeline end-to-end: from the moment a user runs `briefed init`, what steps run, in what order, producing what outputs? Name the specific functions involved at each step.",
  },
  {
    name: "add-mcp-tool-plan",
    prompt:
      "I want to add a new MCP tool called `blame_lookup` that finds the git author of a given symbol. Which existing files would I need to touch, and in what order, to add this cleanly? Do not write the code — just produce the change plan.",
  },
  {
    name: "convention-discovery",
    prompt:
      "Describe the conventions this codebase follows for: (a) error handling, (b) logging, (c) test file naming, (d) named vs default exports. Cite one concrete example from the code for each.",
  },
];
