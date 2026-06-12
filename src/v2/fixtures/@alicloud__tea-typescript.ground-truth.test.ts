/**
 * @alicloud/tea-typescript Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/@alicloud/tea-typescript/fixtures/ground-truth.ts
 * becomes one test case.
 *
 * Postcondition IDs from nark-corpus-pro/packages/@alicloud/tea-typescript/contract.yaml:
 *   error-transport-failure        (doAction throws on network/timeout/TLS)
 *   error-body-stream-failure      (readBytes throws on mid-body stream error)
 *   error-cast-validation-failure  (cast throws sync on type-mismatch / non-Map input)
 *
 * Key behaviors under test:
 *   - await $tea.doAction(...) / doAction(...) without try/catch → SHOULD_FIRE
 *   - await $tea.doAction(...) inside try/catch or with .catch() chain → SHOULD_NOT_FIRE
 *   - Canonical openapi-client retry-loop pattern → SHOULD_NOT_FIRE
 *   - $tea.cast(...) outside try/catch → SHOULD_FIRE (sync throw, isInTryCatch gate)
 *   - $tea.cast(...) inside try/catch with doAction → SHOULD_NOT_FIRE (canonical pattern)
 *   - $tea.cast(...) after .catch() chain on doAction → SHOULD_FIRE (.catch on awaited
 *     Promise does NOT protect the subsequent sync cast call site)
 *
 * NOTE: readBytes() is contracted but the scanner does not yet detect method
 * calls on Response instances (upgrade-concerns
 * concern-20260611-tea-typescript-onboard-1). readBytes call sites in the
 * ground-truth fixture intentionally carry no SHOULD_FIRE / SHOULD_NOT_FIRE
 * annotations until the scanner gains property-chain detection.
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
  'packages/@alicloud/tea-typescript/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@alicloud/tea-typescript: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PRO_PATH, {
      includeDrafts: true,
      packageName: '@alicloud/tea-typescript',
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
