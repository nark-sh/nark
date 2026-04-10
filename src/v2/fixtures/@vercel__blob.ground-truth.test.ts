/**
 * @vercel/blob Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/@vercel/blob/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/@vercel/blob/contract.yaml:
 *   blob-put-no-try-catch    (put)
 *   blob-del-no-try-catch    (del)
 *   blob-list-no-try-catch   (list)
 *
 * Key behaviors under test:
 *   - await put(path, content, opts)    without try-catch → SHOULD_FIRE
 *   - await del(url)                    without try-catch → SHOULD_FIRE
 *   - await list({ prefix })            without try-catch → SHOULD_FIRE
 *   - Any put/del/list inside try-catch → SHOULD_NOT_FIRE
 *
 * Detection path: put/del/list imported from @vercel/blob →
 *   ThrowingFunctionDetector (depth-0) fires direct call →
 *   ContractMatcher checks try-catch → postcondition fires
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
  '../../../../corpus/packages/@vercel/blob/fixtures/ground-truth.ts'
);

// Parse annotations synchronously at module load (before beforeAll runs)
// so that describe() can iterate them to create individual it() calls.
const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('@vercel/blob: ground-truth fixture', () => {
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
