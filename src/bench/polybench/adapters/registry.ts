/**
 * Adapter registry — the single point where adapters get wired into the
 * harness. Adding a new tool: import its adapter here and add one Map entry.
 * That's it.
 */

import type { PolyAdapter } from "../types.js";
import { baselineAdapter } from "./baseline.js";
import { briefedAdapter } from "./briefed.js";
import { briefedOnlyAdapter } from "./briefed-only.js";
import { serenaOnlyAdapter } from "./serena-only.js";
import { briefedAndSerenaAdapter } from "./briefed-and-serena.js";
import { codesightAdapter } from "./codesight.js";
import { repowiseAdapter } from "./repowise.js";
import { jcodemunchAdapter } from "./jcodemunch.js";

export const ADAPTERS: Map<string, PolyAdapter> = new Map([
  ["baseline", baselineAdapter],
  ["briefed", briefedAdapter],
  ["briefed-only", briefedOnlyAdapter],
  ["serena-only", serenaOnlyAdapter],
  ["briefed-and-serena", briefedAndSerenaAdapter],
  ["codesight", codesightAdapter],
  ["repowise", repowiseAdapter],
  ["jcodemunch", jcodemunchAdapter],
]);

/** List the names of all registered adapters (for --help output). */
export function listAdapterNames(): string[] {
  return Array.from(ADAPTERS.keys());
}
