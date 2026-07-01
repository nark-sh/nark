/**
 * M10 — comment-noise (neutral)
 *
 * Inserts a `/* noise * /` (spaces added for JSDoc safety) block comment as a
 * standalone token inside the first function body that has more than one
 * statement. Should not affect any violation. If it does, the scanner is
 * over-matching on whitespace / statement position.
 *
 * Applies to both `proper` and `missing` seeds.
 */

import * as ts from 'typescript';
import type { MutationOperator } from './types.js';
import { parse, findAll, spliceText } from './ast-helpers.js';

export const commentNoiseOperator: MutationOperator = {
  name: 'comment-noise',
  kind: 'neutral',
  seedType: 'any',
  expected: 'unchanged',

  apply(sourceCode: string): string | null {
    const sf = parse(sourceCode);

    const blocks = findAll(sf, (n): n is ts.Block => ts.isBlock(n));
    for (const b of blocks) {
      if (b.statements.length < 2) continue;

      // Insert a block comment before the SECOND statement.
      const target = b.statements[1];
      const insertPoint = target.getStart(sf);
      const comment = `/* mutation-harness: noise */\n  `;
      return spliceText(sourceCode, insertPoint, insertPoint, comment);
    }

    return null;
  },
};
