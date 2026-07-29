/**
 * @solana/web3.js Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/@solana/web3.js/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from nark-corpus-pro/packages/@solana/web3.js/contract.yaml:
 *   sendtransaction-rpc-send-error
 *   sendrawtransaction-rpc-send-error
 *   confirmtransaction-expired-before-confirmation
 *   getbalance-rpc-error
 *   getaccountinfo-rpc-error
 *   getlatestblockhash-rpc-error
 *   simulatetransaction-rpc-error
 *   requestairdrop-rpc-error
 *   getsignaturestatus-rpc-error       (added 2026-07-28 deepen pass)
 *   gettransaction-rpc-error           (added 2026-07-28 deepen pass)
 *   gettokenaccountbalance-rpc-error   (added 2026-07-28 deepen pass)
 *   getmultipleaccountsinfo-rpc-error  (added 2026-07-28 deepen pass)
 *   getprogramaccounts-rpc-error       (added 2026-07-28 deepen pass)
 *
 * Key behaviors under test:
 *   - await connection.sendTransaction(...)      no try/catch          → SHOULD_FIRE
 *   - await connection.sendRawTransaction(...)   no try/catch          → SHOULD_FIRE
 *   - await connection.confirmTransaction(...)   no try/catch          → SHOULD_FIRE
 *   - await connection.getBalance(...)           no try/catch          → SHOULD_FIRE
 *   - await connection.getAccountInfo(...)       no try/catch          → SHOULD_FIRE
 *   - await connection.getLatestBlockhash()      no try/catch          → SHOULD_FIRE
 *   - await connection.simulateTransaction(...)  no try/catch          → SHOULD_FIRE
 *   - await connection.requestAirdrop(...)       no try/catch          → SHOULD_FIRE
 *   - await connection.getSignatureStatus(...)   no try/catch          → SHOULD_FIRE
 *   - await connection.getTransaction(...)       no try/catch          → SHOULD_FIRE
 *   - await connection.getTokenAccountBalance(...) no try/catch        → SHOULD_FIRE
 *   - await connection.getMultipleAccountsInfo(...) no try/catch       → SHOULD_FIRE
 *   - await connection.getProgramAccounts(...)   no try/catch          → SHOULD_FIRE
 *   - try { ... } finally { } (no catch clause)                       → SHOULD_FIRE
 *   - await this.conn.getBalance(...) (instance field) no try/catch    → SHOULD_FIRE
 *   - any of the above inside try/catch                                → SHOULD_NOT_FIRE
 *   - connection.getBalance(...).catch(...)                            → SHOULD_NOT_FIRE
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

// nark-corpus-pro is a sibling of nark-corpus: ../../../../nark-corpus-pro
const CORPUS_PRO_PATH = path.resolve(__dirname, '../../../../nark-corpus-pro');

const GROUND_TRUTH_PATH = path.resolve(
  CORPUS_PRO_PATH,
  'packages/@solana/web3.js/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@solana/web3.js: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PRO_PATH, {
      includeDrafts: true,
      packageName: '@solana/web3.js',
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
