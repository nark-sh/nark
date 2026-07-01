/**
 * M3 — empty-catch-rethrow (FP-induction, per-postcondition-aware)
 *
 * Replaces the body of the first catch clause with a bare `throw error;`
 * statement, dropping any response.status inspection, isAxiosError checks,
 * logging, etc. Scanner should react on postconditions that require
 * meaningful handling (not just rethrow).
 *
 * Applies to `proper-error-handling.ts` seeds.
 */

import * as ts from 'typescript';
import type { MutationOperator } from './types.js';
import { parse, findAll, spliceText } from './ast-helpers.js';

export const emptyCatchRethrowOperator: MutationOperator = {
  name: 'empty-catch-rethrow',
  kind: 'fp-induction',
  seedType: 'proper',
  expected: 'violation-added',

  apply(sourceCode: string): string | null {
    const sf = parse(sourceCode);
    const catches = findAll(sf, (n): n is ts.CatchClause => ts.isCatchClause(n));
    if (catches.length === 0) return null;

    const c = catches[0];
    const paramName =
      c.variableDeclaration && ts.isIdentifier(c.variableDeclaration.name)
        ? c.variableDeclaration.name.text
        : 'error';

    // Get catch block, replace its inner body with a bare rethrow.
    const block = c.block;
    const innerStart = block.getStart(sf) + 1;
    const innerEnd = block.getEnd() - 1;

    const replacement = `\n    throw ${paramName};\n  `;

    return spliceText(sourceCode, innerStart, innerEnd, replacement);
  },
};
