/**
 * pdf-lib Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * nark-corpus-pro/packages/pdf-lib/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from nark-corpus-pro/packages/pdf-lib/contract.yaml:
 *   load-rejects-on-encrypted-pdf            (PDFDocument.load)
 *   embedfont-rejects-without-fontkit        (pdfDoc.embedFont)
 *   save-rejects-on-encoding-error           (pdfDoc.save)
 *
 * Key behaviors under test:
 *   - await PDFDocument.load(bytes) without try-catch         → SHOULD_FIRE
 *   - await PDFDocument.load(bytes) inside try-catch          → SHOULD_NOT_FIRE
 *   - PDFDocument.load(bytes).then(...).catch(...)            → SHOULD_NOT_FIRE
 *   - await pdfDoc.embedFont(custom) without try-catch        → SHOULD_FIRE
 *   - await pdfDoc.save() without try-catch                   → SHOULD_FIRE
 *
 * Detection path: pdf-lib imported → PDFDocument.load (static factory) +
 *   pdfDoc.embedFont / pdfDoc.save (typed-parameter instance methods) detected
 *   by ThrowingFunctionDetector → ContractMatcher checks try-catch → postcondition fires.
 *
 * Known instance-tracker limitation: when an instance is the resolved value of
 * `await PDFDocument.load(...)` and then methods are called on it in the same
 * function, the instance type may not always propagate (depends on TS inference).
 * Pipeline test cases at the bottom of the fixture exercise this; some
 * SHOULD_FIRE on chained calls may be soft-passed if the harness reports it.
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
  'packages/pdf-lib/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('pdf-lib: ground-truth fixture', () => {
  let result: GroundTruthResult;

  beforeAll(async () => {
    result = await runGroundTruth(GROUND_TRUTH_PATH, CORPUS_PRO_PATH, {
      includeDrafts: true,
      packageName: 'pdf-lib',
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
