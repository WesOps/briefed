---
paths:
  - "src/bench/**"
---

# src/bench/ — behavioral context

## quality.ts
- **enumerateArms**: Builds arm list from DEFAULT_MATRIX; appends FULL_EXTRA if full flag set; filters to named labels if opts.arms provided.
  - called by: quality.test.ts
- Tests: "enumerateArms", "defaults to all 4 arms in the default matrix", "A = no-serena, no-briefed, no-hooks", "D = serena, briefed-deep, no-hooks (default 4-arm matrix is hooks-off)", "--arms C,D filters to only the listed arms"

## repo-state.ts
- **snapshotRepoState**: Captures tracked files and directory trees into an in-memory snapshot.
  - called by: quality.ts, repo-state.test.ts
- **restoreRepoState**: Restores files/dirs from snapshot; deletes files absent at snapshot time.
  - called by: quality.ts, repo-state.test.ts
- Tests: "RepoState", "restores CLAUDE.md, settings.json, rules/, .briefed/ to snapshot state", "restores missing files to missing state", "excludes the quality bench output dir from the .briefed snapshot"

## shared.ts
- **findClaude**: Probes candidate claude binary paths via spawnSync; returns first working path or null.
  - called by: orchestrator.ts, quality.ts, runner.ts
- **runClaudeTask**: Spawns claude -p with stream-json output, captures stdout; throws on spawn error.
  - throws: Error
  - called by: quality.ts, runner.ts
- Tests: "shared helpers", "stripBriefedPreservingMcp leaves non-briefed MCP servers alone", "findClaude returns a string or null without throwing", "isMcpServerRegistered returns boolean without throwing"
