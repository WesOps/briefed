import { readFileSync } from "fs";
import { extname } from "path";
import { extractWithAst } from "./ast.js";

/**
 * Extracted symbol from a source file.
 * Represents exports, functions, classes, types — the structural skeleton.
 */
export interface Symbol {
  name: string;
  kind: SymbolKind;
  signature: string;     // full signature line (e.g. "createInvoice(projectId: string): Promise<Invoice>")
  description: string | null; // one-liner from JSDoc/docstring (e.g. "Creates an invoice and emits InvoiceCreated event")
  exported: boolean;
  line: number;
  confidence?: "ast" | "regex";  // how the symbol was extracted (default: "regex")
  calls?: string[];      // imported symbols this function calls (AST-only, function-level call graph)
}

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "method"
  | "component"  // React component
  | "route"      // API route handler
  | "unknown";

/**
 * Import reference found in a file.
 */
export interface ImportRef {
  source: string;   // the module path (e.g. "./InvoiceService" or "react")
  names: string[];  // imported names (e.g. ["InvoiceService", "InvoiceStatus"])
  isRelative: boolean;
  /** True for `import type { ... }` — erased at runtime, doesn't create real coupling. */
  isTypeOnly?: boolean;
}

export interface FileExtraction {
  path: string;
  symbols: Symbol[];
  imports: ImportRef[];
  lineCount: number;
}

type LanguageExtractor = (content: string, lines: string[], result: FileExtraction) => void;

/** Map file extensions to their language-specific extractor */
const LANGUAGE_EXTRACTORS: Record<string, LanguageExtractor> = {
  ".ts": extractTypeScript,
  ".tsx": extractTypeScript,
  ".js": extractTypeScript,
  ".jsx": extractTypeScript,
  ".mjs": extractTypeScript,
  ".cjs": extractTypeScript,
  ".py": extractPython,
  ".go": extractGo,
  ".rs": extractRust,
  ".java": extractJava,
  ".kt": extractJava,
};

/**
 * Extract symbols and imports from a source file.
 * Uses regex-based extraction (fast, no WASM dependency).
 * Covers TypeScript, JavaScript, Python, Go, Rust, Java.
 */
/** Extensions that support AST extraction via the TS compiler API */
const AST_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export function extractFile(filePath: string, _rootPath: string): FileExtraction {
  const ext = extname(filePath);

  // Try AST extraction first for TS/JS files (higher accuracy)
  if (AST_EXTENSIONS.has(ext)) {
    const astResult = extractWithAst(filePath);
    // Trust AST if it succeeded at all (returned non-null). Even if symbols
    // is empty (e.g. a test file with only describe/it calls, no top-level
    // exports), the imports array is still authoritative. Falling back to
    // regex here causes regex to scan string literals inside the file and
    // pick up bogus imports like `"import dep from 'dep'"` from test fixtures.
    if (astResult) {
      // AST succeeded — still add JSDoc descriptions via line scanning
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      for (const sym of astResult.symbols) {
        if (!sym.description) {
          sym.description = extractDescription(lines, sym.line - 1);
        }
      }
      return astResult;
    }
    // AST genuinely failed (parse error) — fall through to regex
  }

  // Regex fallback (always works, lower accuracy)
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  const result: FileExtraction = {
    path: filePath,
    symbols: [],
    imports: [],
    lineCount: lines.length,
  };

  const extractor = LANGUAGE_EXTRACTORS[ext] || extractGeneric;
  extractor(content, lines, result);

  // Post-process: set defaults and add descriptions
  for (const sym of result.symbols) {
    if (!sym.confidence) sym.confidence = "regex";
    if (!sym.description) {
      sym.description = extractDescription(lines, sym.line - 1);
    }
  }

  return result;
}

// -- Docstring / JSDoc extraction --

/**
 * Extract a one-line description from JSDoc or Python docstring above a line.
 * Returns the first meaningful sentence, stripped of formatting.
 */
function extractDescription(lines: string[], symbolLine: number): string | null {
  // Look up to 10 lines above for a doc comment
  const startSearch = Math.max(0, symbolLine - 10);
  const searchBlock = lines.slice(startSearch, symbolLine);

  // JSDoc: /** ... */
  const blockText = searchBlock.join("\n");
  const jsdocMatch = blockText.match(/\/\*\*\s*([\s\S]*?)\*\//);
  if (jsdocMatch) {
    const raw = jsdocMatch[1]
      .replace(/^\s*\*\s?/gm, "") // strip leading * from each line
      .replace(/@\w+.*/g, "")     // strip @param, @returns, etc
      .trim();
    const firstLine = raw.split("\n")[0]?.trim();
    if (firstLine && firstLine.length > 5 && firstLine.length < 200) {
      return firstLine;
    }
  }

  // Single-line comment: // description
  const prevLine = lines[symbolLine - 1]?.trim();
  if (prevLine && prevLine.startsWith("//")) {
    const text = prevLine.replace(/^\/\/\s*/, "").trim();
    if (text.length > 5 && text.length < 200 && !text.startsWith("eslint") && !text.startsWith("@ts-")) {
      return text;
    }
  }

  // Python docstring: """...""" or '''...''' (look below the def/class line)
  if (symbolLine < lines.length - 1) {
    const nextLine = lines[symbolLine]?.trim();
    const docMatch = nextLine?.match(/^(?:"""|''')(.+?)(?:"""|''')?$/);
    if (docMatch) {
      return docMatch[1].trim();
    }
    // Multi-line docstring — grab first line
    if (nextLine === '"""' || nextLine === "'''") {
      const docLine = lines[symbolLine + 1]?.trim();
      if (docLine && docLine.length > 5 && !docLine.startsWith('"""')) {
        return docLine;
      }
    }
  }

  return null;
}

// -- TypeScript / JavaScript --

function extractTypeScript(content: string, lines: string[], result: FileExtraction) {
  // Imports
  const importRegex = /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
  const importTypeRegex = /import\s+type\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  const requireRegex = /(?:const|let|var)\s+(?:\{([^}]+)\}|(\w+))\s*=\s*require\(['"]([^'"]+)['"]\)/g;

  for (const match of content.matchAll(importRegex)) {
    const names = match[1]
      ? match[1].split(",").map((n) => n.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean)
      : [match[2]];
    const source = match[3];
    result.imports.push({
      source,
      names,
      isRelative: source.startsWith("."),
    });
  }

  for (const match of content.matchAll(importTypeRegex)) {
    const names = match[1].split(",").map((n) => n.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean);
    result.imports.push({ source: match[2], names, isRelative: match[2].startsWith("."), isTypeOnly: true });
  }

  for (const match of content.matchAll(requireRegex)) {
    const names = match[1]
      ? match[1].split(",").map((n) => n.trim()).filter(Boolean)
      : [match[2]];
    result.imports.push({ source: match[3], names, isRelative: match[3].startsWith(".") });
  }

  // Exported functions
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // export function name(params): ReturnType
    const exportFnMatch = trimmed.match(
      /^export\s+(?:async\s+)?function\s+(\w+)\s*(\([^)]*\))(?:\s*:\s*(.+?))?\s*\{?$/
    );
    if (exportFnMatch) {
      const retType = exportFnMatch[3] || inferReturnType(exportFnMatch[1]);
      const isRoute = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(exportFnMatch[1]);
      result.symbols.push({
        name: exportFnMatch[1],
        kind: isRoute ? "route" : isReactComponent(exportFnMatch[1]) ? "component" : "function",
        signature: `${exportFnMatch[1]}${exportFnMatch[2]}${retType ? `: ${retType.replace(/\s*\{?\s*$/, "")}` : ""}`,
        description: null,
        exported: true,
        line: i + 1,
      });
      continue;
    }

    // export const name = (params) => ... or export const name: Type = ...
    const exportConstMatch = trimmed.match(
      /^export\s+const\s+(\w+)(?:\s*:\s*([^=]+?))?\s*=\s*(?:async\s+)?(?:\(([^)]*)\)\s*(?::\s*(.+?))?\s*=>|function)/
    );
    if (exportConstMatch) {
      const name = exportConstMatch[1];
      const typeAnnotation = exportConstMatch[2]?.trim();
      const params = exportConstMatch[3] || "";
      const retType = exportConstMatch[4]?.replace(/\s*\{?\s*$/, "");
      const sig = typeAnnotation
        ? `${name}: ${typeAnnotation.replace(/\s*$/, "")}`
        : `${name}(${params})${retType ? `: ${retType}` : ""}`;
      result.symbols.push({
        name,
        kind: isReactComponent(name) ? "component" : "function",
        signature: sig,
        description: null,
        exported: true,
        line: i + 1,
      });
      continue;
    }

    // export const name = value (non-function)
    const exportVarMatch = trimmed.match(
      /^export\s+const\s+(\w+)(?:\s*:\s*([^=]+?))?\s*=/
    );
    if (exportVarMatch && !exportConstMatch) {
      result.symbols.push({
        name: exportVarMatch[1],
        kind: "variable",
        signature: exportVarMatch[2]
          ? `${exportVarMatch[1]}: ${exportVarMatch[2].trim()}`
          : exportVarMatch[1],
        description: null,
        exported: true,
        line: i + 1,
      });
      continue;
    }

    // export class Name
    const classMatch = trimmed.match(/^export\s+(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+(.+?))?\s*\{?$/);
    if (classMatch) {
      let sig = classMatch[1];
      if (classMatch[2]) sig += ` extends ${classMatch[2]}`;
      if (classMatch[3]) sig += ` implements ${classMatch[3].replace(/\s*\{?\s*$/, "")}`;
      result.symbols.push({
        name: classMatch[1],
        kind: "class",
        signature: sig,
        description: null,
        exported: true,
        line: i + 1,
      });

      // Extract methods from the class
      extractClassMethods(lines, i + 1, classMatch[1], result);
      continue;
    }

    // export interface Name
    const ifaceMatch = trimmed.match(/^export\s+interface\s+(\w+)(?:<[^>]+>)?\s*(?:extends\s+(.+?))?\s*\{?$/);
    if (ifaceMatch) {
      result.symbols.push({
        name: ifaceMatch[1],
        kind: "interface",
        signature: ifaceMatch[1] + (ifaceMatch[2] ? ` extends ${ifaceMatch[2].replace(/\s*\{?\s*$/, "")}` : ""),
        description: null,
        exported: true,
        line: i + 1,
      });
      continue;
    }

    // export type Name = ...
    const typeMatch = trimmed.match(/^export\s+type\s+(\w+)(?:<[^>]+>)?\s*=\s*(.+?)$/);
    if (typeMatch) {
      result.symbols.push({
        name: typeMatch[1],
        kind: "type",
        signature: `${typeMatch[1]} = ${typeMatch[2].slice(0, 60)}${typeMatch[2].length > 60 ? "..." : ""}`,
        description: null,
        exported: true,
        line: i + 1,
      });
      continue;
    }

    // export enum Name
    const enumMatch = trimmed.match(/^export\s+(?:const\s+)?enum\s+(\w+)/);
    if (enumMatch) {
      // Extract enum values
      const values = extractEnumValues(lines, i);
      result.symbols.push({
        name: enumMatch[1],
        kind: "enum",
        signature: values.length > 0 ? `${enumMatch[1]} = ${values.join(" | ")}` : enumMatch[1],
        description: null,
        exported: true,
        line: i + 1,
      });
      continue;
    }

    // export default
    const defaultMatch = trimmed.match(/^export\s+default\s+(?:async\s+)?function\s+(\w+)/);
    if (defaultMatch) {
      result.symbols.push({
        name: defaultMatch[1],
        kind: "function",
        signature: defaultMatch[1] + " (default export)",
        description: null,
        exported: true,
        line: i + 1,
      });
      continue;
    }

    // Next.js / Express route handlers
    const routeMatch = trimmed.match(/^export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/);
    if (routeMatch) {
      result.symbols.push({
        name: routeMatch[1],
        kind: "route",
        signature: `${routeMatch[1]}(request)`,
        description: null,
        exported: true,
        line: i + 1,
      });
    }

    // Non-exported function declarations (still useful for skeleton)
    if (!trimmed.startsWith("export")) {
      const plainFnMatch = trimmed.match(
        /^(?:async\s+)?function\s+(\w+)\s*(\([^)]*\))(?:\s*:\s*(.+?))?\s*\{?$/
      );
      if (plainFnMatch && !plainFnMatch[1].startsWith("_")) {
        const retType = plainFnMatch[3]?.replace(/\s*\{?\s*$/, "");
        result.symbols.push({
          name: plainFnMatch[1],
          kind: "function",
          signature: `${plainFnMatch[1]}${plainFnMatch[2]}${retType ? `: ${retType}` : ""}`,
          description: null,
          exported: false,
          line: i + 1,
        });
      }
    }

    // CommonJS: module.exports = { ... } or module.exports = function
    const cjsMatch = trimmed.match(/^module\.exports\s*=\s*(?:class\s+(\w+)|function\s+(\w+)|(\w+)|{)/);
    if (cjsMatch) {
      const name = cjsMatch[1] || cjsMatch[2] || cjsMatch[3];
      if (name) {
        result.symbols.push({
          name,
          kind: cjsMatch[1] ? "class" : cjsMatch[2] ? "function" : "variable",
          signature: `${name} (module.exports)`,
          description: null,
          exported: true,
          line: i + 1,
        });
      } else {
        // module.exports = { ... } — extract keys
        const objContent = lines.slice(i, Math.min(i + 20, lines.length)).join(" ");
        const keyMatches = objContent.matchAll(/(\w+)\s*[,:]/g);
        for (const km of keyMatches) {
          if (km[1] !== "module" && km[1] !== "exports") {
            result.symbols.push({
              name: km[1],
              kind: "variable",
              signature: km[1],
              description: null,
              exported: true,
              line: i + 1,
            });
          }
        }
      }
    }
  }
}

function extractClassMethods(
  lines: string[],
  startLine: number,
  className: string,
  result: FileExtraction
) {
  // If the class opening { was on the declaration line, we start inside the body
  const classLine = lines[startLine - 1] || "";
  let braceDepth = classLine.includes("{") ? 1 : 0;
  let started = braceDepth > 0;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === "{") { braceDepth++; started = true; }
      if (ch === "}") braceDepth--;
    }
    if (started && braceDepth <= 0) break;

    // Only look at depth 1 (direct class members)
    if (braceDepth !== 1) continue;

    const trimmed = line.trim();

    // method(params): ReturnType
    const methodMatch = trimmed.match(
      /^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*(\([^)]*\))(?:\s*:\s*(.+?))?\s*\{?$/
    );
    if (methodMatch && methodMatch[1] !== "constructor" && !methodMatch[1].startsWith("_")) {
      const retType = methodMatch[3]?.replace(/\s*\{?\s*$/, "");
      result.symbols.push({
        name: `${className}.${methodMatch[1]}`,
        kind: "method",
        signature: `${methodMatch[1]}${methodMatch[2]}${retType ? `: ${retType}` : ""}`,
        description: null,
        exported: false,  // methods are accessible via the exported class
        line: i + 1,
      });
    }
  }
}

function extractEnumValues(lines: string[], startLine: number): string[] {
  const values: string[] = [];
  for (let i = startLine + 1; i < Math.min(startLine + 30, lines.length); i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "}") break;
    const valMatch = trimmed.match(/^(\w+)\s*[=,]/);
    if (valMatch) values.push(valMatch[1]);
    if (values.length >= 8) {
      values.push("...");
      break;
    }
  }
  return values;
}

function isReactComponent(name: string): boolean {
  return /^[A-Z]/.test(name) && !/^[A-Z_]+$/.test(name);
}

function inferReturnType(_name: string): string {
  // TODO: implement return type inference from function name heuristics
  return "";
}

// -- Python --

function extractPython(content: string, lines: string[], result: FileExtraction) {
  // Imports
  const importRegex = /^(?:from\s+(\S+)\s+import\s+(.+)|import\s+(\S+)(?:\s+as\s+\S+)?)\s*$/gm;
  for (const match of content.matchAll(importRegex)) {
    if (match[1]) {
      const names = match[2].split(",").map((n) => n.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean);
      result.imports.push({
        source: match[1],
        names,
        isRelative: match[1].startsWith("."),
      });
    } else if (match[3]) {
      result.imports.push({
        source: match[3],
        names: [match[3].split(".").pop()!],
        isRelative: match[3].startsWith("."),
      });
    }
  }

  // Functions and classes (top-level only — indentation = 0)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // def function_name(params) -> ReturnType:
    const fnMatch = line.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(.+?))?\s*:/);
    if (fnMatch && !fnMatch[1].startsWith("_")) {
      const retType = fnMatch[3]?.trim();
      result.symbols.push({
        name: fnMatch[1],
        kind: "function",
        signature: `${fnMatch[1]}(${fnMatch[2].trim()})${retType ? ` -> ${retType}` : ""}`,
        description: null,
        exported: !fnMatch[1].startsWith("_"),
        line: i + 1,
      });
      continue;
    }

    // class ClassName(BaseClass):
    const classMatch = line.match(/^class\s+(\w+)(?:\(([^)]*)\))?\s*:/);
    if (classMatch) {
      const bases = classMatch[2] || "";
      result.symbols.push({
        name: classMatch[1],
        kind: "class",
        signature: classMatch[1] + (bases ? `(${bases})` : ""),
        description: null,
        exported: !classMatch[1].startsWith("_"),
        line: i + 1,
      });

      // Extract methods
      for (let j = i + 1; j < lines.length; j++) {
        const methodLine = lines[j];
        if (methodLine.match(/^\S/) && j > i + 1) break; // next top-level definition
        const methodMatch = methodLine.match(/^\s+(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(.+?))?\s*:/);
        if (methodMatch && !methodMatch[1].startsWith("_")) {
          const params = methodMatch[2].replace(/\bself\s*,?\s*/, "").trim();
          const retType = methodMatch[3]?.trim();
          result.symbols.push({
            name: `${classMatch[1]}.${methodMatch[1]}`,
            kind: "method",
            signature: `${methodMatch[1]}(${params})${retType ? ` -> ${retType}` : ""}`,
            description: null,
            exported: true,
            line: j + 1,
          });
        }
      }
    }
  }
}

// -- Go --

function extractGo(content: string, lines: string[], result: FileExtraction) {
  // Imports
  const importBlockRegex = /import\s*\(([\s\S]*?)\)/g;
  for (const match of content.matchAll(importBlockRegex)) {
    const block = match[1];
    for (const line of block.split("\n")) {
      const importMatch = line.trim().match(/^(?:\w+\s+)?"([^"]+)"/);
      if (importMatch) {
        result.imports.push({
          source: importMatch[1],
          names: [importMatch[1].split("/").pop()!],
          isRelative: importMatch[1].startsWith("."),
        });
      }
    }
  }

  const singleImport = /^import\s+"([^"]+)"/gm;
  for (const match of content.matchAll(singleImport)) {
    result.imports.push({
      source: match[1],
      names: [match[1].split("/").pop()!],
      isRelative: match[1].startsWith("."),
    });
  }

  // Functions and types
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // func Name(params) ReturnType
    const fnMatch = line.match(/^func\s+(\w+)\s*(\([^)]*\))(?:\s*(\([^)]*\)|[\w.*[\]]+))?\s*\{?/);
    if (fnMatch) {
      const isExported = fnMatch[1][0] === fnMatch[1][0].toUpperCase();
      result.symbols.push({
        name: fnMatch[1],
        kind: "function",
        signature: `${fnMatch[1]}${fnMatch[2]}${fnMatch[3] ? ` ${fnMatch[3]}` : ""}`,
        description: null,
        exported: isExported,
        line: i + 1,
      });
      continue;
    }

    // func (receiver) Method(params) ReturnType
    const methodMatch = line.match(/^func\s+\((\w+)\s+\*?(\w+)\)\s+(\w+)\s*(\([^)]*\))(?:\s*(\([^)]*\)|[\w.*[\]]+))?\s*\{?/);
    if (methodMatch) {
      result.symbols.push({
        name: `${methodMatch[2]}.${methodMatch[3]}`,
        kind: "method",
        signature: `${methodMatch[3]}${methodMatch[4]}${methodMatch[5] ? ` ${methodMatch[5]}` : ""}`,
        description: null,
        exported: methodMatch[3][0] === methodMatch[3][0].toUpperCase(),
        line: i + 1,
      });
      continue;
    }

    // type Name struct/interface
    const typeMatch = line.match(/^type\s+(\w+)\s+(struct|interface)\s*\{?/);
    if (typeMatch) {
      result.symbols.push({
        name: typeMatch[1],
        kind: typeMatch[2] === "interface" ? "interface" : "class",
        signature: `${typeMatch[1]} ${typeMatch[2]}`,
        description: null,
        exported: typeMatch[1][0] === typeMatch[1][0].toUpperCase(),
        line: i + 1,
      });
    }
  }
}

// -- Rust --

function extractRust(content: string, lines: string[], result: FileExtraction) {
  // use statements
  const useRegex = /^use\s+(.+?);/gm;
  for (const match of content.matchAll(useRegex)) {
    result.imports.push({
      source: match[1].split("::").slice(0, -1).join("::"),
      names: [match[1].split("::").pop()!.replace(/[{}\s]/g, "")],
      isRelative: match[1].startsWith("crate::") || match[1].startsWith("super::"),
    });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // pub fn name(params) -> ReturnType
    const fnMatch = trimmed.match(/^pub(?:\(crate\))?\s+(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*(\([^)]*\))(?:\s*->\s*(.+?))?\s*(?:where|\{|$)/);
    if (fnMatch) {
      result.symbols.push({
        name: fnMatch[1],
        kind: "function",
        signature: `${fnMatch[1]}${fnMatch[2]}${fnMatch[3] ? ` -> ${fnMatch[3].replace(/\s*\{?\s*$/, "")}` : ""}`,
        description: null,
        exported: true,
        line: i + 1,
      });
      continue;
    }

    // pub struct/enum/trait Name
    const structMatch = trimmed.match(/^pub(?:\(crate\))?\s+(struct|enum|trait)\s+(\w+)/);
    if (structMatch) {
      const kind: SymbolKind = structMatch[1] === "enum" ? "enum" : structMatch[1] === "trait" ? "interface" : "class";
      result.symbols.push({
        name: structMatch[2],
        kind,
        signature: `${structMatch[1]} ${structMatch[2]}`,
        description: null,
        exported: true,
        line: i + 1,
      });
    }
  }
}

// -- Java / Kotlin --

function extractJava(content: string, lines: string[], result: FileExtraction) {
  const importRegex = /^import\s+(?:static\s+)?([^;]+);/gm;
  for (const match of content.matchAll(importRegex)) {
    result.imports.push({
      source: match[1],
      names: [match[1].split(".").pop()!],
      isRelative: false,
    });
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    const classMatch = trimmed.match(/^(?:public\s+)?(?:abstract\s+)?(?:class|interface|enum|record)\s+(\w+)/);
    if (classMatch) {
      result.symbols.push({
        name: classMatch[1],
        kind: "class",
        signature: trimmed.replace(/\s*\{?\s*$/, ""),
        description: null,
        exported: true,
        line: i + 1,
      });
    }

    const methodMatch = trimmed.match(/^(?:public|protected)\s+(?:static\s+)?(?:abstract\s+)?(?:[\w<>\[\],\s]+?)\s+(\w+)\s*\(/);
    if (methodMatch && !trimmed.includes("class ")) {
      result.symbols.push({
        name: methodMatch[1],
        kind: "method",
        signature: trimmed.replace(/\s*\{?\s*$/, "").replace(/\s*;?\s*$/, ""),
        description: null,
        exported: true,
        line: i + 1,
      });
    }
  }
}

// -- Generic fallback --

function extractGeneric(_content: string, lines: string[], result: FileExtraction) {
  // Very basic: look for function/class definitions
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const fnMatch = trimmed.match(/^(?:export\s+)?(?:pub(?:\(crate\))?\s+)?(?:async\s+)?(?:def|fn|func|function)\s+(\w+)/);
    if (fnMatch) {
      result.symbols.push({
        name: fnMatch[1],
        kind: "function",
        signature: fnMatch[1],
        description: null,
        exported: true,
        line: i + 1,
      });
    }
  }
}
