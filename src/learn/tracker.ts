import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

/**
 * Learning loop: tracks what context was useful per prompt pattern.
 * Over time, improves the adaptive hook's predictions.
 *
 * How it works:
 * 1. UserPromptSubmit hook injects context for modules A, B based on keywords
 * 2. PostToolUse hook (Read matcher) logs which files Claude actually read
 * 3. If Claude read files from module C (not injected), that's a MISS
 * 4. Over time, associate "prompts about X" with "also need module C"
 *
 * Storage: simple JSON file (no SQLite dependency for now)
 */

interface LearningRecord {
  promptKeywords: string[];
  injectedModules: string[];
  accessedModules: string[];
  misses: string[];        // modules Claude needed but weren't injected
  timestamp: string;
}

interface LearningStore {
  records: LearningRecord[];
  moduleRelevance: Record<string, Record<string, number>>; // keyword → module → score
  version: number;
}

const STORE_FILE = "learning.json";
const MAX_RECORDS = 200;

/**
 * Load the learning store.
 */
export function loadStore(root: string): LearningStore {
  const storePath = join(root, ".briefed", STORE_FILE);
  if (existsSync(storePath)) {
    try {
      return JSON.parse(readFileSync(storePath, "utf-8"));
    } catch {
      // Corrupt store — start fresh
    }
  }
  return { records: [], moduleRelevance: {}, version: 1 };
}

/**
 * Save the learning store.
 */
export function saveStore(root: string, store: LearningStore) {
  const briefedDir = join(root, ".briefed");
  if (!existsSync(briefedDir)) mkdirSync(briefedDir, { recursive: true });

  // Trim old records
  if (store.records.length > MAX_RECORDS) {
    store.records = store.records.slice(-MAX_RECORDS);
  }

  writeFileSync(join(briefedDir, STORE_FILE), JSON.stringify(store, null, 2));
}

/**
 * Record a session's context usage.
 * Called by the learning hook after a session ends or periodically.
 */
export function recordSession(
  store: LearningStore,
  promptKeywords: string[],
  injectedModules: string[],
  accessedFiles: string[],
  moduleIndex: Array<{ name: string; dir: string; files: string[] }>
): LearningStore {
  // Map accessed files to modules
  const accessedModules = new Set<string>();
  for (const file of accessedFiles) {
    for (const mod of moduleIndex) {
      if (mod.files.some((f) => file.includes(f) || f.includes(file))) {
        accessedModules.add(mod.name);
      }
    }
  }

  // Detect misses: modules Claude accessed but we didn't inject
  const injectedSet = new Set(injectedModules);
  const misses = [...accessedModules].filter((m) => !injectedSet.has(m));

  // Record
  store.records.push({
    promptKeywords,
    injectedModules,
    accessedModules: [...accessedModules],
    misses,
    timestamp: new Date().toISOString(),
  });

  // Update relevance scores
  // For each keyword in the prompt, increase the score for modules that were accessed
  for (const keyword of promptKeywords) {
    if (!store.moduleRelevance[keyword]) {
      store.moduleRelevance[keyword] = {};
    }
    for (const mod of accessedModules) {
      const current = store.moduleRelevance[keyword][mod] || 0;
      store.moduleRelevance[keyword][mod] = current + 1;
    }
    // Slight boost for misses (we should have injected these)
    for (const miss of misses) {
      const current = store.moduleRelevance[keyword][miss] || 0;
      store.moduleRelevance[keyword][miss] = current + 2; // double weight for misses
    }
  }

  return store;
}

/**
 * Get learned module suggestions for a set of keywords.
 * Returns modules sorted by relevance score.
 */
export function getLearnedModules(
  store: LearningStore,
  promptKeywords: string[],
  limit: number = 5
): Array<{ module: string; score: number }> {
  const scores = new Map<string, number>();

  for (const keyword of promptKeywords) {
    const relevance = store.moduleRelevance[keyword];
    if (!relevance) continue;

    for (const [mod, score] of Object.entries(relevance)) {
      scores.set(mod, (scores.get(mod) || 0) + score);
    }
  }

  return [...scores.entries()]
    .map(([module, score]) => ({ module, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Generate the PostToolUse hook script that tracks file reads.
 */
export function generateLearningHookScript(): string {
  return `#!/usr/bin/env node
// briefed: PostToolUse hook — tracks which files Claude reads for the learning loop
// Security: only appends to .briefed/session-reads.json, never reads prompt content
const { appendFileSync, mkdirSync, existsSync } = require("fs");
const { join } = require("path");

let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    // Only track Read tool calls
    if (data.tool_name !== "Read") { process.exit(0); return; }

    const filePath = data.tool_input?.file_path;
    if (!filePath) { process.exit(0); return; }

    // Append to session reads log (one line per file read)
    const briefedDir = join(process.cwd(), ".briefed");
    if (!existsSync(briefedDir)) mkdirSync(briefedDir, { recursive: true });
    appendFileSync(
      join(briefedDir, "session-reads.log"),
      filePath + "\\n"
    );
  } catch {}
  process.exit(0);
});
`.trim();
}
