/**
 * Morgan Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus/packages/morgan/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from nark-corpus/packages/morgan/contract.yaml:
 *   stream-write-error             — custom stream without .on('error') handler
 *   next-called-with-error         — token function throws → next(err) in middleware chain
 *   compile-non-string-throws      — morgan.compile(nonString) throws TypeError synchronously
 *   compile-invalid-token-syntax-silent — unregistered token resolves to '-' silently
 *   token-name-overwrite-silent    — morgan.token() overwrites built-in token silently
 *
 * Key behaviors under test:
 *   - morgan.compile(undefined) → compile-non-string-throws
 *   - morgan.compile(':x-nonexistent-token') → compile-invalid-token-syntax-silent
 *   - morgan.token('status', fn) → token-name-overwrite-silent (overwriting built-in)
 *   - morgan() with custom stream, no error handler → stream-write-error
 *
 * Design: spec-driven, NOT based on V1 behavior.
 * Note: Many new postconditions require scanner rules not yet implemented.
 *       Tests will show "no violations found" until bc-scanner-upgrade implements detectors.
 *       The fixture compiles and runs without crashing — the test structure is ready.
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
  '../../../../nark-corpus/packages/morgan/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('morgan: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH);
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
