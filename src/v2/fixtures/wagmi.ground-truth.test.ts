/**
 * wagmi Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/wagmi/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from nark-corpus-pro/packages/wagmi/contract.yaml:
 *   connect-already-connected, connect-user-rejected (connect)
 *   switchchain-not-supported, switchchain-not-configured,
 *     switchchain-user-rejected (switchChain)
 *   signmessage-not-connected, signmessage-user-rejected (signMessage)
 *   simulatecontract-reverted (simulateContract)
 *   writecontract-not-connected, writecontract-node-execution-error,
 *     writecontract-user-rejected (writeContract)
 *   sendtransaction-not-connected, sendtransaction-node-execution-error,
 *     sendtransaction-user-rejected (sendTransaction)
 *   waitfortxreceipt-reverted (waitForTransactionReceipt)
 *   readcontract-reverted (readContract)
 *
 * Detection: plain named-import direct calls from 'wagmi/actions'
 * (normalizes to package "wagmi"). No instance/factory tracking.
 *
 * Design: spec-driven, NOT based on V1 behavior. Covers only the
 * imperative `wagmi/actions` call shape — the hook-mutation shape
 * (`useWriteContract().writeContractAsync`) is a documented scanner gap,
 * not exercised here (see the trailing comment block in ground-truth.ts).
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

const GROUND_TRUTH_PATH = path.resolve(
  __dirname,
  '../../../../nark-corpus-pro/packages/wagmi/fixtures/ground-truth.ts'
);
const PRO_CORPUS_PATH = path.resolve(__dirname, '../../../../nark-corpus-pro');

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('wagmi: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, PRO_CORPUS_PATH, {
      includeDrafts: true,
      packageName: 'wagmi',
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
