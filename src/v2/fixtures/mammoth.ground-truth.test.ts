/**
 * mammoth Ground-Truth Tests
 *
 * Each SHOULD_FIRE / SHOULD_NOT_FIRE annotation in
 * corpus/packages/mammoth/fixtures/ground-truth.ts becomes one test case.
 *
 * Postcondition IDs from corpus/packages/mammoth/contract.yaml:
 *   file-read-error                     (convertToHtml/extractRawText without try-catch)
 *   converttomarkdown-file-read-error   (convertToMarkdown without try-catch)
 *   embedstylemap-file-read-error       (embedStyleMap without try-catch)
 *
 * Key behaviors under test:
 *   - await mammoth.convertToHtml({path/buffer}) without try-catch → SHOULD_FIRE (file-read-error)
 *   - await mammoth.extractRawText({path/buffer}) without try-catch → SHOULD_FIRE (file-read-error)
 *   - await mammoth.convertToMarkdown({path/buffer}) without try-catch → SHOULD_FIRE (converttomarkdown-file-read-error)
 *   - await mammoth.embedStyleMap({path/buffer}) without try-catch → SHOULD_FIRE (embedstylemap-file-read-error)
 *   - all of the above inside try-catch → SHOULD_NOT_FIRE
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
  '../../../../nark-corpus/packages/mammoth/fixtures/ground-truth.ts'
);

const ANNOTATIONS: Annotation[] = parseAnnotations(GROUND_TRUTH_PATH);

describe('mammoth: ground-truth fixture', () => {
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
