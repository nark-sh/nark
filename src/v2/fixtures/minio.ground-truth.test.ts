/**
 * minio Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/minio/fixtures/ground-truth.ts becomes one test case.
 *
 * Contracted functions (from import 'minio' / new Client({...})):
 *   - putObject / fPutObject / getObject / fGetObject / statObject /
 *     removeObject / removeObjects / bucketExists / makeBucket / removeBucket /
 *     listBuckets / copyObject / presignedGetObject / presignedPutObject /
 *     setBucketPolicy
 *
 * Key behaviors under test:
 *   - minioClient.<method>() outside try-catch / .catch()  → SHOULD_FIRE
 *   - minioClient.<method>() inside try-catch               → SHOULD_NOT_FIRE
 *   - minioClient.<method>().then(.., onRejected)           → SHOULD_NOT_FIRE
 *
 * Detection strategy: minio's Client class is registered in the contract's
 * detection.class_names so `new Client({...})` is tracked as a minio instance
 * via InstanceTrackerPlugin; downstream `minioClient.putObject(...)` resolves
 * to the corresponding postcondition via PropertyChainDetector / direct
 * method-name lookup.
 *
 * Corpus: nark-corpus-pro (PRO tier — minio is a paid-tier profile per
 * 2026-06-11 multi-corpus rule on new content).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  runGroundTruth,
  parseAnnotations,
  assertFires,
  assertNotFires,
} from './harness.js';
import type { GroundTruthResult, Annotation } from './harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Points to nark-corpus-pro, not nark-corpus
const PRO_CORPUS_PATH = path.resolve(__dirname, '../../../../nark-corpus-pro');

const GROUND_TRUTH_PATH = path.resolve(
  __dirname,
  '../../../../nark-corpus-pro/packages/minio/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('minio: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, PRO_CORPUS_PATH, { includeDrafts: true });
  });

  it('analyzer runs without errors', () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it('fixture has SHOULD_FIRE and SHOULD_NOT_FIRE annotations', () => {
    expect(ANNOTATIONS.filter((a: Annotation) => a.kind === 'SHOULD_FIRE').length).toBeGreaterThan(0);
    expect(ANNOTATIONS.filter((a: Annotation) => a.kind === 'SHOULD_NOT_FIRE').length).toBeGreaterThan(0);
  });

  for (const ann of ANNOTATIONS.filter((a: Annotation) => a.kind === 'SHOULD_FIRE')) {
    it(`line ${ann.line} should fire ${ann.postconditionId} — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }

  for (const ann of ANNOTATIONS.filter((a: Annotation) => a.kind === 'SHOULD_NOT_FIRE')) {
    it(`line ${ann.line} should not fire — ${ann.reason.substring(0, 60)}`, () => {
      const check = assertNotFires(result.violationsByLine, ann);
      expect(check.passed, check.message).toBe(true);
    });
  }
});
