/**
 * express-validator Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus/packages/express-validator/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from nark-corpus/packages/express-validator/contract.yaml:
 *   errors-not-checked           (validationResult)
 *   validation-errors-silent     (body, check, query, param)
 *   cookie-validation-errors-silent  (cookie)
 *   header-validation-errors-silent  (header)
 *   checkschema-validation-errors-silent  (checkSchema)
 *   checkschema-run-result-not-checked    (checkSchema)
 *   oneof-all-chains-failed-error-not-checked  (oneOf)
 *   checkexact-unknown-fields-not-checked       (checkExact)
 *   checkexact-ordering-violation               (checkExact)
 *   run-result-not-checked                      (run)
 *   run-not-awaited                             (run)
 *   result-throw-no-trycatch                    (result-throw)
 *
 * Design: spec-driven, NOT based on V1 behavior.
 * Note: Many of these postconditions require advanced data-flow analysis that
 * the V2 scanner may not yet implement. Tests marked with "no detector" will
 * show skipped/pending until scanner rules are added (bc-scanner-upgrade).
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
  '../../../../nark-corpus/packages/express-validator/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('express-validator: ground-truth fixture', () => {
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
