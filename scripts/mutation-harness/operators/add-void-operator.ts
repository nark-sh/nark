/**
 * M6 — add-void-operator (neutral robustness probe)
 *
 * Prefixes an eligible `await pkg.op()` expression with `void`. The scanner
 * cares about error handling, not return-value use, so this should be a NO-OP
 * on the violation set. If the count changes, the scanner is misusing the
 * discarded-value signal as a proxy for error handling.
 *
 * Applies to both `proper` and `missing` seeds.
 */

import * as ts from 'typescript';
import type { MutationOperator } from './types.js';
import { parse, findAll, spliceText } from './ast-helpers.js';

export const addVoidOperatorOperator: MutationOperator = {
  name: 'add-void-operator',
  kind: 'neutral',
  seedType: 'any',
  expected: 'unchanged',

  apply(sourceCode: string): string | null {
    const sf = parse(sourceCode);

    // Find an ExpressionStatement wrapping an AwaitExpression — the discardable case.
    // Statement `await x;` becomes `void await x;`.
    const stmts = findAll(sf, (n): n is ts.ExpressionStatement =>
      ts.isExpressionStatement(n) && ts.isAwaitExpression(n.expression),
    );

    if (stmts.length === 0) return null;

    const s = stmts[0];
    const exprStart = s.expression.getStart(sf);
    return spliceText(sourceCode, exprStart, exprStart, 'void ');
  },
};
