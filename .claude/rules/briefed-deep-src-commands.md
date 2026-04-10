---
paths:
  - "src/commands/**"
---

# src/commands/ — behavioral context

## bench.ts
- **benchCommand**: Routes to quality, serena, or standard bench; runs and writes markdown report.
  - calls: generateQualityReport, generateReport, generateSerenaReport, runBenchmark, runQualityBench
  - called by: cli.ts

## doctor.ts
- **doctorCommand**: Checks CLAUDE.md and briefed outputs for issues; prints fixes for each failure.
  - calls: countTokens
  - called by: cli.ts

## init.ts
- **initCommand**: Detects monorepo/stack, runs extraction pipeline and optional deep analysis, writes skeleton/contracts/rules; exits early if no source files found.
  - calls: buildDeepRules, countTokens, detectMonorepo, detectStack, formatConventions
  - called by: cli.ts

## stats.ts
- **statsCommand**: Reports token sizes and staleness for skeleton, deep rules, and contracts.
  - calls: checkStaleness, countTokens, formatStaleness, formatTokens
  - called by: cli.ts
