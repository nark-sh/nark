/**
 * @aws-sdk/s3-request-presigner Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/@aws-sdk/s3-request-presigner/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/@aws-sdk/s3-request-presigner/contract.yaml:
 *   presigner-credential-error         (getSignedUrl)
 *   presigner-post-credential-error    (createPresignedPost)
 *
 * Key behaviors under test:
 *   - await getSignedUrl(s3Client, new GetObjectCommand(...))  without try-catch → SHOULD_FIRE
 *   - await getSignedUrl(s3Client, new PutObjectCommand(...))  without try-catch → SHOULD_FIRE
 *   - await createPresignedPost(s3Client, ...)                without try-catch → SHOULD_FIRE
 *   - Any getSignedUrl/createPresignedPost inside try-catch → SHOULD_NOT_FIRE
 *
 * Detection path: getSignedUrl imported from @aws-sdk/s3-request-presigner →
 *   ThrowingFunctionDetector (depth-0) fires direct call getSignedUrl(...) →
 *   ContractMatcher checks try-catch → postcondition presigner-credential-error
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
  '../../../../corpus/packages/@aws-sdk/s3-request-presigner/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@aws-sdk/s3-request-presigner: ground-truth fixture', () => {
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
