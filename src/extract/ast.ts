import ts from "typescript";
import { readFileSync } from "fs";
import type { FileExtraction, Symbol, SymbolKind, ImportRef } from "./signatures.js";

/**
 * AST-based extraction for TypeScript/JavaScript files using the TS compiler API.
 * Returns null if parsing fails (caller should fall back to regex).
 */
export function extractWithAst(filePath: string): FileExtraction | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const symbols: Symbol[] = [];
  const imports: ImportRef[] = [];

  function getLineNumber(node: ts.Node): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  }

  function isExported(node: ts.Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    const mods = ts.getModifiers(node);
    return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  }

  function getJsDoc(node: ts.Node): string | null {
    // Only accept JSDoc that's directly attached to this node (not a nearby node)
    const nodeStart = node.getFullStart();
    const jsDocs = ts.getJSDocCommentsAndTags(node);
    for (const doc of jsDocs) {
      if (ts.isJSDoc(doc) && doc.comment) {
        // Verify the JSDoc is within this node's trivia (not from a sibling)
        const docEnd = doc.getEnd();
        if (docEnd > nodeStart + node.getFullWidth()) continue;
        const text = typeof doc.comment === "string" ? doc.comment : doc.comment.map((c) => c.text || "").join("");
        const first = text.split("\n")[0].trim();
        if (first.length > 5 && first.length < 200) return first;
      }
    }
    return null;
  }

  function formatParams(params: ts.NodeArray<ts.ParameterDeclaration>): string {
    return params.map((p) => {
      let name = p.name.getText(sourceFile);
      if (p.questionToken) name += "?";
      const type = p.type ? `: ${p.type.getText(sourceFile)}` : "";
      return `${name}${type}`;
    }).join(", ");
  }

  function formatReturnType(node: ts.SignatureDeclaration): string {
    if (node.type) return node.type.getText(sourceFile);
    return "";
  }

  function detectKind(name: string, node: ts.Node): SymbolKind {
    if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name)) return "route";
    if (/^[A-Z]/.test(name) && !/^[A-Z_]+$/.test(name)) {
      // Check if it returns JSX
      if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        const text = node.getText(sourceFile);
        if (text.includes("JSX.Element") || text.includes("React.") || /<\w/.test(text.slice(-500))) {
          return "component";
        }
      }
      return "component"; // PascalCase exported function likely a component
    }
    return "function";
  }

  // Collect all imported names for call graph detection
  const importedNames = new Set<string>();

  /** Scan a function body for calls to imported symbols */
  function findCalls(body: ts.Node | undefined): string[] | undefined {
    if (!body || importedNames.size === 0) return undefined;
    const called = new Set<string>();
    function walkCalls(node: ts.Node) {
      // Direct call: foo() or foo.bar()
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        if (ts.isIdentifier(expr) && importedNames.has(expr.text)) {
          called.add(expr.text);
        } else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && importedNames.has(expr.expression.text)) {
          called.add(expr.expression.text);
        }
      }
      // Type references: `: SomeType`, `as SomeType`, generic params
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && importedNames.has(node.typeName.text)) {
        called.add(node.typeName.text);
      }
      // Identifier usage (e.g. passing as argument, assignment)
      if (ts.isIdentifier(node) && importedNames.has(node.text)) {
        // Only count if parent is not the import declaration itself
        const parent = node.parent;
        if (parent && !ts.isImportSpecifier(parent) && !ts.isImportClause(parent)) {
          called.add(node.text);
        }
      }
      ts.forEachChild(node, walkCalls);
    }
    walkCalls(body);
    return called.size > 0 ? [...called].sort() : undefined;
  }

  function visit(node: ts.Node) {
    // Import declarations
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const source = node.moduleSpecifier.text;
      const names: string[] = [];

      if (node.importClause) {
        if (node.importClause.name) {
          names.push(node.importClause.name.text);
        }
        if (node.importClause.namedBindings) {
          if (ts.isNamedImports(node.importClause.namedBindings)) {
            for (const el of node.importClause.namedBindings.elements) {
              names.push(el.name.text);
            }
          } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
            names.push(node.importClause.namedBindings.name.text);
          }
        }
      }

      imports.push({ source, names, isRelative: source.startsWith(".") });
      for (const n of names) importedNames.add(n);
      return;
    }

    // Function declarations
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      const exported = isExported(node);
      const params = formatParams(node.parameters);
      const ret = formatReturnType(node);
      symbols.push({
        name,
        kind: exported ? detectKind(name, node) : "function",
        signature: `${name}(${params})${ret ? `: ${ret}` : ""}`,
        description: getJsDoc(node),
        exported,
        line: getLineNumber(node),
        confidence: "ast",
        calls: findCalls(node.body),
      });
      return;
    }

    // Class declarations
    if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.text;
      const exported = isExported(node);

      let sig = name;
      if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          const keyword = clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
          const types = clause.types.map((t) => t.getText(sourceFile)).join(", ");
          sig += ` ${keyword} ${types}`;
        }
      }

      symbols.push({
        name,
        kind: "class",
        signature: sig,
        description: getJsDoc(node),
        exported,
        line: getLineNumber(node),
        confidence: "ast",
      });

      // Extract methods
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name) {
          const methodName = member.name.getText(sourceFile);
          if (methodName.startsWith("_") || methodName === "constructor") continue;
          const params = formatParams(member.parameters);
          const ret = formatReturnType(member);
          symbols.push({
            name: `${name}.${methodName}`,
            kind: "method",
            signature: `${methodName}(${params})${ret ? `: ${ret}` : ""}`,
            description: getJsDoc(member),
            exported: false,
            line: getLineNumber(member),
            confidence: "ast",
            calls: ts.isMethodDeclaration(member) ? findCalls(member.body) : undefined,
          });
        }
      }
      return;
    }

    // Interface declarations
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;
      const exported = isExported(node);
      let sig = name;
      if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          sig += ` extends ${clause.types.map((t) => t.getText(sourceFile)).join(", ")}`;
        }
      }
      symbols.push({
        name,
        kind: "interface",
        signature: sig,
        description: getJsDoc(node),
        exported,
        line: getLineNumber(node),
        confidence: "ast",
      });
      return;
    }

    // Type alias declarations
    if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      const typeText = node.type.getText(sourceFile);
      symbols.push({
        name,
        kind: "type",
        signature: `${name} = ${typeText.length > 60 ? typeText.slice(0, 60) + "..." : typeText}`,
        description: getJsDoc(node),
        exported: isExported(node),
        line: getLineNumber(node),
        confidence: "ast",
      });
      return;
    }

    // Enum declarations
    if (ts.isEnumDeclaration(node)) {
      const name = node.name.text;
      const values = node.members.slice(0, 8).map((m) => m.name.getText(sourceFile));
      if (node.members.length > 8) values.push("...");
      symbols.push({
        name,
        kind: "enum",
        signature: values.length > 0 ? `${name} = ${values.join(" | ")}` : name,
        description: getJsDoc(node),
        exported: isExported(node),
        line: getLineNumber(node),
        confidence: "ast",
      });
      return;
    }

    // Variable declarations (exported consts — arrow functions, values, etc.)
    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;

        // Arrow function or function expression
        if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
          const fn = decl.initializer;
          const params = formatParams(fn.parameters);
          const ret = formatReturnType(fn);

          // Check type annotation on the variable itself
          const typeAnnotation = decl.type ? decl.type.getText(sourceFile) : null;
          const sig = typeAnnotation
            ? `${name}: ${typeAnnotation}`
            : `${name}(${params})${ret ? `: ${ret}` : ""}`;

          symbols.push({
            name,
            kind: detectKind(name, fn),
            signature: sig,
            description: getJsDoc(node),
            exported: true,
            line: getLineNumber(node),
            confidence: "ast",
            calls: findCalls(fn.body),
          });
        } else {
          // Non-function export (constant, config object, etc.)
          const typeAnnotation = decl.type ? decl.type.getText(sourceFile) : null;
          symbols.push({
            name,
            kind: "variable",
            signature: typeAnnotation ? `${name}: ${typeAnnotation}` : name,
            description: getJsDoc(node),
            exported: true,
            line: getLineNumber(node),
            confidence: "ast",
          });
        }
      }
      return;
    }

    // Export default
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const expr = node.expression;
      if (ts.isIdentifier(expr)) {
        symbols.push({
          name: expr.text,
          kind: "function",
          signature: `${expr.text} (default export)`,
          description: null,
          exported: true,
          line: getLineNumber(node),
          confidence: "ast",
        });
      }
      return;
    }

    ts.forEachChild(node, visit);
  }

  try {
    visit(sourceFile);
  } catch {
    return null; // AST walk failed — fall back to regex
  }

  return {
    path: filePath,
    symbols,
    imports,
    lineCount: content.split("\n").length,
  };
}
