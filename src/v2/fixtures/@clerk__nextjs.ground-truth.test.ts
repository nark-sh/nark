/**
 * @clerk/nextjs Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/@clerk/nextjs/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/@clerk/nextjs/contract.yaml:
 *   - verify-webhook-no-error-handling  (verifyWebhook() without try-catch)
 *   - create-user-no-error-handling     (clerkClient().users.createUser() without try-catch)
 *   - delete-user-no-error-handling     (clerkClient().users.deleteUser() without try-catch)
 *   - ban-user-no-error-handling        (clerkClient().users.banUser() without try-catch)
 *
 * Key behaviors under test:
 *   - verifyWebhook() without try-catch         → SHOULD_FIRE: verify-webhook-no-error-handling
 *   - verifyWebhook() inside try-catch          → SHOULD_NOT_FIRE
 *   - verifyWebhook() with .catch()             → SHOULD_NOT_FIRE
 *   - clerkClient().users.createUser() no catch → SHOULD_FIRE: create-user-no-error-handling
 *   - clerkClient().users.createUser() caught   → SHOULD_NOT_FIRE
 *   - clerkClient().users.deleteUser() no catch → SHOULD_FIRE: delete-user-no-error-handling
 *   - clerkClient().users.deleteUser() caught   → SHOULD_NOT_FIRE
 *   - clerkClient().users.banUser() no catch    → SHOULD_FIRE: ban-user-no-error-handling
 *   - clerkClient().users.banUser() caught      → SHOULD_NOT_FIRE
 *
 * Note: verify-webhook-missing-env-var, attempt-first-factor-no-error-handling,
 *   and use-user-no-loaded-check postconditions require scanner rule improvements.
 *   They are documented in upgrade-concerns.json but not yet detected.
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
  '../../../../nark-corpus/packages/@clerk/nextjs/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@clerk/nextjs: ground-truth fixture', () => {
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
