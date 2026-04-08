/**
 * Baseline adapter — no context tool at all.
 *
 * This is the control arm: the model runs against the raw source tree with
 * nothing pre-loaded. Any other adapter's numbers should be compared against
 * baseline to see whether the tool is adding value or just overhead.
 *
 * `setup()` is a no-op. `cleanup()` is omitted.
 */

import type { PolyAdapter } from "../types.js";

export const baselineAdapter: PolyAdapter = {
  name: "baseline",
  async setup(): Promise<void> {
    // Intentional no-op — the baseline arm tests what the model does with
    // no context tool at all.
  },
};
