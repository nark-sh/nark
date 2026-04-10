/**
 * braintree Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/braintree/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/braintree/contract.yaml:
 *   api-error (used by all contracted functions: sale, generate, create, find, refund)
 *
 * Key behaviors under test:
 *   - gateway.transaction.sale()     without try-catch → SHOULD_FIRE: api-error
 *   - gateway.clientToken.generate() without try-catch → SHOULD_FIRE: api-error
 *   - gateway.customer.create()      without try-catch → SHOULD_FIRE: api-error
 *   - gateway.customer.find()        without try-catch → SHOULD_FIRE: api-error
 *   - gateway.transaction.find()     without try-catch → SHOULD_FIRE: api-error
 *   - gateway.transaction.refund()   without try-catch → SHOULD_FIRE: api-error
 *   - result.success check only (no try-catch)         → SHOULD_FIRE (not a substitute)
 *   - Any call inside try-catch                        → SHOULD_NOT_FIRE
 *
 * Detection: BraintreeGateway instance tracking.
 *   new braintree.BraintreeGateway() → tracked via new module.ClassName() fix in instance-tracker.
 *   PropertyChainDetector fires for gateway.transaction.sale() (depth=2 from instance).
 *
 * Design: spec-driven, NOT based on V1 behavior.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  runGroundTruth,
  parseAnnotations,
  assertFires,
  assertNotFires,
  CORPUS_PATH,
} from './harness.js';
import type { GroundTruthResult, Annotation } from './harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GROUND_TRUTH_PATH = path.resolve(
  __dirname,
  '../../../../corpus/packages/braintree/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('braintree: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH, { includeDrafts: true });
  });

  it('analyzer runs without errors', () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it('fixture has SHOULD_FIRE and SHOULD_NOT_FIRE annotations', () => {
    expect(ANNOTATIONS.filter(a => a.kind === 'SHOULD_FIRE').length).toBeGreaterThan(0);
    expect(ANNOTATIONS.filter(a => a.kind === 'SHOULD_NOT_FIRE').length).toBeGreaterThan(0);
  });

  // One test per SHOULD_FIRE annotation
  for (const ann of ANNOTATIONS.filter(a => a.kind === 'SHOULD_FIRE')) {
    it(`line ${ann.line} should fire ${ann.postconditionId} — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }

  // One test per SHOULD_NOT_FIRE annotation
  for (const ann of ANNOTATIONS.filter(a => a.kind === 'SHOULD_NOT_FIRE')) {
    it(`line ${ann.line} should not fire — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertNotFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }
});
