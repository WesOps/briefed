import { readFileSync } from "fs";
import { extname } from "path";

export interface ErrorPattern {
  file: string;
  pattern: ErrorPatternType;
  detail: string;
}

export type ErrorPatternType =
  | "try_catch_style"     // how errors are caught
  | "error_class"         // custom error classes
  | "result_type"         // Result/Either pattern
  | "guard_return"        // early return on error
  | "error_propagation"   // throw/raise pattern
  | "validation_style";   // how inputs are validated

/**
 * Detect the project's error handling patterns.
 * Research shows AI generates 2x more error handling bugs — knowing the project's
 * patterns prevents silent failures and inconsistent error handling.
 */
export function detectErrorPatterns(
  filePaths: string[]
): { patterns: ErrorPattern[]; summary: string[] } {
  const patterns: ErrorPattern[] = [];
  const stats = {
    tryCatch: 0,
    customErrors: 0,
    resultTypes: 0,
    guardReturns: 0,
    throws: 0,
    zodValidation: 0,
    manualValidation: 0,
    filesScanned: 0,
  };

  for (const filePath of filePaths) {
    const ext = extname(filePath);
    if (![".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"].includes(ext)) continue;

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    stats.filesScanned++;

    // Custom error classes
    const customErrorMatch = content.match(/class\s+(\w+Error)\s+extends\s+(\w+Error|Error)/g);
    if (customErrorMatch) {
      stats.customErrors += customErrorMatch.length;
      for (const m of customErrorMatch) {
        const nameMatch = m.match(/class\s+(\w+)/);
        if (nameMatch) {
          patterns.push({
            file: filePath,
            pattern: "error_class",
            detail: nameMatch[1],
          });
        }
      }
    }

    // Result/Either types
    if (content.includes("Result<") || content.includes("Either<") ||
        content.includes("Result[") || content.includes("-> Result")) {
      stats.resultTypes++;
      patterns.push({
        file: filePath,
        pattern: "result_type",
        detail: "Uses Result/Either type for error propagation",
      });
    }

    // try/catch patterns
    const tryCatchCount = (content.match(/\btry\s*\{/g) || []).length;
    stats.tryCatch += tryCatchCount;

    // Guard clause returns (early return on validation failure)
    const guardMatches = content.match(/if\s*\([^)]*\)\s*(?:return|throw|raise)\b/g);
    if (guardMatches) {
      stats.guardReturns += guardMatches.length;
    }

    // throw new / raise patterns
    const throwCount = (content.match(/throw\s+new\s+\w+/g) || []).length;
    const raiseCount = (content.match(/raise\s+\w+/g) || []).length;
    stats.throws += throwCount + raiseCount;

    // Zod/Joi/Yup validation
    if (content.includes(".parse(") || content.includes(".safeParse(") ||
        content.includes("z.object(") || content.includes("Joi.object(") ||
        content.includes("yup.object(")) {
      stats.zodValidation++;
    }

    // Manual validation (typeof checks, instanceof)
    const manualChecks = (content.match(/typeof\s+\w+\s*[!=]==?\s*['"]|instanceof\s+\w+/g) || []).length;
    if (manualChecks > 3) {
      stats.manualValidation++;
    }
  }

  // Generate summary of detected patterns
  const summary: string[] = [];

  if (stats.customErrors > 0) {
    const names = [...new Set(patterns.filter((p) => p.pattern === "error_class").map((p) => p.detail))];
    summary.push(`Custom error classes: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` +${names.length - 5} more` : ""}`);
  }

  if (stats.resultTypes > 0) {
    summary.push("Uses Result/Either types for error propagation (not exceptions)");
  }

  if (stats.tryCatch > stats.throws * 2 && stats.tryCatch > 5) {
    summary.push("Prefers try/catch wrapping over throwing");
  } else if (stats.throws > stats.tryCatch && stats.throws > 3) {
    summary.push("Throws errors to callers (expects upstream catch)");
  }

  if (stats.guardReturns > 5) {
    summary.push("Uses guard clauses (early returns on validation failure)");
  }

  if (stats.zodValidation > 0) {
    summary.push("Uses schema validation (Zod/Joi/Yup) for input validation");
  } else if (stats.manualValidation > 3) {
    summary.push("Uses manual type checking for validation (typeof/instanceof)");
  }

  return { patterns, summary };
}
