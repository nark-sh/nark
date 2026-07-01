/**
 * M7 — add-promise-catch (TP-suppression)
 *
 * Attaches `.catch(...)` to the first `await pkg.op()` expression in the file.
 * Should REMOVE violations on postconditions that accept `.catch()` as valid
 * handling. (Per-postcondition-aware — some postconditions require typed try/catch
 * and will still fire.)
 *
 * Applies to `missing-error-handling.ts` seeds.
 */

import * as ts from 'typescript';
import type { MutationOperator } from './types.js';
import { parse, findAll, spliceText } from './ast-helpers.js';

export const addPromiseCatchOperator: MutationOperator = {
  name: 'add-promise-catch',
  kind: 'tp-suppression',
  seedType: 'missing',
  expected: 'violation-removed',

  apply(sourceCode: string): string | null {
    const sf = parse(sourceCode);

    const awaits = findAll(sf, (n): n is ts.AwaitExpression => ts.isAwaitExpression(n));
    for (const a of awaits) {
      // Only mutate awaits whose argument is a CallExpression, and are not already
      // inside a TryStatement.
      if (!ts.isCallExpression(a.expression)) continue;

      let inTry = false;
      let cur: ts.Node | undefined = a.parent;
      while (cur) {
        if (ts.isTryStatement(cur)) {
          inTry = true;
          break;
        }
        cur = cur.parent;
      }
      if (inTry) continue;

      // Splice: append `.catch(err => { console.error(err); })` after the CallExpression.
      const callEnd = a.expression.getEnd();
      const insertion = `.catch((err) => { console.error(err); })`;
      return spliceText(sourceCode, callEnd, callEnd, insertion);
    }

    return null;
  },
};
