/**
 * jcodemunch adapter — STUB, not yet implemented.
 *
 * jcodemunch-mcp (https://github.com/jgravelle/jcodemunch-mcp) is a Python
 * package distributed via pip with dual-use licensing (free for personal,
 * commercial tiers from $79). To wire it up end-to-end we'd need to:
 *   1. Ensure pip + Python are on PATH
 *   2. `pip install jcodemunch-mcp` once per harness run
 *   3. Per-task: run `jcodemunch-mcp index .` (or the current indexer
 *      command — needs verification against their CLI)
 *   4. Handle commercial-license gating if running at scale
 *
 * Left as a stub so the adapter shows up in the registry and users get a
 * clear error message if they try to use it prematurely. To implement:
 * follow the pattern in `briefed.ts` and `codesight.ts`.
 */

import type { PolyAdapter } from "../types.js";

export const jcodemunchAdapter: PolyAdapter = {
  name: "jcodemunch",
  async setup(): Promise<void> {
    throw new Error(
      "jcodemunch adapter not yet implemented — see src/bench/polybench/adapters/jcodemunch.ts for the wiring TODO",
    );
  },
};
