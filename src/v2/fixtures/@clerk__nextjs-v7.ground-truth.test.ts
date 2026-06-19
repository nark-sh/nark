/**
 * @clerk/nextjs v7+ Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/@clerk/nextjs-v7/fixtures/ground-truth.ts becomes one test case.
 *
 * v7-specific postcondition IDs from corpus/packages/@clerk/nextjs-v7/contract.yaml:
 *   - get-token-ssr-not-handled                       (useAuth().getToken() called SSR)
 *   - get-token-offline-not-handled                   (getToken() null-checked w/o try-catch)
 *   - middleware-missing-encryption-key               (clerkMiddleware with secretKey, no encryption key)
 *   - protect-server-action-status-code-changed       (auth.protect() server action 404 → 401)
 *   - use-user-initial-auth-state-removed             (useUser/useAuth with deprecated initialAuthState)
 *   - current-user-pending-session-default-changed    (currentUser() with pending-state branch)
 *
 * Note: cycle-12 wired this driver after cycle-11 discovered the fixture was fully
 * annotated but had no driver. Many v7 postconditions require context-aware detection
 * (Server Component vs Client; useEffect vs render; 'use server' file context) which
 * the original handoff (2026-06-18-scanner-deepen-followups.md) classified as HEAVY.
 * The driver makes the gap measurable; failing tests document which patterns still
 * need new detector work.
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
  '../../../../nark-corpus/packages/@clerk/nextjs-v7/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@clerk/nextjs-v7: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH, { includeDrafts: true });
  }, 60_000);

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
