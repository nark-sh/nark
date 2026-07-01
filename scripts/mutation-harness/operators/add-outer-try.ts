/**
 * M5 — add-outer-try (TP-suppression)
 *
 * Wraps the function body of the first async function/method in an outer
 * try/catch. Should REMOVE violations that fired against unprotected awaits.
 *
 * Applies to `missing-error-handling.ts` seeds.
 */

import * as ts from 'typescript';
import type { MutationOperator } from './types.js';
import { parse, findAll, spliceText } from './ast-helpers.js';

export const addOuterTryOperator: MutationOperator = {
  name: 'add-outer-try',
  kind: 'tp-suppression',
  seedType: 'missing',
  expected: 'violation-removed',

  apply(sourceCode: string): string | null {
    const sf = parse(sourceCode);

    // Find first async function/method whose body contains an await NOT already wrapped
    // in a try/catch. Cheap heuristic: pick first async function/arrow that contains
    // an unprotected await.
    const candidates = findAll(
      sf,
      (n): n is ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression =>
        (ts.isFunctionDeclaration(n) ||
          ts.isMethodDeclaration(n) ||
          ts.isArrowFunction(n) ||
          ts.isFunctionExpression(n)) &&
        !!n.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
    );

    for (const fn of candidates) {
      const body = fn.body;
      if (!body || !ts.isBlock(body)) continue;

      // Skip if body already starts with a top-level try wrapping everything
      if (body.statements.length === 1 && ts.isTryStatement(body.statements[0])) continue;

      // Verify the body contains at least one await (else the mutation is meaningless).
      let hasAwait = false;
      const walk = (n: ts.Node): void => {
        if (ts.isAwaitExpression(n)) hasAwait = true;
        if (!hasAwait) ts.forEachChild(n, walk);
      };
      walk(body);
      if (!hasAwait) continue;

      // Splice `{` -> `{\n  try {`, `}` -> `  } catch (e) { throw e; }\n}`
      const bodyOpenBrace = body.getStart(sf); // position of `{`
      const bodyCloseBrace = body.getEnd() - 1; // position of `}`

      let mutated = sourceCode;
      // Insert catch block just before closing `}`.
      mutated = spliceText(
        mutated,
        bodyCloseBrace,
        bodyCloseBrace,
        `  } catch (e) {\n    console.error(e);\n    throw e;\n  }\n`,
      );
      // Insert `try {` after opening `{`.
      mutated = spliceText(
        mutated,
        bodyOpenBrace + 1,
        bodyOpenBrace + 1,
        `\n  try {`,
      );
      return mutated;
    }

    return null;
  },
};
