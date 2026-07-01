/**
 * Small AST-helper wrappers around the TypeScript Compiler API.
 *
 * The scanner uses `import * as ts from "typescript"` (see
 * nark-dev/nark/src/analyzer.ts:5). We use the same to avoid pulling in
 * ts-morph as a new runtime dep — mutation operators only need to locate
 * a handful of node types (TryStatement, AwaitExpression, CallExpression)
 * and splice the source text around them.
 */

import * as ts from 'typescript';

export function parse(sourceCode: string, filePath = 'mutant.ts'): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    sourceCode,
    ts.ScriptTarget.ES2020,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
}

/**
 * Walk every node in the source file (pre-order).
 */
export function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/**
 * Return every node of a given kind, pre-order.
 */
export function findAll<T extends ts.Node>(
  root: ts.Node,
  predicate: (n: ts.Node) => n is T,
): T[] {
  const out: T[] = [];
  walk(root, (n) => {
    if (predicate(n)) out.push(n);
  });
  return out;
}

/**
 * Return the enclosing FunctionLike (arrow / method / function decl) of a node,
 * or null if none.
 */
export function enclosingFunctionLike(node: ts.Node): ts.SignatureDeclaration | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isConstructorDeclaration(cur)
    ) {
      return cur as ts.SignatureDeclaration;
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * Splice a text-range replacement into the source. `start`/`end` are absolute
 * character offsets from the parse tree; `replacement` is inserted between them.
 * All operators use this to build their mutated output.
 */
export function spliceText(
  source: string,
  start: number,
  end: number,
  replacement: string,
): string {
  return source.slice(0, start) + replacement + source.slice(end);
}

/**
 * Return the leading whitespace before a node (indent as it appears on its own line).
 * Used to preserve indentation when hoisting statements out of a try/catch.
 */
export function leadingIndent(source: string, nodeStart: number): string {
  let i = nodeStart - 1;
  while (i >= 0 && (source[i] === ' ' || source[i] === '\t')) i--;
  return source.slice(i + 1, nodeStart);
}
