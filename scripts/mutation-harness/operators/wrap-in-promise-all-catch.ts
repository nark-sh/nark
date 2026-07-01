/**
 * M8 — wrap-in-promise-all-catch (TP-suppression)
 *
 * Wraps the first unprotected `await pkg.op()` in
 * `await Promise.all([pkg.op()]).catch(err => { console.error(err); })`.
 *
 * Applies to `missing-error-handling.ts` seeds.
 */

import * as ts from 'typescript';
import type { MutationOperator } from './types.js';
import { parse, findAll, spliceText } from './ast-helpers.js';

export const wrapInPromiseAllCatchOperator: MutationOperator = {
  name: 'wrap-in-promise-all-catch',
  kind: 'tp-suppression',
  seedType: 'missing',
  expected: 'violation-removed',

  apply(sourceCode: string): string | null {
    const sf = parse(sourceCode);

    const awaits = findAll(sf, (n): n is ts.AwaitExpression => ts.isAwaitExpression(n));
    for (const a of awaits) {
      if (!ts.isCallExpression(a.expression)) continue;

      // Skip if already inside a try.
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

      const callStart = a.expression.getStart(sf);
      const callEnd = a.expression.getEnd();
      const callText = sourceCode.slice(callStart, callEnd);

      const replacement = `Promise.all([${callText}]).catch((err) => { console.error(err); })`;
      return spliceText(sourceCode, callStart, callEnd, replacement);
    }

    return null;
  },
};
