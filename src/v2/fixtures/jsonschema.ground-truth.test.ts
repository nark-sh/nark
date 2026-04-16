/**
 * jsonschema Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/jsonschema/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/jsonschema/contract.yaml:
 *   validate-throw-first             (validate() with throwFirst option)
 *   validate-throw-all               (validate() with throwAll option)
 *   validate-throw-error             (validate() with throwError option)
 *   validate-invalid-schema-argument (validate() with null/non-object schema)
 *   validate-unknown-attribute-throws (validate() with allowUnknownAttributes:false)
 *   validate-result-unchecked        (validate() result discarded without checking .valid)
 *   validator-validate-throw         (Validator.validate() with throw options)
 *   validator-validate-unresolved-ref (Validator.validate() with unregistered $ref)
 *   add-schema-invalid               (addSchema() with invalid schema from external source)
 *   scan-duplicate-conflicting-schema (scan() with conflicting schema IDs)
 *
 * Key behaviors under test:
 *   - All throwing validate() patterns without try-catch → SHOULD_FIRE
 *   - validate() result discarded without .valid check → SHOULD_FIRE
 *   - Validator.validate() with unresolved $ref → SHOULD_FIRE
 *   - scan() with conflicting schemas → SHOULD_FIRE
 *   - Any of the above inside try-catch or with proper result checking → SHOULD_NOT_FIRE
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
  '../../../../nark-corpus/packages/jsonschema/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('jsonschema: ground-truth fixture', () => {
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

  for (const ann of ANNOTATIONS.filter(a => a.kind === 'SHOULD_FIRE')) {
    it(`line ${ann.line} should fire ${ann.postconditionId} — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }

  for (const ann of ANNOTATIONS.filter(a => a.kind === 'SHOULD_NOT_FIRE')) {
    it(`line ${ann.line} should not fire — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertNotFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }
});
