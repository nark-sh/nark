/**
 * @auth0/nextjs-auth0 Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/@auth0/nextjs-auth0/fixtures/ground-truth.ts becomes one test case.
 *
 * Contracted functions (4 total):
 *   - getAccessToken   — throws AccessTokenError on refresh failure
 *   - handleCallback   — throws CallbackHandlerError on OAuth callback failure
 *   - handleLogin      — throws LoginHandlerError on redirect failure
 *   - handleLogout     — throws LogoutHandlerError on logout failure
 *
 * Key behaviors under test:
 *   - getAccessToken() without try-catch → SHOULD_FIRE
 *   - getAccessToken() with scopes, no try-catch → SHOULD_FIRE
 *   - getAccessToken() inside try-catch → SHOULD_NOT_FIRE
 *   - handleCallback() without try-catch → SHOULD_FIRE
 *   - handleCallback() inside try-catch → SHOULD_NOT_FIRE
 *   - handleLogin() without try-catch → SHOULD_FIRE
 *   - handleLogin() inside try-catch → SHOULD_NOT_FIRE
 *   - handleLogout() without try-catch → SHOULD_FIRE
 *   - handleLogout() inside try-catch → SHOULD_NOT_FIRE
 *
 * Detection strategy: standalone function import from '@auth0/nextjs-auth0'.
 * Detected by ThrowingFunctionDetectorPlugin.
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
  '../../../../nark-corpus/packages/@auth0/nextjs-auth0/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@auth0/nextjs-auth0: ground-truth fixture', () => {
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
