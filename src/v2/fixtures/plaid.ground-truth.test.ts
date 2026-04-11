/**
 * plaid Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/plaid/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/plaid/contract.yaml:
 *   api-error (used by all 6 contracted functions)
 *
 * Key behaviors under test:
 *   - plaidClient.linkTokenCreate()          without try-catch → SHOULD_FIRE: api-error
 *   - plaidClient.itemPublicTokenExchange()  without try-catch → SHOULD_FIRE: api-error
 *   - plaidClient.transactionsSync()         without try-catch → SHOULD_FIRE: api-error
 *   - plaidClient.accountsGet()              without try-catch → SHOULD_FIRE: api-error
 *   - plaidClient.authGet()                  without try-catch → SHOULD_FIRE: api-error
 *   - plaidClient.transferCreate()           without try-catch → SHOULD_FIRE: api-error
 *   - Any call inside try-catch              → SHOULD_NOT_FIRE
 *
 * Detection: PlaidApi instance tracking (class_names: ["PlaidApi"]).
 * All methods are direct instance calls (2-level chains).
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
  '../../../../nark-corpus/packages/plaid/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('plaid: ground-truth fixture', () => {
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
