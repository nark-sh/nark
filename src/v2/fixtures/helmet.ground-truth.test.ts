/**
 * helmet Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/helmet/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/helmet/contract.yaml:
 *   config-validation-error       — helmet() throws on invalid configuration
 *   csp-invalid-directive-name    — contentSecurityPolicy() throws on invalid directive name
 *   hsts-invalid-maxage           — strictTransportSecurity() throws on invalid maxAge
 *   coep-invalid-policy           — crossOriginEmbedderPolicy() throws on invalid policy
 *   coop-invalid-policy           — crossOriginOpenerPolicy() throws on invalid policy
 *   corp-invalid-policy           — crossOriginResourcePolicy() throws on invalid policy
 *   referrer-invalid-policy-token — referrerPolicy() throws on invalid token
 *   referrer-empty-policy-array   — referrerPolicy() throws on empty array
 *   xfo-invalid-action            — xFrameOptions() throws on invalid action
 *   xpcdp-invalid-policy          — xPermittedCrossDomainPolicies() throws on invalid policy
 *   csp-no-directives             — contentSecurityPolicy() throws on empty directives with useDefaults:false
 *
 * Key behaviors under test:
 *   - helmet() without try-catch → SHOULD_FIRE
 *   - helmet() inside try-catch → SHOULD_NOT_FIRE
 *   - All sub-middleware factories without try-catch → SHOULD_FIRE
 *   - All sub-middleware factories inside try-catch → SHOULD_NOT_FIRE
 *
 * Note: helmet is a synchronous middleware factory — errors thrown at
 * configuration time, not request time. The scanner should detect missing
 * try-catch around both helmet() and all helmet.subFunction() calls.
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
  '../../../../nark-corpus/packages/helmet/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('helmet: ground-truth fixture', () => {
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
