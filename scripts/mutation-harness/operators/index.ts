/**
 * Registry of all 10 mutation operators per
 * work-packages/accuracy-roadmap/0004-mutation-harness-spec.md §2.
 */

import type { MutationOperator } from './types.js';
import { stripTryCatchOperator } from './strip-try-catch.js';
import { narrowTryScopeOperator } from './narrow-try-scope.js';
import { emptyCatchRethrowOperator } from './empty-catch-rethrow.js';
import { splitTryBlockOperator } from './split-try-block.js';
import { addOuterTryOperator } from './add-outer-try.js';
import { addPromiseCatchOperator } from './add-promise-catch.js';
import { wrapInPromiseAllCatchOperator } from './wrap-in-promise-all-catch.js';
import { addVoidOperatorOperator } from './add-void-operator.js';
import { renameLocalsOperator } from './rename-locals.js';
import { commentNoiseOperator } from './comment-noise.js';

export const ALL_OPERATORS: MutationOperator[] = [
  stripTryCatchOperator,
  narrowTryScopeOperator,
  emptyCatchRethrowOperator,
  splitTryBlockOperator,
  addOuterTryOperator,
  addPromiseCatchOperator,
  wrapInPromiseAllCatchOperator,
  addVoidOperatorOperator,
  renameLocalsOperator,
  commentNoiseOperator,
];

export type { MutationOperator } from './types.js';
