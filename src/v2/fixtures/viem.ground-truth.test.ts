/**
 * viem Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/viem/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from nark-corpus-pro/packages/viem/contract.yaml:
 *   readcontract-reverted, readcontract-zero-data (readContract)
 *   simulatecontract-reverted (simulateContract)
 *   writecontract-node-execution-error (writeContract)
 *   sendtransaction-account-not-found, sendtransaction-node-execution-error,
 *     sendtransaction-user-rejected (sendTransaction)
 *   waitfortxreceipt-timeout (waitForTransactionReceipt)
 *   call-execution-error (call)
 *   estimategas-execution-error (estimateGas)
 *   estimatecontractgas-reverted (estimateContractGas)
 *   getbalance-rpc-transport-error (getBalance)
 *   getgasprice-rpc-transport-error (getGasPrice)
 *   gettransactionreceipt-not-found (getTransactionReceipt)
 *   gettransaction-not-found (getTransaction)
 *   multicall-allow-failure-false-throws (multicall)
 *   getlogs-range-too-large (getLogs)
 *   signmessage-user-rejected (signMessage)
 *   signtypeddata-user-rejected (signTypedData)
 *   deploycontract-node-execution-error (deployContract)
 *   requestaddresses-user-rejected-or-busy (requestAddresses)
 *   switchchain-not-added, switchchain-user-rejected (switchChain)
 *   sendrawtransaction-rpc-rejection (sendRawTransaction)
 *   gettransactioncount-rpc-transport-error (getTransactionCount)
 *   estimatefeespergas-eip1559-not-supported (estimateFeesPerGas)
 *   getblocknumber-rpc-transport-error (getBlockNumber)
 *   getfeehistory-rpc-transport-error (getFeeHistory)
 *   getcode-rpc-transport-error (getCode)
 *   gettransactionconfirmations-transaction-not-found (getTransactionConfirmations)
 *   addchain-rpc-rejection (addChain)
 *
 * Detection: viem client instance tracking via factory_methods
 * (createPublicClient / createWalletClient / createClient / createTestClient).
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
} from './harness.js';
import type { GroundTruthResult, Annotation } from './harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GROUND_TRUTH_PATH = path.resolve(
  __dirname,
  '../../../../nark-corpus-pro/packages/viem/fixtures/ground-truth.ts'
);
const PRO_CORPUS_PATH = path.resolve(__dirname, '../../../../nark-corpus-pro');

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('viem: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, PRO_CORPUS_PATH, {
      includeDrafts: true,
      packageName: 'viem',
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
