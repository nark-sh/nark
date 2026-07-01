/**
 * M4 — split-try-block (FP-induction)
 *
 * Splits a multi-statement try block into two separate try blocks with the
 * middle await escaping try scope. Given:
 *
 *   try { a; await b; c; } catch (e) { ... }
 *
 * produces:
 *
 *   try { a; } catch (e) {}
 *   await b;
 *   try { c; } catch (e) {}
 *
 * Applies to `proper-error-handling.ts` seeds with try blocks containing 3+ statements.
 */

import * as ts from 'typescript';
import type { MutationOperator } from './types.js';
import { parse, findAll, spliceText, leadingIndent } from './ast-helpers.js';

export const splitTryBlockOperator: MutationOperator = {
  name: 'split-try-block',
  kind: 'fp-induction',
  seedType: 'proper',
  expected: 'violation-added',

  apply(sourceCode: string): string | null {
    const sf = parse(sourceCode);
    const tries = findAll(sf, (n): n is ts.TryStatement => ts.isTryStatement(n));
    if (tries.length === 0) return null;

    for (const t of tries) {
      const stmts = t.tryBlock.statements;
      if (stmts.length < 2) continue;

      // Find first statement containing an await; must not be first or last for split to be meaningful.
      let awaitIdx = -1;
      for (let i = 0; i < stmts.length; i++) {
        const s = stmts[i];
        let hasAwait = false;
        const walk = (n: ts.Node): void => {
          if (ts.isAwaitExpression(n)) hasAwait = true;
          if (!hasAwait) ts.forEachChild(n, walk);
        };
        walk(s);
        if (hasAwait) {
          awaitIdx = i;
          break;
        }
      }

      // If awaitIdx is first statement, we can still split (empty first try, await outside, second try with rest).
      // But that only works if there's a rest to put in second try.
      if (awaitIdx === -1) continue;
      if (awaitIdx === stmts.length - 1 && awaitIdx === 0) continue;

      const indent = leadingIndent(sourceCode, t.getStart(sf));
      const catchParam =
        t.catchClause?.variableDeclaration &&
        ts.isIdentifier(t.catchClause.variableDeclaration.name)
          ? t.catchClause.variableDeclaration.name.text
          : 'e';

      // Build the split output as three text chunks.
      const awaitStmt = stmts[awaitIdx];
      const awaitText = sourceCode.slice(awaitStmt.getStart(sf), awaitStmt.getEnd());

      const beforeStmts = stmts.slice(0, awaitIdx);
      const afterStmts = stmts.slice(awaitIdx + 1);

      const stmtText = (s: ts.Statement): string =>
        sourceCode.slice(s.getStart(sf), s.getEnd());

      const parts: string[] = [];
      if (beforeStmts.length > 0) {
        parts.push(
          `try {\n${beforeStmts.map((s) => `${indent}  ${stmtText(s)}`).join('\n')}\n${indent}} catch (${catchParam}) {}`,
        );
      }
      parts.push(awaitText);
      if (afterStmts.length > 0) {
        parts.push(
          `try {\n${afterStmts.map((s) => `${indent}  ${stmtText(s)}`).join('\n')}\n${indent}} catch (${catchParam}) {}`,
        );
      }

      const replacement = parts.join(`\n${indent}`);
      return spliceText(sourceCode, t.getStart(sf), t.getEnd(), replacement);
    }

    return null;
  },
};
