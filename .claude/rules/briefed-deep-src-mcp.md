---
paths:
  - "src/mcp/**"
---

# src/mcp/ — behavioral context

## server.ts
- **startMcpServer**: Registers all briefed MCP tools and connects server to stdio transport.
  - calls: blastRadius, findUsages, issueCandidates, routeDetail, schemaLookup
  - called by: cli.ts
