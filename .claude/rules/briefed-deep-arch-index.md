# Codebase architecture — directory boundaries

Use this map to route bug fixes and features to the correct directory.
When an issue description mentions a concept, find the directory responsible for it here.

## src/bench//
Executes quality and serena benchmarks including claude invocation, repo state capture, and judge evaluation — NOT responsible for the polybench harness or task enumeration; see src/bench/polybench for SWE-PolyBench specifics.

## src/bench/polybench//
Implements the SWE-PolyBench harness including task loading, cost tracking, cell evaluation, and model invocation — NOT responsible for quality/serena benchmarking or core extraction; see src/bench for other benchmark types.

## src/commands//
Entry point layer coordinating CLI operations (init, bench, stats, doctor) by invoking extraction, analysis, and reporting modules — NOT responsible for implementing extraction/analysis/reporting logic itself; see src/extract, src/bench, src/generate, src/deliver.

## src/mcp//
Initializes and registers briefed MCP tools on the server transport — NOT responsible for individual tool implementations or extraction logic; tool implementations live in src/extract.
