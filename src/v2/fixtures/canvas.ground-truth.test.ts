/**
 * canvas Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/canvas/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from nark-corpus-pro/packages/canvas/contract.yaml:
 *   loadimage-rejects-on-error           (loadImage(src))
 *   tobuffer-sync-throws-on-encoder-error (canvas.toBuffer(mime, cfg))
 *   registerfont-throws-on-missing-or-invalid-font (registerFont(path, face))
 *
 * Key behaviors under test:
 *   - await loadImage(src) without try-catch                     → SHOULD_FIRE
 *   - await loadImage(src) inside try-catch                      → SHOULD_NOT_FIRE
 *   - loadImage(src).then(...).catch(...)                        → SHOULD_NOT_FIRE
 *   - canvas.toBuffer('image/png') without try-catch             → SHOULD_FIRE
 *   - canvas.toBuffer(...) inside try-catch                      → SHOULD_NOT_FIRE
 *   - registerFont(path, face) without try-catch                 → SHOULD_FIRE
 *   - registerFont(path, face) inside try-catch                  → SHOULD_NOT_FIRE
 *
 * Detection path: canvas package imported → createCanvas() factory call tracked as
 *   instance → ThrowingFunctionDetector fires loadImage / .toBuffer() / registerFont →
 *   ContractMatcher checks try-catch → postcondition fires.
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

// nark-corpus-pro is a sibling of nark-corpus: ../../../../nark-corpus-pro
const CORPUS_PRO_PATH = path.resolve(__dirname, '../../../../nark-corpus-pro');

const GROUND_TRUTH_PATH = path.resolve(
  CORPUS_PRO_PATH,
  'packages/canvas/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('canvas: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PRO_PATH, {
      includeDrafts: true,
      packageName: 'canvas',
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
