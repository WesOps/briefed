import { readFileSync } from "fs";

export interface Gotcha {
  file: string;
  line: number;
  category: GotchaCategory;
  text: string;
}

export type GotchaCategory =
  | "important_comment"   // TODO/HACK/NOTE/WARNING/FIXME with important info
  | "guard_clause"        // throw/raise at function entry (validation, permissions)
  | "state_transition"    // switch/case on status/state fields
  | "ordering_dep"        // must-call-before pattern
  | "side_effect"         // emits events, writes to DB, calls external service
  | "soft_delete"         // deletedAt/isDeleted patterns
  | "unique_constraint"   // uniqueness checks
  | "cross_entity_read";  // reads value from a different entity

/**
 * Extract gotchas from a source file.
 * These are non-obvious constraints that cause bugs when AI misses them.
 */
export function extractGotchas(filePath: string): Gotcha[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const gotchas: Gotcha[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Important comments (not just any TODO — ones with meaningful constraints)
    const commentMatch = trimmed.match(
      /(?:\/\/|#|\/\*)\s*(TODO|HACK|FIXME|NOTE|IMPORTANT|WARNING|WARN|BUG|XXX|SAFETY|INVARIANT)\s*:?\s*(.+)/i
    );
    if (commentMatch) {
      const text = commentMatch[2].trim().replace(/\*\/\s*$/, "");
      // Filter out trivial TODOs like "TODO: add tests" or "TODO: refactor"
      if (text.length > 15 && !isTrivialComment(text)) {
        gotchas.push({
          file: filePath,
          line: i + 1,
          category: "important_comment",
          text: `${commentMatch[1]}: ${text}`,
        });
      }
    }

    // Guard clauses — throw/raise at start of function
    const guardMatch = trimmed.match(
      /(?:throw\s+new\s+(\w+Error)\s*\(|raise\s+(\w+)\s*\(|panic\s*\()['"](.+?)['"]/
    );
    if (guardMatch) {
      const errorType = guardMatch[1] || guardMatch[2] || "panic";
      const message = guardMatch[3] || "";
      // Look at context — is this inside an if block (guard pattern)?
      const prevLines = lines.slice(Math.max(0, i - 3), i).join(" ");
      if (prevLines.match(/if\s*\(/)) {
        gotchas.push({
          file: filePath,
          line: i + 1,
          category: "guard_clause",
          text: `Throws ${errorType}: ${message}`,
        });
      }
    }

    // State transitions — switch on status/state
    const stateMatch = trimmed.match(
      /switch\s*\(\s*\w+\.(status|state|phase|stage|step)\s*\)/i
    );
    if (stateMatch) {
      // Extract case values
      const cases: string[] = [];
      for (let j = i + 1; j < Math.min(i + 30, lines.length); j++) {
        const caseLine = lines[j].trim();
        if (caseLine === "}") break;
        const caseMatch = caseLine.match(/case\s+['"]?(\w+)['"]?\s*:/);
        if (caseMatch) cases.push(caseMatch[1]);
      }
      if (cases.length > 0) {
        gotchas.push({
          file: filePath,
          line: i + 1,
          category: "state_transition",
          text: `Status transitions: ${cases.join(" → ")}`,
        });
      }
    }

    // Enum-based state machines
    const enumStateMatch = trimmed.match(
      /enum\s+(\w*(?:Status|State|Phase|Stage)\w*)/
    );
    if (enumStateMatch) {
      const values: string[] = [];
      for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
        const valLine = lines[j].trim();
        if (valLine === "}" || valLine === "}") break;
        const valMatch = valLine.match(/^(\w+)\s*[=,]/);
        if (valMatch) values.push(valMatch[1]);
      }
      if (values.length > 0) {
        gotchas.push({
          file: filePath,
          line: i + 1,
          category: "state_transition",
          text: `${enumStateMatch[1]} values: ${values.join(", ")}`,
        });
      }
    }

    // Side effects — event emission
    const eventMatch = trimmed.match(
      /(?:emit|publish|dispatch|send|fire|trigger)\s*\(\s*['"](\w+)['"]/i
    );
    if (eventMatch) {
      gotchas.push({
        file: filePath,
        line: i + 1,
        category: "side_effect",
        text: `Emits event: ${eventMatch[1]}`,
      });
    }

    // Soft delete patterns
    const softDeleteMatch = trimmed.match(
      /(?:deletedAt|deleted_at|isDeleted|is_deleted|archivedAt|archived_at)\s*[!=:]/
    );
    if (softDeleteMatch && !trimmed.startsWith("//") && !trimmed.startsWith("#")) {
      gotchas.push({
        file: filePath,
        line: i + 1,
        category: "soft_delete",
        text: "Uses soft deletes — queries must filter deleted records",
      });
    }

    // Unique constraint checks
    const uniqueMatch = trimmed.match(
      /(?:findFirst|findOne|findUnique|exists|count)\s*\(/
    );
    if (uniqueMatch) {
      // Check if followed by a throw (uniqueness enforcement)
      const nextLines = lines.slice(i, Math.min(i + 5, lines.length)).join(" ");
      if (nextLines.match(/(?:throw|raise|Conflict|Already\s+exists|Duplicate)/i)) {
        gotchas.push({
          file: filePath,
          line: i + 1,
          category: "unique_constraint",
          text: "Enforces uniqueness — throws on duplicate",
        });
      }
    }
  }

  // Deduplicate soft_delete entries (only keep first per file)
  const seen = new Set<string>();
  return gotchas.filter((g) => {
    if (g.category === "soft_delete") {
      const key = `${g.file}:${g.category}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  });
}

function isTrivialComment(text: string): boolean {
  const trivial = [
    /^add\s+(tests?|logging|docs|types?|comments?)/i,
    /^refactor/i,
    /^clean\s*up/i,
    /^remove\s+this/i,
    /^fix\s+this\s+later/i,
    /^implement/i,
    /^move\s+to/i,
  ];
  return trivial.some((r) => r.test(text));
}
