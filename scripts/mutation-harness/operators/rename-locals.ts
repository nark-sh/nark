/**
 * M9 — rename-locals (neutral)
 *
 * Rename a local variable (declared by a `const`/`let`/`var` VariableDeclaration)
 * to a synonym. The scanner's postcondition matchers look at property access
 * chains, call names, and catch-clause presence — none should key on a random
 * local identifier. If the violation set changes, we have an accidental
 * identifier match.
 *
 * Applies to both `proper` and `missing` seeds.
 */

import * as ts from 'typescript';
import type { MutationOperator } from './types.js';
import { parse, findAll } from './ast-helpers.js';

export const renameLocalsOperator: MutationOperator = {
  name: 'rename-locals',
  kind: 'neutral',
  seedType: 'any',
  expected: 'unchanged',

  apply(sourceCode: string): string | null {
    const sf = parse(sourceCode);

    // Find the first local VariableDeclaration inside a function body with a plain
    // Identifier name.
    const decls = findAll(sf, (n): n is ts.VariableDeclaration =>
      ts.isVariableDeclaration(n) && ts.isIdentifier(n.name),
    );

    // Skip declarations at the top level (module-scoped consts).
    const localDecls = decls.filter((d) => {
      let cur: ts.Node | undefined = d.parent;
      while (cur) {
        if (
          ts.isFunctionDeclaration(cur) ||
          ts.isMethodDeclaration(cur) ||
          ts.isArrowFunction(cur) ||
          ts.isFunctionExpression(cur)
        ) {
          return true;
        }
        cur = cur.parent;
      }
      return false;
    });

    if (localDecls.length === 0) return null;

    const decl = localDecls[0];
    if (!ts.isIdentifier(decl.name)) return null;
    const oldName = decl.name.text;
    const newName = `${oldName}Renamed`;

    // Global-ish rename via regex on word boundary — safe for text-substitution
    // in fixtures because these are small, single-scope files.
    // But: preserve embedded strings by only replacing outside of quotes. Cheap
    // proxy: replace every whole-word occurrence. Fixtures don't quote locals.
    const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'g');
    const mutated = sourceCode.replace(regex, newName);

    if (mutated === sourceCode) return null;
    return mutated;
  },
};
