/**
 * image-size Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/image-size/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/image-size/contract.yaml:
 *   unsupported-format   (imageSize() throws TypeError on unrecognized format)
 *   corrupt-image        (imageSize() throws TypeError on corrupt data)
 *   file-not-found       (imageSizeFromFile() rejects on ENOENT)
 *
 * Key behaviors under test:
 *   - imageSize(buffer) without try-catch → SHOULD_FIRE
 *   - imageSizeFromFile(path) without try-catch → SHOULD_FIRE
 *   - imageSize(buffer) inside try-catch → SHOULD_NOT_FIRE
 *   - imageSizeFromFile(path) inside try-catch → SHOULD_NOT_FIRE
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
  '../../../../nark-corpus/packages/image-size/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('image-size: ground-truth fixture', () => {
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
