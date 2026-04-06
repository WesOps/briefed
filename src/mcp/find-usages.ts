import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { loadCachedExtractions } from "./cached-loader.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

interface CallSite {
  file: string;
  line: number;
  context: string;
}

/**
 * Find every call site of a symbol across the codebase.
 *
 * Strategy:
 *   1. Look up files that import the symbol via depGraph.symbolRefs
 *      (this is precomputed and instant).
 *   2. Open only those files and scan for occurrences of the symbol name
 *      with a word-boundary regex. Skip the import line itself.
 *   3. Return file:line + the matching line as context.
 *
 * Much faster and higher-signal than blanket grep because we never look
 * at files that don't import the symbol.
 */
export function findUsages(root: string, name: string): CallToolResult {
  const { extractions, depGraph } = loadCachedExtractions(root);

  // Locate the defining file(s) for this symbol so we have a definition pin.
  const definitions: Array<{ file: string; line: number; signature: string }> = [];
  for (const ext of extractions) {
    for (const sym of ext.symbols) {
      if (sym.name === name) {
        definitions.push({ file: ext.path, line: sym.line, signature: sym.signature });
      }
    }
  }

  // Aggregate caller files across every definition (most symbols are
  // unique, but exports of the same name in different files do exist).
  const callerFiles = new Set<string>();
  for (const def of definitions) {
    const refs = depGraph.symbolRefs.get(`${def.file}#${name}`) || [];
    for (const f of refs) callerFiles.add(f);
  }

  if (definitions.length === 0 && callerFiles.size === 0) {
    return {
      content: [{ type: "text", text: `No symbol named "${name}" found in the codebase.` }],
      isError: true,
    };
  }

  // Word-boundary match. We deliberately keep this simple — false positives
  // on a comment that mentions the name are cheap; false negatives are not.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordRe = new RegExp(`\\b${escaped}\\b`);

  const callSites: CallSite[] = [];
  for (const file of callerFiles) {
    const abs = join(root, file);
    if (!existsSync(abs)) continue;
    let content: string;
    try {
      content = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!wordRe.test(line)) continue;
      // Skip the import line itself — we already know they import it.
      if (/^\s*import\b/.test(line)) continue;
      callSites.push({
        file,
        line: i + 1,
        context: line.trim().slice(0, 160),
      });
    }
  }

  // Group by file for readable output
  const byFile = new Map<string, CallSite[]>();
  for (const site of callSites) {
    const arr = byFile.get(site.file) || [];
    arr.push(site);
    byFile.set(site.file, arr);
  }

  const out: string[] = [];
  out.push(`# Usages of \`${name}\``);
  out.push("");
  if (definitions.length > 0) {
    out.push(`**Defined in:**`);
    for (const def of definitions) {
      out.push(`- \`${def.file}:${def.line}\` — \`${def.signature}\``);
    }
    out.push("");
  }

  if (callSites.length === 0) {
    out.push("No call sites found in importing files (symbol may be re-exported only, or unused).");
    return { content: [{ type: "text", text: out.join("\n") }] };
  }

  out.push(`**${callSites.length} call site${callSites.length === 1 ? "" : "s"} across ${byFile.size} file${byFile.size === 1 ? "" : "s"}:**`);
  out.push("");

  // Cap output so we don't blow up the response on hot symbols.
  const MAX_FILES = 20;
  const MAX_PER_FILE = 5;
  let filesShown = 0;
  for (const [file, sites] of byFile) {
    if (filesShown++ >= MAX_FILES) {
      out.push(`*... ${byFile.size - MAX_FILES} more files omitted*`);
      break;
    }
    out.push(`### \`${file}\``);
    for (const site of sites.slice(0, MAX_PER_FILE)) {
      out.push(`- L${site.line}: \`${site.context}\``);
    }
    if (sites.length > MAX_PER_FILE) {
      out.push(`- *... ${sites.length - MAX_PER_FILE} more in this file*`);
    }
    out.push("");
  }

  return { content: [{ type: "text", text: out.join("\n") }] };
}
