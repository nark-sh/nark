/**
 * react-hook-form Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/react-hook-form/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/react-hook-form/contract.yaml:
 *   async-submit-unhandled-error  (handleSubmit())
 *
 * Key behaviors under test:
 *   - handleSubmit(asyncCallback) without try-catch → SHOULD_FIRE
 *   - handleSubmit(syncCallback) → SHOULD_NOT_FIRE  (concern-20260401-react-hook-form-1)
 *   - handleSubmit(async callback with full-body try-catch) → SHOULD_NOT_FIRE  (concern-20260401-react-hook-form-2)
 *   - handleSubmit(async callback with sync setup/teardown around try-catch) → SHOULD_NOT_FIRE  (concern-20260402-react-hook-form-5)
 *
 * Detection path: handleSubmit imported from react-hook-form → ThrowingFunctionDetector →
 *   ContractMatcher checks: (a) is callback async? (b) is callback body fully try-catch wrapped?
 *   postcondition: async-submit-unhandled-error
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
  '../../../../nark-corpus/packages/react-hook-form/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('react-hook-form: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH, { includeDrafts: true });
  });

  it('analyzer runs without errors', () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it('fixture has SHOULD_NOT_FIRE annotations (scanner-gap-only fixture)', () => {
    // react-hook-form uses `form.handleSubmit(callback)` property chain pattern.
    // The scanner cannot yet detect violations via instance method chains on useForm() results.
    // All postcondition firings are documented as scanner gaps. Once instance tracking is added,
    // SHOULD_FIRE annotations can be added and this check updated.
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
