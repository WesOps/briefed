import { readFileSync } from "fs";
import { glob } from "glob";
import { join } from "path";

export interface Deprecation {
  symbol: string;     // function/class/file name
  file: string;
  reason: string;
  replacement?: string;
}

export function extractDeprecations(root: string): Deprecation[] {
  const deprecations: Deprecation[] = [];

  const sourceFiles = glob.sync("**/*.{ts,tsx,js,jsx,py,go,rs}", {
    cwd: root,
    ignore: ["node_modules/**", "dist/**", "venv/**", ".venv/**", "target/**"],
  });

  for (const f of sourceFiles) {
    let content: string;
    try { content = readFileSync(join(root, f), "utf-8"); } catch { continue; }

    // @deprecated JSDoc tag
    const jsdocRegex = /@deprecated\s*(.*)[\s\S]*?(?:export\s+)?(?:function|class|const|let|var|type|interface)\s+(\w+)/g;
    for (const m of content.matchAll(jsdocRegex)) {
      const reason = m[1].trim().replace(/\*\/$/, "").trim();
      const replacement = reason.match(/use\s+(\w+)/i)?.[1];
      deprecations.push({
        symbol: m[2],
        file: f,
        reason: reason || "deprecated",
        replacement,
      });
    }

    // TypeScript @deprecated decorator (less common)
    const decoratorRegex = /@Deprecated\s*\(?\s*['"]([^'"]*)['"]\s*\)?\s*\n\s*(?:export\s+)?(?:function|class)\s+(\w+)/g;
    for (const m of content.matchAll(decoratorRegex)) {
      deprecations.push({ symbol: m[2], file: f, reason: m[1] });
    }

    // Python deprecation warnings
    const pyDepRegex = /warnings\.warn\s*\(\s*['"]([^'"]*deprecated[^'"]*)['"]/gi;
    for (const m of content.matchAll(pyDepRegex)) {
      const funcMatch = content.slice(0, m.index).match(/def\s+(\w+)/g);
      const symbol = funcMatch ? funcMatch[funcMatch.length - 1].replace("def ", "") : f;
      deprecations.push({ symbol, file: f, reason: m[1] });
    }

    // TODO: remove / TODO: delete patterns
    const removeRegex = /(?:\/\/|#)\s*(?:TODO|FIXME):\s*(remove|delete|deprecate)\s+(.+?)$/gim;
    for (const m of content.matchAll(removeRegex)) {
      deprecations.push({
        symbol: m[2].trim().split(/\s/)[0],
        file: f,
        reason: `${m[1]} — ${m[2].trim()}`,
      });
    }
  }

  return deprecations;
}

export function formatDeprecations(deprecations: Deprecation[]): string {
  if (deprecations.length === 0) return "";

  const lines: string[] = ["Deprecated:"];
  for (const d of deprecations.slice(0, 15)) {
    let line = `  ${d.symbol} (${d.file})`;
    if (d.replacement) line += ` → use ${d.replacement}`;
    else if (d.reason && d.reason !== "deprecated") line += ` — ${d.reason}`;
    lines.push(line);
  }
  if (deprecations.length > 15) lines.push(`  ... +${deprecations.length - 15} more`);
  return lines.join("\n");
}
