/**
 * repowise adapter — STUB, not yet implemented.
 *
 * repowise (https://github.com/repowise-dev/repowise) is a Python package
 * distributed via pip. To wire it up end-to-end we'd need to:
 *   1. Ensure pip + Python are on PATH at bench start (fail-fast if not)
 *   2. `pip install repowise` once per harness run (guard with a module-
 *      level `let installed = false` so we only do it once per process)
 *   3. Per-task: run the right repowise init command in the cloned repo
 *      (likely `repowise init` or `repowise index .` — needs verification
 *      against their current CLI)
 *   4. Verify the MCP server starts correctly (repowise runs a local
 *      dashboard + MCP server, may conflict with the bench's claude -p call)
 *
 * Left as a stub so the adapter shows up in the registry and users get a
 * clear error message if they try to use it prematurely. To implement:
 * follow the pattern in `briefed.ts` and `codesight.ts`, add a pip
 * install + per-task init call, and update this comment.
 */

import type { PolyAdapter } from "../types.js";

export const repowiseAdapter: PolyAdapter = {
  name: "repowise",
  async setup(): Promise<void> {
    throw new Error(
      "repowise adapter not yet implemented — see src/bench/polybench/adapters/repowise.ts for the wiring TODO",
    );
  },
};
