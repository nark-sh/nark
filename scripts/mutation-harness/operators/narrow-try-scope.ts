/**
 * M2 — narrow-try-scope (FP-induction)
 *
 * Finds the first AwaitExpression inside a TryStatement and moves the enclosing
 * statement OUT of the try body — placing it immediately before the try block.
 * The scanner should now see an unprotected await, since the try no longer
 * covers it.
 *
 * Applies to `proper-error-handling.ts` seeds.
 */

import * as ts from 'typescript';
import type { MutationOperator } from './types.js';
import { parse, findAll, spliceText, leadingIndent } from './ast-helpers.js';

export const narrowTryScopeOperator: MutationOperator = {
  name: 'narrow-try-scope',
  kind: 'fp-induction',
  seedType: 'proper',
  expected: 'violation-added',

  apply(sourceCode: string): string | null {
    const sf = parse(sourceCode);
    const tries = findAll(sf, (n): n is ts.TryStatement => ts.isTryStatement(n));
    if (tries.length === 0) return null;

    for (const t of tries) {
      // Find first statement in try body that contains an await
      for (const stmt of t.tryBlock.statements) {
        let hasAwait = false;
        const walk = (n: ts.Node): void => {
          if (ts.isAwaitExpression(n)) hasAwait = true;
          if (!hasAwait) ts.forEachChild(n, walk);
        };
        walk(stmt);
        if (!hasAwait) continue;

        // Extract statement text
        const stmtText = sourceCode.slice(stmt.getStart(sf), stmt.getEnd());
        const indent = leadingIndent(sourceCode, t.getStart(sf));

        // Remove the statement from the try block (splice it out).
        let mutated = sourceCode;

        // 1. Insert the statement BEFORE the try, at the try's indent level.
        const insertion = `${stmtText}\n${indent}`;
        mutated = spliceText(mutated, t.getStart(sf), t.getStart(sf), insertion);

        // 2. Remove the original statement (shifted by insertion length).
        const shift = insertion.length;
        const origStart = stmt.getStart(sf) + shift;
        const origEnd = stmt.getEnd() + shift;
        // Also remove leading whitespace + newline for the now-empty line.
        let removeStart = origStart;
        while (removeStart > 0 && (mutated[removeStart - 1] === ' ' || mutated[removeStart - 1] === '\t')) {
          removeStart--;
        }
        let removeEnd = origEnd;
        if (mutated[removeEnd] === '\n') removeEnd++;

        return spliceText(mutated, removeStart, removeEnd, '');
      }
    }

    return null;
  },
};
