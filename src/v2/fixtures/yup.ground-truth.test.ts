/**
 * yup Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/yup/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/yup/contract.yaml:
 *   validate-rejects
 *   validatesync-throws
 *   validatesync-async-test-throws
 *   validateat-rejects
 *   validatesyncat-throws
 *   isvalid-non-validation-error-rethrows
 *   cast-type-error
 *   cast-transform-throws
 *
 * Key behaviors under test:
 *   - schema.validate() without try-catch → SHOULD_FIRE validate-rejects
 *   - schema.validateSync() without try-catch → SHOULD_FIRE validatesync-throws
 *   - schema.isValid() without catch on schema with async tests → SHOULD_FIRE isvalid-non-validation-error-rethrows
 *   - schema.cast() without try-catch → SHOULD_FIRE cast-type-error
 *   - All above with proper error handling → SHOULD_NOT_FIRE
 *
 * Note: The yup analyzer has a known limitation — schema instances created by
 * factory functions (Yup.object(), Yup.string(), etc.) cannot be tracked by
 * the current analyzer. Detection rate is currently 0%. These tests document
 * the expected behavior for when that limitation is resolved.
 *
 * Detection path (when limitation is resolved): Yup factory call tracked →
 *   schema instance → ThrowingFunctionDetector fires on validate/validateSync/cast →
 *   ContractMatcher checks try-catch → postcondition
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
  '../../../../nark-corpus/packages/yup/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('yup: ground-truth fixture', () => {
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
