/**
 * ethers Ground-Truth Tests
 *
 * Verifies that the scanner correctly detects missing try-catch on ethers v6 API
 * call sites annotated in the ground-truth fixture.
 *
 * Key behaviors under test:
 *   - wallet.sendTransaction()       without try-catch → fires
 *   - provider.estimateGas()         without try-catch → fires
 *   - provider.call()                without try-catch → fires
 *   - signer.populateTransaction()   without try-catch → fires (concern-20260618-ethers-deepen-1)
 *   - signer.populateAuthorization() without try-catch → fires
 *   - Any call inside try-catch      → does NOT fire
 *
 * The ethers contract uses `type_names: [Provider, Wallet, Signer, ...]` so that
 * function parameters typed as `ethers.Signer` (qualified namespace access) are
 * tracked as ethers instances. Concern concern-20260618-ethers-deepen-1 uncovered
 * that qualified-name type annotations (ethers.Signer) were NOT resolved by the
 * instance-tracker — only direct named imports (Signer) were. Fixed in
 * src/v2/plugins/instance-tracker.ts: beforeTraversal now builds a
 * namespaceQualifiers map and resolveTypeAnnotationWithName handles QualifiedName
 * types by checking if the left side (e.g. 'ethers') is a known namespace import
 * for the package, then verifying the right side ('Signer') is in type_names.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  runGroundTruth,
  CORPUS_PATH,
} from './harness.js';
import type { GroundTruthResult } from './harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GROUND_TRUTH_PATH = path.resolve(
  __dirname,
  '../../../../nark-corpus/packages/ethers/fixtures/ground-truth.ts'
);

describe('ethers: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH);
  });

  it('analyzer runs without errors', () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it('detects at least 15 violations across the fixture', () => {
    expect(result.violations.length).toBeGreaterThanOrEqual(15);
  });

  // Concern concern-20260618-ethers-deepen-1:
  // signer.populateTransaction() typed as 'signer: ethers.Signer' was NOT detected
  // because 'Signer' is not a named import (only 'ethers' namespace is).
  // Fixed by: namespaceQualifier resolution in instance-tracker.beforeTraversal.
  it('line 650: signer.populateTransaction() without try-catch fires (ethers.Signer param type)', () => {
    const viols = result.violationsByLine.get(650) ?? [];
    const postconditionIds = viols.map((v) => v.postconditionId);
    expect(viols.length).toBeGreaterThanOrEqual(1);
    expect(postconditionIds).toContain('populatetransaction-no-provider');
  });

  it('line 670: signer.populateTransaction() inside try-catch does NOT fire', () => {
    const viols = result.violationsByLine.get(670) ?? [];
    expect(viols.length).toBe(0);
  });

  // populateAuthorization also uses signer: ethers.Signer and was fixed by the same change.
  it('line 722: signer.populateAuthorization() without try-catch fires (ethers.Signer param type)', () => {
    const viols = result.violationsByLine.get(722) ?? [];
    const postconditionIds = viols.map((v) => v.postconditionId);
    expect(viols.length).toBeGreaterThanOrEqual(1);
    expect(postconditionIds).toContain('populateauthorization-no-provider-for-auto-fill');
  });

  // Other established detections (sanity checks)
  it('line 60: wallet.sendTransaction() without try-catch fires', () => {
    const viols = result.violationsByLine.get(60) ?? [];
    expect(viols.length).toBeGreaterThanOrEqual(1);
  });

  it('line 73: provider.estimateGas() without try-catch fires', () => {
    const viols = result.violationsByLine.get(73) ?? [];
    expect(viols.length).toBeGreaterThanOrEqual(1);
  });
});
