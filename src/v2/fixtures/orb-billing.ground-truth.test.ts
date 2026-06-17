/**
 * orb-billing Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/orb-billing/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from nark-corpus-pro/packages/orb-billing/contract.yaml:
 *   validation-error           (customers.create / update / etc. — body validation 400)
 *   resource-not-found          (fetch / fetchByExternalId / update / cancel — 404)
 *   rate-limit-error            (events.ingest, list — 429)
 *   authentication-error        (every method — 401)
 *   connection-error            (every method — network / timeout)
 *   signature-verification-failed (webhooks.unwrap / verifySignature)
 *
 * Key behaviors under test:
 *   - client.<resource>.<method>(...) without try-catch → SHOULD_FIRE
 *   - Same call inside try-catch → SHOULD_NOT_FIRE
 *   - webhooks.unwrap / verifySignature (sync, but throws) follow the same rules
 *
 * Detection path: orb-billing default import → ThrowingFunctionDetector matches
 *   resource-method calls and webhook methods → ContractMatcher checks try-catch →
 *   postcondition fires.
 *
 * Note: orb-billing lives in nark-corpus-pro (paid tier), so we override CORPUS_PATH.
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

// orb-billing lives in nark-corpus-pro, not the public nark-corpus
const PRO_CORPUS_PATH = path.resolve(
  __dirname,
  '../../../../nark-corpus-pro'
);

const GROUND_TRUTH_PATH = path.resolve(
  __dirname,
  '../../../../nark-corpus-pro/packages/orb-billing/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('orb-billing: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, PRO_CORPUS_PATH, {
      includeDrafts: true,
      packageName: 'orb-billing',
    });
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
