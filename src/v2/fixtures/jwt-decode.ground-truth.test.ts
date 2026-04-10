/**
 * jwt-decode Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/jwt-decode/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/jwt-decode/contract.yaml:
 *   invalid-token (on function: jwtDecode)
 *
 * Detection: uses import_patterns ('jwt-decode') and call_patterns (jwtDecode())
 * jwtDecode() without try-catch → SHOULD_FIRE
 * jwtDecode() inside try-catch → SHOULD_NOT_FIRE
 *
 * Design: tests are spec-driven, NOT based on V1 behavior.
 * The analyzer runs once; each annotation is checked against the shared result.
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
  '../../../../corpus/packages/jwt-decode/fixtures/ground-truth.ts'
);

// Parse annotations synchronously at module load (before beforeAll runs)
const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('jwt-decode: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PATH, { includeDrafts: true });
  });

  it('analyzer runs without errors', () => {
    expect(result).toBeDefined();
    expect(Array.isArray(result.violations)).toBe(true);
  });

  it('fixture has SHOULD_FIRE and SHOULD_NOT_FIRE annotations', () => {
    const fires = ANNOTATIONS.filter(a => a.kind === 'SHOULD_FIRE');
    const notFires = ANNOTATIONS.filter(a => a.kind === 'SHOULD_NOT_FIRE');
    expect(fires.length).toBeGreaterThan(0);
    expect(notFires.length).toBeGreaterThan(0);
  });

  // Dynamic test cases — one per annotation
  for (const annotation of ANNOTATIONS) {
    const label = `line ${annotation.line}: ${annotation.kind} — ${annotation.reason}`;

    it(label, () => {
      if (annotation.kind === 'SHOULD_FIRE') {
        const { passed, message } = assertFires(result.violationsByLine, annotation);
        expect(passed, message).toBe(true);
      } else {
        const { passed, message } = assertNotFires(result.violationsByLine, annotation);
        expect(passed, message).toBe(true);
      }
    });
  }
});
