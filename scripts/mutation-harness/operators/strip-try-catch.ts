/**
 * M1 — strip-try-catch (FP-induction)
 *
 * Removes the first enclosing TryStatement, hoisting the try-block statements
 * into the parent block. The catch-clause is discarded entirely. The scanner
 * should react by producing an `unhandled` violation on the (now-unprotected)
 * await call inside.
 *
 * Applies to `proper-error-handling.ts` seeds.
 */

import * as ts from 'typescript';
import type { MutationOperator } from './types.js';
import { parse, findAll, spliceText, leadingIndent } from './ast-helpers.js';

export const stripTryCatchOperator: MutationOperator = {
  name: 'strip-try-catch',
  kind: 'fp-induction',
  seedType: 'proper',
  expected: 'violation-added',

  apply(sourceCode: string): string | null {
    const sf = parse(sourceCode);
    const tries = findAll(sf, (n): n is ts.TryStatement => ts.isTryStatement(n));
    if (tries.length === 0) return null;

    // Take the FIRST try statement (deterministic — same input, same output).
    const t = tries[0];

    // Extract the raw text of the try block's inner statements.
    const block = t.tryBlock;
    // block.getFullStart / getEnd captures the outer `{ ... }`; we want inside.
    const innerStart = block.getStart(sf) + 1; // after `{`
    const innerEnd = block.getEnd() - 1;       // before `}`
    const inner = sourceCode.slice(innerStart, innerEnd);

    // Preserve outer indentation.
    const indent = leadingIndent(sourceCode, t.getStart(sf));

    // De-indent the inner block by 2 spaces (best-effort — fixture files use 2-space indent).
    const dedented = inner
      .split('\n')
      .map((line, idx) => {
        // First line inherits the block-open trailing whitespace already; keep as-is.
        if (idx === 0) return line;
        // Strip up to 2 leading spaces from continuation lines.
        return line.replace(/^ {2}/, '');
      })
      .join('\n')
      .trimEnd();

    // The full try statement runs from t.getStart(sf) to t.getEnd().
    const replacement = dedented.trimStart();

    return spliceText(sourceCode, t.getStart(sf), t.getEnd(), replacement.trimStart() || indent);
  },
};
