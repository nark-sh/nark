/**
 * jimp Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/jimp/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from nark-corpus-pro/packages/jimp/contract.yaml:
 *   read-rejects-on-io-or-decode-error                  (Jimp.read)
 *   write-rejects-on-fs-or-encode-error                 (image.write)
 *   getbuffer-rejects-on-unsupported-mime               (image.getBuffer)
 *   getbase64-rejects-on-unsupported-mime               (image.getBase64)
 *   frombuffer-rejects-on-unknown-or-unsupported-mime   (Jimp.fromBuffer)
 *
 * Key behaviors under test:
 *   - await Jimp.read(path) without try-catch                     → SHOULD_FIRE
 *   - await Jimp.read(path) inside try-catch                      → SHOULD_NOT_FIRE
 *   - Jimp.read(path).then(...).catch(...)                        → SHOULD_NOT_FIRE
 *   - await image.write(path) without try-catch                   → SHOULD_FIRE
 *   - await image.write(path) inside try-catch                    → SHOULD_NOT_FIRE
 *   - await image.getBuffer(mime) without try-catch               → SHOULD_FIRE
 *   - await image.getBase64(mime) without try-catch               → SHOULD_FIRE
 *   - await Jimp.fromBuffer(buf) without try-catch                → SHOULD_FIRE
 *
 * Detection path: jimp package imported → Jimp.read / Jimp.fromBuffer / instance.write /
 *   instance.getBuffer / instance.getBase64 detected by ThrowingFunctionDetector →
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
  'packages/jimp/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('jimp: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PRO_PATH, {
      includeDrafts: true,
      packageName: 'jimp',
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
