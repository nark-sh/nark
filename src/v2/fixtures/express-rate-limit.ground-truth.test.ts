/**
 * express-rate-limit Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/express-rate-limit/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/express-rate-limit/contract.yaml:
 *   store-error-fail-closed     (rateLimit — store throws, passOnStoreError: false)
 *   store-error-fail-open       (rateLimit — store throws, passOnStoreError: true)
 *   rate-limit-exceeded         (rateLimit — client exceeds limit, HTTP 429)
 *   undefined-ip                (rateLimit — request.ip undefined, trust proxy missing)
 *   store-reuse                 (rateLimit — single store shared across multiple limiters)
 *   success-within-limit        (rateLimit — client within limit)
 *   invalid-ip-address          (rateLimit — ERR_ERL_INVALID_IP_ADDRESS)
 *   x-forwarded-for-without-trust-proxy  (rateLimit — ERR_ERL_UNEXPECTED_X_FORWARDED_FOR)
 *   double-count                (rateLimit — ERR_ERL_DOUBLE_COUNT)
 *   created-in-request-handler  (rateLimit — ERR_ERL_CREATED_IN_REQUEST_HANDLER)
 *   rateLimit-invalid-store     (rateLimit — TypeError at startup for invalid store)
 *   async-callback-error-routes-to-handler  (rateLimit — async callbacks route to next(error))
 *   get-key-store-unsupported   (getKey — store lacks get(), throws synchronously)
 *   get-key-store-error         (getKey — store get() rejects, propagates to caller)
 *   reset-key-unprotected-endpoint  (resetKey — endpoint is itself rate limited)
 *   reset-key-wrong-key-format  (resetKey — key format mismatches keyGenerator)
 *
 * Design: spec-driven, NOT based on V1 behavior.
 * New postconditions (rateLimit-invalid-store, async-callback-error-routes-to-handler)
 * will show as "no detector" until scanner upgrade concerns are implemented.
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
  '../../../../nark-corpus/packages/express-rate-limit/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('express-rate-limit: ground-truth fixture', () => {
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
